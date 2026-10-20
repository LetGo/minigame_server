import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,scryptSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import request from 'supertest';
import {migrate} from '../src/database/migrate.js';

// Isolated regression for the read-only receipts summary: disposable roles, dummy credentials,
// test-only PostgreSQL 15439 / Redis 16389. No production service, no migration outside this DB.
const OWNER='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
const REDIS='redis://127.0.0.1:16389/15';
const APP='wx9999999999999999',OTHER_APP='wx8888888888888888',EMPTY_APP='wx7777777777777777';
const TEMPLATE='2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4',OTHER_TEMPLATE='other-template-id';
const PASSWORD='isolated-status-test-only';
const DAY_MS=86_400_000,HOUR_MS=3_600_000;
const PROBE_BODY={message:['code must be a string'],error:'Bad Request',statusCode:400};

const beijingDay=(ms:number)=>new Date(ms+8*HOUR_MS).toISOString().slice(0,10);
const localStart=(day:string)=>Date.parse(day+'T00:00:00+08:00');
const at=(base:number,offset:number)=>new Date(base+offset).toISOString();
const uuid=()=>{const hex=randomBytes(16).toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;};

test('production status receipts summarize only this app and template on a readonly grant',async t=>{
 const owner=new Pool({connectionString:OWNER,max:2});await migrate(owner);
 // Defensive fixture hygiene for this disposable database only.
 await owner.query('DELETE FROM game_subscription_sends WHERE app_id=ANY($1::text[])',[[APP,OTHER_APP,EMPTY_APP]]);
 await owner.query("DELETE FROM game_users WHERE app_id=ANY($1::text[]) AND open_id LIKE 'status_%'",[[APP,OTHER_APP,EMPTY_APP]]);
 const stale=await owner.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'status\\_ro\\_%' OR rolname LIKE 'status\\_nogrant\\_%'");
 for(const row of stale.rows){await owner.query(`DROP OWNED BY ${row.rolname}`);await owner.query(`DROP ROLE ${row.rolname}`);}

 const ro='status_ro_'+randomBytes(5).toString('hex'),noGrant='status_nogrant_'+randomBytes(5).toString('hex');
 await owner.query(`CREATE ROLE ${ro} LOGIN PASSWORD '${PASSWORD}'`);
 await owner.query(`CREATE ROLE ${noGrant} LOGIN PASSWORD '${PASSWORD}'`);
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${ro},${noGrant}`);
 await owner.query(`GRANT SELECT ON game_subscription_sends TO ${ro}`);
 await owner.query(`ALTER ROLE ${ro} SET default_transaction_read_only=on`);
 await owner.query(`ALTER ROLE ${noGrant} SET default_transaction_read_only=on`);

 const run=randomBytes(4).toString('hex');
 const users:string[]=[];
 for(const label of ['a','b','c','d']){
  users.push((await owner.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',[APP,`status_${run}_${label}`])).rows[0].id);
 }
 const otherUser=(await owner.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',[OTHER_APP,`status_${run}_other`])).rows[0].id;

 const requestIds:string[]=[];
 const insert=async(app:string,userId:string,template:string,state:string,startedAt:string,finishedAt:string|null,code:number|null,scheduled:string|null)=>{
  const id=uuid();requestIds.push(id);
  await owner.query('INSERT INTO game_subscription_sends(app_id,request_id,user_id,template_id,page,state,upstream_code,started_at,finished_at,scheduled_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [app,id,userId,template,'pages/index/index',state,code,startedAt,finishedAt,scheduled]);
 };

 const day=beijingDay(Date.now()),base=localStart(day);
 // Beijing-day window [00:00, next day 00:00): lower edge included, previous day excluded.
 await insert(APP,users[0]!,TEMPLATE,'sent',at(base,0),at(base,1500),0,day);
 await insert(APP,users[1]!,TEMPLATE,'failed',at(base,12*HOUR_MS),at(base,12*HOUR_MS+900),43004,day);
 await insert(APP,users[2]!,TEMPLATE,'unknown',at(base,13*HOUR_MS),at(base,13*HOUR_MS+700),null,day);
 await insert(APP,users[3]!,TEMPLATE,'sending',at(base,DAY_MS-1000),null,null,day);          // all-time latest, pending
 await insert(APP,users[1]!,TEMPLATE,'sent',at(base,-1000),at(base,-500),0,beijingDay(base-1000)); // previous day excluded
 await insert(APP,users[2]!,OTHER_TEMPLATE,'sent',at(base,10*HOUR_MS),at(base,10*HOUR_MS+500),0,null); // other template excluded
 await insert(OTHER_APP,otherUser,TEMPLATE,'sent',at(base,10*HOUR_MS),at(base,10*HOUR_MS+500),0,day); // other app excluded

 const {createDashboardPool}=await import(pathToFileURL(resolve('dashboard/server.mjs')).href);
 const {createProductionStatus}=await import(pathToFileURL(resolve('dashboard/production-status.mjs')).href);
 const {createDashboardServer}=await import(pathToFileURL(resolve('dashboard/backend.js')).href);
 const queries=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);

 const pool=createDashboardPool(`postgresql://${ro}:${PASSWORD}@127.0.0.1:15439/minigame_test`);
 const locked=createDashboardPool(`postgresql://${noGrant}:${PASSWORD}@127.0.0.1:15439/minigame_test`);
 const redis=createClient({url:REDIS});redis.on('error',()=>{});
 t.after(async()=>{
  const step=async(work:()=>Promise<unknown>)=>{try{await work();}catch{}};
  await step(async()=>{if(redis.isOpen){await redis.flushDb();await redis.quit();}});
  await step(()=>pool.end());await step(()=>locked.end());
  await step(()=>owner.query('DELETE FROM game_subscription_sends WHERE request_id=ANY($1::uuid[])',[requestIds]));
  await step(()=>owner.query("DELETE FROM game_users WHERE app_id=ANY($1::text[]) AND open_id LIKE 'status\\_%'",[[APP,OTHER_APP]]));
  for(const role of [ro,noGrant]){await step(()=>owner.query(`DROP OWNED BY ${role}`));await step(()=>owner.query(`DROP ROLE ${role}`));}
  await step(()=>owner.end());
 });
 await redis.connect();await redis.flushDb();
 assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
 await assert.rejects(()=>pool.query("UPDATE game_subscription_sends SET state='sent' WHERE app_id=$1",[APP]));
 await assert.rejects(()=>pool.query('DELETE FROM game_subscription_sends WHERE app_id=$1',[APP]));

 const root=await mkdtemp(join(tmpdir(),'status-integration-'));
 await mkdir(join(root,'dist/leaderboards'),{recursive:true});
 await writeFile(join(root,'.env'),'SUBSCRIBE_MESSAGES_ENABLED=true\nPRODUCTION_DAILY_CHECKIN_ENABLED=true\nSUBSCRIBE_MINIPROGRAM_STATE=formal\n');
 await writeFile(join(root,'dist/leaderboards/leaderboards.service.js'),'const MINIMUM = { stage: 101, boss: 30 };\n');
 let clock=Date.now();
 const systemctl=async(args:string[])=>{
  if(args[1]==='minigame-login.service')return {exitCode:0,stdout:'ActiveState=active\nSubState=running\n'};
  if(args[1]==='minigame-production-checkin.timer')return {exitCode:0,stdout:'ActiveState=active\nSubState=waiting\nUnitFileState=enabled\nNextElapseUSecRealtime=Wed 2026-10-21 01:00:00 UTC\nLastTriggerUSec=\n'};
  return {exitCode:0,stdout:'ActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nExecMainStartTimestamp=\nExecMainExitTimestamp=\n'};
 };
 const fetchStub=async()=>({status:400,headers:{get:()=>'application/json'},text:async()=>JSON.stringify(PROBE_BODY)});
 const productionStatus=createProductionStatus({root,pool,redis,appId:APP,systemctl,fetch:fetchStub,now:()=>clock});

 const direct=await productionStatus();
 assert.deepEqual(direct.subscriptions.receipts,{available:true,
  today:{total:4,sent:1,failed:1,unknown:1,sending:1},
  last:{state:'sending',startedAt:at(base,DAY_MS-1000),finishedAt:null,scheduledDate:day,upstreamCode:null}},'app/template/day scoping and all-time latest');
 assert.deepEqual(direct.leaderboards,{stageMinimum:101,bossMinimum:30});
 assert.equal(direct.subscriptions.schedule.nextRunAt,'2026-10-21T01:00:00.000Z');
 assert.equal(direct.subscriptions.schedule.lastTriggerAt,null,'never-triggered timer keeps dates unknown');
 assert.equal(direct.subscriptions.schedule.enabled,true);

 // A grant without SELECT on the receipts table must stay isolated unknown, never zero.
 const lockedSnapshot=await createProductionStatus({root,pool:locked,redis,appId:APP,systemctl,fetch:fetchStub,now:()=>clock})();
 assert.equal(lockedSnapshot.subscriptions.receipts.available,false);
 assert.equal(lockedSnapshot.subscriptions.receipts.today,null);
 assert.equal(lockedSnapshot.subscriptions.receipts.last,null);
 assert.equal(lockedSnapshot.database.state,'ok');
 assert.equal(lockedSnapshot.api.state,'ok');

 // Real zeros and a null latest for an app with no receipts at all.
 const empty=await createProductionStatus({root,pool,redis,appId:EMPTY_APP,systemctl,fetch:fetchStub,now:()=>clock})();
 assert.deepEqual(empty.subscriptions.receipts,{available:true,today:{total:0,sent:0,failed:0,unknown:0,sending:0},last:null});

 // Authenticated HTTP surface over the real readonly pool and real Redis.
 const salt='11223344556677889900112233445566';
 const config={username:'statusadmin',passwordHash:salt+':'+scryptSync('explicit-status-password',salt,64).toString('hex'),appId:APP,origin:'https://dashboard.example.com',basePath:'/h5dashboard/',environment:'production'};
 const server=createDashboardServer({pool,redis,config,queries,productionStatus});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise<void>(r=>server.close(r)));
 await request(server).get('/h5dashboard/api/production-status').expect(401);
 const auth=await request(server).post('/h5dashboard/api/login').set('Origin',config.origin).send({username:'statusadmin',password:'explicit-status-password'}).expect(200);
 const cookie=String((auth.headers['set-cookie'] as unknown as string[])[0]).split(';')[0]!;
 const first=await request(server).get('/h5dashboard/api/production-status').set('Cookie',cookie).expect(200);
 assert.deepEqual(first.body.subscriptions.receipts,direct.subscriptions.receipts);
 assert.equal(first.headers['cache-control'],'no-store');

 await insert(APP,users[0]!,TEMPLATE,'sent',at(base,20*HOUR_MS),at(base,20*HOUR_MS+400),0,null);
 const cached=await request(server).get('/h5dashboard/api/production-status').set('Cookie',cookie).expect(200);
 assert.equal(cached.body.checkedAt,first.body.checkedAt,'ten-second cache keeps the snapshot stable');
 assert.equal(cached.body.subscriptions.receipts.today.total,4);

 // Next-day 00:00 is outside [00:00, next day 00:00) for today's counts.
 await insert(APP,users[2]!,TEMPLATE,'failed',at(base,DAY_MS),at(base,DAY_MS+100),43004,beijingDay(base+DAY_MS));
 clock+=10000;
 const refreshed=await request(server).get('/h5dashboard/api/production-status').set('Cookie',cookie).expect(200);
 assert.notEqual(refreshed.body.checkedAt,first.body.checkedAt);
 assert.deepEqual(refreshed.body.subscriptions.receipts.today,{total:5,sent:2,failed:1,unknown:1,sending:1},'the next local midnight is excluded from today');
 assert.equal(refreshed.body.subscriptions.receipts.last.state,'failed','the all-time latest row is still reported for reference');
 assert.deepEqual(refreshed.body.leaderboards,{stageMinimum:101,bossMinimum:30});

 const payload=JSON.stringify(refreshed.body);
 for(const secret of [PASSWORD,APP,TEMPLATE,OTHER_TEMPLATE,'minigame_test'])assert(!payload.includes(secret),`must not leak ${secret}`);
 assert(!payload.includes('ActiveState')&&!payload.includes('code must be'));
});
