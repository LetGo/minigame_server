import assert from 'node:assert/strict';import {test} from 'node:test';import {randomBytes,randomUUID} from 'node:crypto';import {Pool} from 'pg';import {migrate} from '../src/database/migrate.js';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const source=(name:string)=>process.env.MINIGAME_TEST_DIST_DIR?pathToFileURL(resolve(process.env.MINIGAME_TEST_DIST_DIR,'subscriptions/'+name+'.js')).href:'../src/subscriptions/'+name+'.js';
const {previewDailyCheckin,runDailyCheckin}=await import(source('daily-checkin'));const {sendCheckin}=await import(source('checkin-sender'));const {SubscriptionDeliveryError}=await import(source('wechat-subscription.client'));
const template='2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4',clock=()=>new Date('2026-01-20T01:30:00Z');
async function fixture(t:any){const pool=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test',max:8}),appId='wx'+randomBytes(8).toString('hex');await migrate(pool);t.after(async()=>{await pool.query('DELETE FROM game_users WHERE app_id=$1',[appId]);await pool.end();});const report=(id:string,status='accept',at='2026-01-19T00:00:00Z')=>pool.query('INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status,recorded_at) VALUES($1,$2,$3,$4,$5,$6)',[appId,id,randomUUID(),template,status,at]);const user=async()=>{const id=(await pool.query("INSERT INTO game_users(app_id,open_id,last_login_at) VALUES($1,$2,'2026-01-19T15:59:59.999999Z') RETURNING id",[appId,'daily_edges_'+randomUUID()])).rows[0].id;await report(id);return id;};return {pool,appId,user,report};}
test('latest rejection, manual-consumed consent and unknown attempts are excluded; fresh accept restores next-day eligibility',async t=>{
 const {pool,appId,user,report}=await fixture(t);const rejected=await user(),used=await user(),pending=await user();await report(rejected,'reject','2026-01-19T00:00:01Z');
 await sendCheckin(pool,{async send(){}},{appId,userId:used,requestId:randomUUID()});
 await sendCheckin(pool,{async send(){throw Error('uncertain');}},{appId,userId:pending,requestId:randomUUID()});
 assert.equal((await previewDailyCheckin(pool,{appId},clock)).eligibleCount,0);
 // Preserve PostgreSQL sub-millisecond precision when deciding a newer observation.
 await pool.query("INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status,recorded_at) SELECT $1::varchar(32),$2::uuid,$3::uuid,$4::varchar(128),'accept',max(started_at)+interval '1 microsecond' FROM game_subscription_sends WHERE app_id=$1 AND user_id=$2",[appId,used,randomUUID(),template]);
 assert.equal((await previewDailyCheckin(pool,{appId},clock)).eligibleCount,1);
 assert.equal((await previewDailyCheckin(pool,{appId:'wx0000000000000000'},clock)).eligibleCount,0);
 const r=await runDailyCheckin(pool,{async send(){}},{appId,delayMs:0},clock);assert.equal(r.sent,1);
});
test('only one concurrent worker holds the app lock and reserves any delivery',async t=>{
 const {pool,appId,user}=await fixture(t);await user();let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);let calls=0;
 const first=runDailyCheckin(pool,{async send(){calls++;enter();await held;}},{appId,delayMs:0},clock);await entered;
 const second=await runDailyCheckin(pool,{async send(){calls++;}},{appId,delayMs:0},clock);assert.equal(second.lockBusy,true);assert.equal(calls,1);release();assert.equal((await first).sent,1);
});
test('unknown delivery or global token/template errors halt the batch; no-consent43101 continues',async t=>{
 for(const [outcome,code,expected] of [['unknown',null,1],['not_sent',null,1],['rejected',40037,1],['rejected',43101,3]] as const){
  const {pool,appId,user}=await fixture(t);await user();await user();await user();let calls=0;
  const result=await runDailyCheckin(pool,{async send(){calls++;throw new SubscriptionDeliveryError(outcome,code);}},{appId,delayMs:0},clock);
  assert.equal(calls,expected);assert.equal(result.stopped,code!==43101);assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_subscription_sends WHERE app_id=$1',[appId])).rows[0].n,expected);
 }
});
test('user lock recheck skips a login committed after candidate selection but before reservation',async t=>{
 const {pool,appId,user}=await fixture(t),uid=await user(),blocker=await pool.connect();let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);
 await blocker.query('BEGIN');await blocker.query("UPDATE game_users SET last_login_at='2026-01-20T00:00:00Z' WHERE id=$1",[uid]);
 const wrapped={query:pool.query.bind(pool),async connect(){const c=await pool.connect();return {query(sql:string,params?:any[]){if(sql.includes('FOR UPDATE'))entered();return c.query(sql,params);},release(discard?:boolean){c.release(discard);}};}} as unknown as Pool;
 let calls=0;try{const batch=runDailyCheckin(wrapped,{async send(){calls++;}},{appId,delayMs:0},clock);await waiting;await blocker.query('COMMIT');const r=await batch;assert.equal(r.sent,0);assert.equal(r.skipped,1);assert.equal(calls,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_subscription_sends WHERE user_id=$1',[uid])).rows[0].n,0);}finally{await blocker.query('ROLLBACK');blocker.release();}
});
test('window closes before a later reservation and day mismatch never sends',async t=>{
 const {pool,appId,user}=await fixture(t),uid=await user();let n=0,calls=0;
 const moving=()=>new Date(++n<=2?'2026-01-20T01:59:59.999Z':'2026-01-20T02:00:00Z');
 const r=await runDailyCheckin(pool,{async send(){calls++;}},{appId,delayMs:0},moving);assert.equal(r.outsideWindow,true);assert.equal(calls,0);
 await assert.rejects(()=>sendCheckin(pool,{async send(){calls++;}},{appId,userId:uid,requestId:randomUUID(),scheduledDate:'2026-01-19'},clock),/OUTSIDE_WINDOW/);assert.equal(calls,0);
});
test('lost scheduled reservation commit or final receipt acknowledgement stops batch and never re-sends',async t=>{
 for(const fault of ['reservation','receipt']){
  const {pool,appId,user}=await fixture(t),uid=await user();let calls=0;
  const wrapped={async query(sql:string,params?:any[]){const value=await pool.query(sql,params);if(fault==='receipt'&&sql.startsWith('UPDATE game_subscription_sends'))throw Error('lost acknowledgement');return value;},async connect(){const c=await pool.connect();return {async query(sql:string,params?:any[]){const value=await c.query(sql,params);if(fault==='reservation'&&sql==='COMMIT')throw Error('lost acknowledgement');return value;},release(discard?:boolean){c.release(discard);}};}} as unknown as Pool;
  const result=await runDailyCheckin(wrapped,{async send(){calls++;}},{appId,delayMs:0},clock);assert.equal(result.stopped,true);assert.equal(calls,fault==='reservation'?0:1);
  const row=(await pool.query('SELECT state FROM game_subscription_sends WHERE user_id=$1',[uid])).rows[0];assert.equal(row.state,fault==='reservation'?'sending':'sent');
  assert.equal((await runDailyCheckin(pool,{async send(){calls++;}},{appId,delayMs:0},clock)).sent,0);assert.equal(calls,fault==='reservation'?0:1);
 }
});
