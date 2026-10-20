import type {Pool,PoolClient} from 'pg';
import {CHECKIN_TEMPLATE_ID,buildCheckinMessage} from './checkin-template.js';
import {SubscriptionDeliveryError} from './wechat-subscription.client.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Options={appId:string;userId:string;requestId:string;page?:string;scheduledDate?:string};
type Delivery={send(openid:string,page?:string):Promise<void>};
type DB=Pick<Pool,'query'>;
export type Clock=()=>Date;
type Row={request_id:string;user_id:string;template_id:string;page:string;state:string;upstream_code:number|null;finished_at:Date|null};
function validate(appId:string,userId:string){if(!/^wx[a-f0-9]{16}$/.test(appId)||!UUID.test(userId))throw Error('INVALID_SUBSCRIPTION_TARGET');}
function receipt(row:Row,alreadyProcessed:boolean){return {requestId:row.request_id,userId:row.user_id,templateId:row.template_id,state:row.state,upstreamCode:row.upstream_code,finishedAt:row.finished_at?.toISOString()??null,alreadyProcessed};}
async function user(c:Pool|PoolClient,appId:string,userId:string,lock=false){const row=(await c.query<{id:string;open_id:string}>('SELECT id,open_id FROM game_users WHERE app_id=$1 AND id=$2 AND first_login_completed'+(lock?' FOR UPDATE':''),[appId,userId])).rows[0];if(!row)throw Error('SUBSCRIPTION_USER_NOT_FOUND');return row;}
async function latest(c:Pool|PoolClient,appId:string,userId:string){return (await c.query<{status:string;recorded_at:Date}>('SELECT status,recorded_at FROM game_subscription_reports WHERE app_id=$1 AND user_id=$2 AND template_id=$3 ORDER BY recorded_at DESC,event_id DESC LIMIT 1',[appId,userId,CHECKIN_TEMPLATE_ID])).rows[0];}
async function pending(c:Pool|PoolClient,appId:string,userId:string){return !!(await c.query("SELECT 1 FROM game_subscription_sends WHERE app_id=$1 AND user_id=$2 AND state IN ('sending','unknown') LIMIT 1",[appId,userId])).rowCount;}
export async function scheduleContext(c:DB,clock?:Clock){
 const r=(await c.query<{now:Date;today:string;in_window:boolean}>(`WITH moment AS MATERIALIZED (SELECT COALESCE($1::timestamptz,clock_timestamp()) AS at) SELECT at AS now,(at AT TIME ZONE 'Asia/Shanghai')::date::text AS today,((at AT TIME ZONE 'Asia/Shanghai')::time >=time '09:00' AND (at AT TIME ZONE 'Asia/Shanghai')::time <time '10:00') AS in_window FROM moment`,[clock?clock().toISOString():null])).rows[0]!;
 return {now:r.now,today:r.today,inWindow:r.in_window};
}
// All observation/receipt comparisons remain in PostgreSQL, preserving microseconds.
export async function scheduledTargets(c:DB,appId:string,now:Date,cursor:string|null=null,limit=100,userId:string|null=null){
 if(!/^wx[a-f0-9]{16}$/.test(appId))throw Error('INVALID_SUBSCRIPTION_TARGET');
 return (await c.query<{id:string}>(`WITH moment AS (SELECT ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AS day) SELECT u.id FROM game_users u CROSS JOIN moment m JOIN LATERAL (SELECT status,recorded_at FROM game_subscription_reports r WHERE r.app_id=u.app_id AND r.user_id=u.id AND r.template_id=$2 ORDER BY recorded_at DESC,event_id DESC LIMIT 1) r ON true WHERE u.app_id=$1 AND u.first_login_completed AND r.status='accept' AND ($4::uuid IS NULL OR u.id>$4::uuid) AND ($6::uuid IS NULL OR u.id=$6::uuid) AND NOT (u.last_login_at >= (m.day::timestamp AT TIME ZONE 'Asia/Shanghai') AND u.last_login_at < ((m.day+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) AND NOT EXISTS(SELECT 1 FROM game_daily_logins d WHERE d.app_id=u.app_id AND d.user_id=u.id AND d.activity_date=m.day) AND NOT EXISTS(SELECT 1 FROM game_subscription_sends s WHERE s.app_id=u.app_id AND s.user_id=u.id AND (s.state IN ('sending','unknown') OR s.scheduled_date=m.day OR (s.template_id=$2 AND s.started_at>=r.recorded_at))) ORDER BY u.id LIMIT $5`,[appId,CHECKIN_TEMPLATE_ID,now.toISOString(),cursor,limit,userId])).rows;
}
export async function previewCheckin(pool:Pool,appId:string,userId:string,page='index'){
 validate(appId,userId);const u=await user(pool,appId,userId),payload=buildCheckinMessage(u.open_id,page),report=await latest(pool,appId,userId),blocked=await pending(pool,appId,userId);
 return {userId,templateId:CHECKIN_TEMPLATE_ID,miniprogramState:payload.miniprogram_state,page:payload.page,data:payload.data,latestClientReport:report?{status:report.status,recordedAt:report.recorded_at.toISOString()}:null,pendingSend:blocked,canAttemptSend:report?.status==='accept'&&!blocked,clientReportIsNotVerifiedCredit:true};
}
export async function sendCheckin(pool:Pool,delivery:Delivery,options:Options,clock?:Clock){
 const {appId,userId,requestId,page='index',scheduledDate}=options;validate(appId,userId);
 if(!UUID.test(requestId))throw Error('INVALID_SUBSCRIPTION_REQUEST_ID');
 if(scheduledDate!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate))throw Error('INVALID_SUBSCRIPTION_SCHEDULE_DATE');
 buildCheckinMessage('validation_only',page);
 const c=await pool.connect();let discard=false,openid='';
 try{
  await c.query('BEGIN');const u=await user(c,appId,userId,true);openid=u.open_id;
  const prior=(await c.query<Row>('SELECT request_id,user_id,template_id,page,state,upstream_code,finished_at,scheduled_date::text AS scheduled_date FROM game_subscription_sends WHERE app_id=$1 AND request_id=$2',[appId,requestId])).rows[0] as (Row&{scheduled_date:string|null})|undefined;
  if(prior){if(prior.user_id!==userId||prior.template_id!==CHECKIN_TEMPLATE_ID||prior.page!==page||prior.scheduled_date!==(scheduledDate??null))throw Error('SUBSCRIPTION_REQUEST_CONFLICT');await c.query('COMMIT');return receipt(prior,true);}
  if(scheduledDate!==undefined){
   const context=await scheduleContext(c,clock);
   if(context.today!==scheduledDate||!context.inWindow)throw Error('SUBSCRIPTION_SCHEDULE_OUTSIDE_WINDOW');
   if(!(await scheduledTargets(c,appId,context.now,null,1,userId)).length)throw Error('SUBSCRIPTION_SCHEDULE_INELIGIBLE');
  }
  if((await latest(c,appId,userId))?.status!=='accept')throw Error('SUBSCRIPTION_NOT_ACCEPTED');
  if(await pending(c,appId,userId))throw Error('SUBSCRIPTION_SEND_PENDING');
  await c.query("INSERT INTO game_subscription_sends(app_id,request_id,user_id,template_id,page,state,scheduled_date,started_at) VALUES($1,$2,$3,$4,$5,'sending',$6,COALESCE($7::timestamptz,clock_timestamp()))",[appId,requestId,userId,CHECKIN_TEMPLATE_ID,page,scheduledDate??null,scheduledDate&&clock?clock().toISOString():null]);
  // A lost reservation COMMIT acknowledgement must never cause an outbound send.
  await c.query('COMMIT');
 }catch(error){try{await c.query('ROLLBACK');}catch{discard=true;}throw error;}finally{c.release(discard);}
 let state:'sent'|'failed'|'unknown'='sent',code:number|null=0;
 try{await delivery.send(openid,page);}catch(error){if(error instanceof SubscriptionDeliveryError){state=error.outcome==='unknown'?'unknown':'failed';code=error.code;}else{state='unknown';code=null;}}
 const row=(await pool.query<Row>("UPDATE game_subscription_sends SET state=$3,upstream_code=$4,finished_at=clock_timestamp() WHERE app_id=$1 AND request_id=$2 AND state='sending' RETURNING request_id,user_id,template_id,page,state,upstream_code,finished_at",[appId,requestId,state,code])).rows[0];
 if(!row)throw Error('SUBSCRIPTION_SEND_STATUS_UNCERTAIN');return receipt(row,false);
}
