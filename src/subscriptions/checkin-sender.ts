import type {Pool,PoolClient} from 'pg';
import {CHECKIN_TEMPLATE_ID,buildCheckinMessage} from './checkin-template.js';
import {SubscriptionDeliveryError} from './wechat-subscription.client.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Options={appId:string;userId:string;requestId:string;page?:string};
type Delivery={send(openid:string,page?:string):Promise<void>};
type Row={request_id:string;user_id:string;template_id:string;page:string;state:string;upstream_code:number|null;finished_at:Date|null};
function validate(appId:string,userId:string){if(!/^wx[a-f0-9]{16}$/.test(appId)||!UUID.test(userId))throw Error('INVALID_SUBSCRIPTION_TARGET');}
function receipt(row:Row,alreadyProcessed:boolean){return {requestId:row.request_id,userId:row.user_id,templateId:row.template_id,state:row.state,upstreamCode:row.upstream_code,finishedAt:row.finished_at?.toISOString()??null,alreadyProcessed};}
async function user(c:Pool|PoolClient,appId:string,userId:string,lock=false){
 const row=(await c.query<{id:string;open_id:string}>('SELECT id,open_id FROM game_users WHERE app_id=$1 AND id=$2 AND first_login_completed'+(lock?' FOR UPDATE':''),[appId,userId])).rows[0];
 if(!row)throw Error('SUBSCRIPTION_USER_NOT_FOUND');return row;
}
async function latest(c:Pool|PoolClient,appId:string,userId:string){return (await c.query<{status:string;recorded_at:Date}>('SELECT status,recorded_at FROM game_subscription_reports WHERE app_id=$1 AND user_id=$2 AND template_id=$3 ORDER BY recorded_at DESC,event_id DESC LIMIT 1',[appId,userId,CHECKIN_TEMPLATE_ID])).rows[0];}
async function pending(c:Pool|PoolClient,appId:string,userId:string){return !!(await c.query("SELECT 1 FROM game_subscription_sends WHERE app_id=$1 AND user_id=$2 AND state IN ('sending','unknown') LIMIT 1",[appId,userId])).rowCount;}
export async function previewCheckin(pool:Pool,appId:string,userId:string,page='index'){
 validate(appId,userId);const u=await user(pool,appId,userId),payload=buildCheckinMessage(u.open_id,page),report=await latest(pool,appId,userId),blocked=await pending(pool,appId,userId);
 return {userId,templateId:CHECKIN_TEMPLATE_ID,miniprogramState:payload.miniprogram_state,page:payload.page,data:payload.data,latestClientReport:report?{status:report.status,recordedAt:report.recorded_at.toISOString()}:null,pendingSend:blocked,canAttemptSend:report?.status==='accept'&&!blocked,clientReportIsNotVerifiedCredit:true};
}
export async function sendCheckin(pool:Pool,delivery:Delivery,options:Options){
 const {appId,userId,requestId,page='index'}=options;validate(appId,userId);
 if(!UUID.test(requestId))throw Error('INVALID_SUBSCRIPTION_REQUEST_ID');
 // Validate the page before reserving or invoking any external API.
 buildCheckinMessage('validation_only',page);
 const c=await pool.connect();let discard=false,openid='';
 try{
  await c.query('BEGIN');const u=await user(c,appId,userId,true);openid=u.open_id;
  const prior=(await c.query<Row>('SELECT request_id,user_id,template_id,page,state,upstream_code,finished_at FROM game_subscription_sends WHERE app_id=$1 AND request_id=$2',[appId,requestId])).rows[0];
  if(prior){
   if(prior.user_id!==userId||prior.template_id!==CHECKIN_TEMPLATE_ID||prior.page!==page)throw Error('SUBSCRIPTION_REQUEST_CONFLICT');
   await c.query('COMMIT');return receipt(prior,true);
  }
  if((await latest(c,appId,userId))?.status!=='accept')throw Error('SUBSCRIPTION_NOT_ACCEPTED');
  if(await pending(c,appId,userId))throw Error('SUBSCRIPTION_SEND_PENDING');
  await c.query("INSERT INTO game_subscription_sends(app_id,request_id,user_id,template_id,page,state) VALUES($1,$2,$3,$4,$5,'sending')",[appId,requestId,userId,CHECKIN_TEMPLATE_ID,page]);
  // A lost COMMIT acknowledgement never triggers a send. The durable reservation may remain.
  await c.query('COMMIT');
 }catch(error){try{await c.query('ROLLBACK');}catch{discard=true;}throw error;}finally{c.release(discard);}
 let state:'sent'|'failed'|'unknown'='sent',code:number|null=0;
 try{await delivery.send(openid,page);}catch(error){
  if(error instanceof SubscriptionDeliveryError){state=error.outcome==='unknown'?'unknown':'failed';code=error.code;}else{state='unknown';code=null;}
 }
 // Failure to acknowledge this write leaves sending/unknown fail-closed; never send again automatically.
 const row=(await pool.query<Row>("UPDATE game_subscription_sends SET state=$3,upstream_code=$4,finished_at=clock_timestamp() WHERE app_id=$1 AND request_id=$2 AND state='sending' RETURNING request_id,user_id,template_id,page,state,upstream_code,finished_at",[appId,requestId,state,code])).rows[0];
 if(!row)throw Error('SUBSCRIPTION_SEND_STATUS_UNCERTAIN');return receipt(row,false);
}
