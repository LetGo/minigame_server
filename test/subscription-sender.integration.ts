import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../src/database/migrate.js';
const templateId='2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4';
test('manual check-in sender reserves once, requires client accept and never retries uncertain delivery',async t=>{
 let api:any;try{api=await import('../src/subscriptions/checkin-sender.js');}catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw error;}
 assert.equal(typeof api?.sendCheckin,'function','manual send service must be implemented');
 const pool=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'}),appId='wx'+randomBytes(8).toString('hex');
 t.after(async()=>{await pool.query('DELETE FROM game_users WHERE app_id=$1',[appId]);await pool.end();});await migrate(pool);
 const uid=(await pool.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'manual_subscribe_fixture') RETURNING id",[appId])).rows[0].id;
 const accept=()=>pool.query('INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status) VALUES($1,$2,$3,$4,$5)',[appId,uid,randomUUID(),templateId,'accept']);
 let calls=0;const client={async send(openid:string,page:string){assert.equal(openid,'manual_subscribe_fixture');assert.equal(page,'index');calls++;await new Promise(r=>setTimeout(r,30));}};
 const preview=await api.previewCheckin(pool,appId,uid);assert.equal(preview.canAttemptSend,false);assert.equal(calls,0);
 await assert.rejects(()=>api.sendCheckin(pool,client,{appId,userId:uid,requestId:randomUUID()}),/SUBSCRIPTION_NOT_ACCEPTED/);assert.equal(calls,0);
 await accept();assert.equal((await api.previewCheckin(pool,appId,uid)).canAttemptSend,true);
 const requestId=randomUUID(),args={appId,userId:uid,requestId};
 const first=await api.sendCheckin(pool,client,args);assert.equal(first.state,'sent');assert.equal(first.alreadyProcessed,false);assert.equal(calls,1);
 const retry=await api.sendCheckin(pool,client,args);assert.equal(retry.state,'sent');assert.equal(retry.alreadyProcessed,true);assert.equal(calls,1);
 await t.test('concurrent same request IDs issue only one external send',async()=>{
  const before=calls,requestId=randomUUID();
  const results=await Promise.all(Array.from({length:8},()=>api.sendCheckin(pool,client,{appId,userId:uid,requestId})));
  assert.equal(results.filter((r:any)=>!r.alreadyProcessed).length,1);assert.equal(calls,before+1);
 });
 await t.test('distinct concurrent requests cannot send to one user in parallel',async()=>{
  const before=calls,results=await Promise.allSettled([1,2].map(()=>api.sendCheckin(pool,client,{appId,userId:uid,requestId:randomUUID()})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,before+1);
 });
 await t.test('unknown network result blocks retries with either same or different request ID',async()=>{
  const requestId=randomUUID(),before=calls,unknown={async send(){calls++;throw new Error('network error with secret URL must not escape');}};
  const result=await api.sendCheckin(pool,unknown,{appId,userId:uid,requestId});assert.equal(result.state,'unknown');assert.equal(result.upstreamCode,null);assert.doesNotMatch(JSON.stringify(result),/secret|network|openid/);
  const retry=await api.sendCheckin(pool,unknown,{appId,userId:uid,requestId});assert.equal(retry.state,'unknown');assert.equal(retry.alreadyProcessed,true);
  await assert.rejects(()=>api.sendCheckin(pool,unknown,{appId,userId:uid,requestId:randomUUID()}),/SUBSCRIPTION_SEND_PENDING/);assert.equal(calls,before+1);
  assert.equal((await api.previewCheckin(pool,appId,uid)).canAttemptSend,false);
 });
 await t.test('definitive WeChat rejection and pre-send failures are safely recorded without retry',async()=>{
  const {SubscriptionDeliveryError}=await import('../src/subscriptions/wechat-subscription.client.js');
  const e=new SubscriptionDeliveryError('rejected',43101);assert(e instanceof Error);assert(e instanceof SubscriptionDeliveryError);
  for(const [outcome,code] of [['rejected',43101],['not_sent',null]] as const){const id=(await pool.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',[appId,'definitive_'+randomUUID()])).rows[0].id;await pool.query('INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status) VALUES($1,$2,$3,$4,$5)',[appId,id,randomUUID(),templateId,'accept']);const req=randomUUID();let n=0;const fake={async send(){n++;throw new SubscriptionDeliveryError(outcome,code);}};
   const r=await api.sendCheckin(pool,fake,{appId,userId:id,requestId:req});assert.equal(r.state,'failed');assert.equal(r.upstreamCode,code);await api.sendCheckin(pool,fake,{appId,userId:id,requestId:req});assert.equal(n,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_subscription_sends WHERE user_id=$1 AND state=\'failed\'',[id])).rows[0].n,1);
  }
 });
 await t.test('lost reservation COMMIT acknowledgement never invokes delivery and leaves a blocking receipt',async()=>{
  const id=(await pool.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',[appId,'commit_loss_'+randomUUID()])).rows[0].id;await pool.query('INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status) VALUES($1,$2,$3,$4,$5)',[appId,id,randomUUID(),templateId,'accept']);let n=0;
  const wrapped={query:pool.query.bind(pool),async connect(){const c=await pool.connect();return {async query(sql:string,params?:any[]){const result=await c.query(sql,params);if(sql==='COMMIT')throw Error('ack lost');return result;},release(discard:boolean){c.release(discard);}};}};
  const req=randomUUID(),fake={async send(){n++;}};await assert.rejects(()=>api.sendCheckin(wrapped,fake,{appId,userId:id,requestId:req}),/ack lost/);assert.equal(n,0);const retry=await api.sendCheckin(pool,fake,{appId,userId:id,requestId:req});assert.equal(retry.state,'sending');assert.equal(retry.alreadyProcessed,true);assert.equal(n,0);await assert.rejects(()=>api.sendCheckin(pool,fake,{appId,userId:id,requestId:randomUUID()}),/SUBSCRIPTION_SEND_PENDING/);
 });
 await t.test('lost final write acknowledgement after delivery cannot cause a second upstream send',async()=>{
  const id=(await pool.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',[appId,'final_ack_'+randomUUID()])).rows[0].id;await pool.query('INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status) VALUES($1,$2,$3,$4,$5)',[appId,id,randomUUID(),templateId,'accept']);let n=0;
  const wrapped={connect:pool.connect.bind(pool),async query(sql:string,params?:any[]){const result=await pool.query(sql,params);if(sql.startsWith('UPDATE game_subscription_sends'))throw Error('final ack lost');return result;}};
  const req=randomUUID(),fake={async send(){n++;}};await assert.rejects(()=>api.sendCheckin(wrapped,fake,{appId,userId:id,requestId:req}),/final ack lost/);assert.equal(n,1);const retry=await api.sendCheckin(pool,fake,{appId,userId:id,requestId:req});assert.equal(retry.state,'sent');assert.equal(retry.alreadyProcessed,true);assert.equal(n,1);
 });
 await t.test('unknown accounts, forged identifiers and foreign games fail before upstream calls',async()=>{
  const before=calls;
  for(const args of [{appId,userId:randomUUID(),requestId:randomUUID()},{appId:'wx0000000000000000',userId:uid,requestId:randomUUID()},{appId,userId:'bad',requestId:randomUUID()},{appId,userId:uid,requestId:'bad'}])await assert.rejects(()=>api.sendCheckin(pool,client,args));
  assert.equal(calls,before);
 });
});
