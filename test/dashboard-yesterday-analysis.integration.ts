import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import request from 'supertest';
import {migrate} from '../src/database/migrate.js';

// Disposable integration PostgreSQL ONLY (compose.test.yaml, project minigame-login-test).
// The password below is the documented fake value of that throwaway container; no deployed
// credential is read or used. Hard guard runs before any write.
const TEST_URL='postgresql://minigame_test:'+'local_integration_only'+'@127.0.0.1:15439/minigame_test';

function guardedUrl(){
 const parsed=new URL(TEST_URL);
 assert.equal(parsed.hostname,'127.0.0.1','integration tests must never target a remote database');
 assert.equal(parsed.port,'15439','integration tests must use disposable test PostgreSQL');
 assert.equal(parsed.pathname,'/minigame_test');
 return TEST_URL;
}

// Test-only pool wrapper: freezes the ONE materialized DB clock so cohort boundaries can be
// exercised at microsecond precision. Production code has no clock override.
function frozenPool(pool:Pool,at:string){
 const calls:string[]=[];
 const wrapper={
  async query(text:string,values?:unknown[]){
   const hits=text.match(/clock_timestamp\(\)\s+AS\s+at/g)??[];
   assert.equal(hits.length,1,'yesterdayAnalysis must capture exactly one SQL moment');
   assert.equal((text.match(/clock_timestamp\(\)/g)??[]).length,1,'yesterdayAnalysis must not capture a second clock');
   calls.push(text);
   return pool.query(text.replace(hits[0],`'${at}'::timestamptz AS at`),values as any[]);
  },
 };
 return {pool:wrapper,calls};
}

const T=(value:string)=>`'${value}'::timestamptz`;
const MINUS=" - interval '1 microsecond'",PLUS=" + interval '1 microsecond'";

const COHORT='2026-10-19',TODAY='2026-10-20',MOMENT='2026-10-20T15:30:00.123456+08:00',
 COHORT_START='2026-10-19T00:00:00+08:00',COHORT_END='2026-10-20T00:00:00+08:00';

test('yesterday-user scene analysis is one read-only app-scoped snapshot of yesterday\'s cohort',async t=>{
 const pool=new Pool({connectionString:guardedUrl()});
 await migrate(pool);
 const target=(await pool.query('SELECT current_database() AS db')).rows[0];
 assert.equal(target.db,'minigame_test','refusing to seed anything but the disposable test database');
 const {yesterdayAnalysis}=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 assert.equal(typeof yesterdayAnalysis,'function','dashboard yesterdayAnalysis query must be exported');

 const originalCoverage=(await pool.query('SELECT coverage_start::text AS c FROM game_analytics_metadata WHERE id=true')).rows[0].c as string;
 t.after(async()=>{await pool.query('UPDATE game_analytics_metadata SET coverage_start=$1::date WHERE id=true',[originalCoverage]);});

 const APP='wy'+randomBytes(6).toString('hex');
 const OTHER='wz'+randomBytes(6).toString('hex');
 t.after(async()=>{
  await pool.query('DELETE FROM game_rewarded_video_events WHERE app_id=ANY($1::varchar[])',[[APP,OTHER]]);
  await pool.query('DELETE FROM game_daily_logins WHERE app_id=ANY($1::varchar[])',[[APP,OTHER]]);
  await pool.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])',[[APP,OTHER]]);
 });
 const reset=async(coverage='2026-01-01')=>{
  await pool.query('DELETE FROM game_rewarded_video_events WHERE app_id=ANY($1::varchar[])',[[APP,OTHER]]);
  await pool.query('DELETE FROM game_daily_logins WHERE app_id=ANY($1::varchar[])',[[APP,OTHER]]);
  await pool.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])',[[APP,OTHER]]);
  await pool.query('UPDATE game_analytics_metadata SET coverage_start=$1::date WHERE id=true',[coverage]);
 };
 const user=async(app:string,openId:string,created:string,scene:number|null,completed=true)=>(await pool.query(
  `INSERT INTO game_users(app_id,open_id,created_at,last_login_at,first_login_completed,source_scene,source_scene_reported_at)
   VALUES($1,$2,${created},${created},${completed?'true':'false'},${scene===null?'NULL':scene},${scene===null?'NULL':created})
   RETURNING id`,[app,openId])).rows[0].id as string;
 const login=async(app:string,userId:string,date:string,first:string)=>pool.query(
  `INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,$3::date,${first})`,[app,userId,date]);
 const video=async(app:string,userId:string,at:string)=>pool.query(
  `INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at) VALUES($1,$2,$3,'revive',${at})`,[app,userId,randomUUID()]);

 await t.test('contract, DB clock and empty app',async()=>{
  await reset();
  const {pool:frozen,calls}=frozenPool(pool,MOMENT);
  const result:any=await yesterdayAnalysis(frozen as any,APP);
  assert.deepEqual(Object.keys(result).sort(),['cohortDate','generatedAt','loginCoverage','registrations','returnedUsers','rewardedVideos','timezone','today']);
  assert.equal(result.today,TODAY);
  assert.equal(result.cohortDate,COHORT,'the cohort is yesterday in Beijing time');
  assert.equal(result.timezone,'Asia/Shanghai');
  assert.equal(Date.parse(result.generatedAt),Date.parse(MOMENT),'generatedAt is the same DB clock moment');
  assert.match(result.generatedAt,/\.123456/,'generatedAt keeps database microsecond precision');
  assert.equal(result.loginCoverage,true);
  assert.deepEqual(result.registrations,{total:0,items:[]});
  assert.deepEqual(result.rewardedVideos,{total:0,items:[]});
  assert.deepEqual(result.returnedUsers,{total:0,items:[]});
  assert.equal(calls.length,1,'one read-only statement per request');
  const sql=calls[0]!;
  assert.match(sql,/^\s*WITH moment AS MATERIALIZED/);
  assert.equal(/\b(insert|update|delete|truncate)\b/i.test(sql),false,'query text must stay read-only');
 });

 await t.test('cohort window is [yesterday 00:00, today 00:00) Beijing at microsecond precision',async()=>{
  await reset();
  const start=await user(APP,'start',T(COHORT_START),1001);
  await user(APP,'before',T(COHORT_START)+MINUS,1001);
  await user(APP,'last-us',T(COHORT_END)+MINUS,1002);
  await user(APP,'end',T(COHORT_END),1002);
  await user(APP,'after',T(COHORT_END)+PLUS,1002);
  const nil=await user(APP,'null-scene',T(COHORT_START)+" + interval '5 hours'",null);
  const unknown=await user(APP,'unknown-scene',T(COHORT_START)+" + interval '6 hours'",9999);
  const extra=await user(APP,'extra',T(COHORT_START)+" + interval '7 hours'",1001);
  const lastUs=await pool.query('SELECT id FROM game_users WHERE app_id=$1 AND open_id=$2',[APP,'last-us']).then(r=>r.rows[0].id as string);
  await user(APP,'incomplete',T(COHORT_START)+" + interval '8 hours'",1001,false);
  const otherUser=await user(OTHER,'foreign',T(COHORT_START)+" + interval '9 hours'",1001);

  const {pool:frozen}=frozenPool(pool,MOMENT);
  const result:any=await yesterdayAnalysis(frozen as any,APP);
  assert.equal(result.registrations.total,5,'start edge, last microsecond, null and unknown scenes; incomplete/foreign/out-of-window excluded');
  assert.deepEqual(result.registrations.items,[
   {scene:1001,value:2},{scene:1002,value:1},{scene:9999,value:1},{scene:null,value:1},
  ],'count descending, ties by scene, null scene last and distinct from unknown ids');

  // Rewarded videos: only YESTERDAY saved events of COHORT users, never lifetime or today.
  await video(APP,start,T(COHORT_START));
  await video(APP,start,T(COHORT_START)+MINUS);
  await video(APP,start,T('2026-10-15T12:00:00+08:00'));
  await video(APP,start,T(COHORT_END));
  await video(APP,nil,T(COHORT_START)+" + interval '10 hours'");
  await video(APP,unknown,T(COHORT_START)+" + interval '11 hours'");
  await video(OTHER,otherUser,T(COHORT_START)+" + interval '12 hours'");
  const outsider=await user(APP,'outsider',T('2026-10-18T12:00:00+08:00'),1001);
  await video(APP,outsider,T(COHORT_START)+" + interval '13 hours'");

  const afterVideos:any=await yesterdayAnalysis(frozen as any,APP);
  assert.equal(afterVideos.rewardedVideos.total,3,'start-boundary and yesterday-only cohort events; lifetime/today/foreign/non-cohort excluded');
  assert.deepEqual(afterVideos.rewardedVideos.items,[{scene:1001,value:1},{scene:9999,value:1},{scene:null,value:1}]);
  assert.equal(afterVideos.registrations.total,5,'registration totals keep users with no videos');
  assert.equal(afterVideos.registrations.items.some((x:any)=>x.scene===1002),true,'a registrant with zero videos is still counted');

  // Returned users: today's daily login exists, activity_date scoped, first_login_at <= generatedAt.
  await login(APP,start,TODAY,T('2026-10-20T09:00:00+08:00'));
  await login(APP,extra,TODAY,T('2026-10-20T10:00:00+08:00'));
  await login(APP,nil,TODAY,T(MOMENT));
  await login(APP,unknown,TODAY,T(MOMENT)+PLUS);
  await login(APP,lastUs,'2026-10-19',T('2026-10-19T23:59:59.999999+08:00'));
  await login(OTHER,otherUser,TODAY,T(MOMENT));

  const afterLogins:any=await yesterdayAnalysis(frozen as any,APP);
  assert.equal(afterLogins.returnedUsers.total,3,'only cohort users with a today activity row at or before the snapshot');
  assert.deepEqual(afterLogins.returnedUsers.items,[{scene:1001,value:2},{scene:null,value:1}]);
  assert.equal(afterLogins.returnedUsers.items.reduce((n:number,x:any)=>n+x.value,0),afterLogins.returnedUsers.total);
 });

 await t.test('mutable last_login_at and a future login never fabricate a return',async()=>{
  await reset();
  const silent=await user(APP,'silent',T(COHORT_START)+" + interval '1 hour'",1001);
  const future=await user(APP,'future',T(COHORT_START)+" + interval '2 hours'",1001);
  await pool.query(`UPDATE game_users SET last_login_at=${T(MOMENT)} WHERE id=$1`,[silent]);
  await login(APP,future,TODAY,T(MOMENT)+PLUS);
  const {pool:frozen}=frozenPool(pool,MOMENT);
  const result:any=await yesterdayAnalysis(frozen as any,APP);
  assert.equal(result.registrations.total,2);
  assert.deepEqual(result.rewardedVideos,{total:0,items:[]},'no events means zero, not missing');
  assert.deepEqual(result.returnedUsers,{total:0,items:[]},'last_login_at is not evidence and +1µs is past the snapshot');
 });

 await t.test('unknown login coverage is null, never zero',async()=>{
  await reset(TODAY);
  const u=await user(APP,'covered',T(COHORT_START)+" + interval '1 hour'",1001);
  await login(APP,u,TODAY,T(MOMENT));
  const {pool:frozen}=frozenPool(pool,MOMENT);
  let result:any=await yesterdayAnalysis(frozen as any,APP);
  assert.equal(result.loginCoverage,true,'coverage_start equal to today is covered');
  assert.equal(result.returnedUsers.total,1);

  await pool.query("UPDATE game_analytics_metadata SET coverage_start='2026-10-21'::date WHERE id=true");
  result=await yesterdayAnalysis(frozen as any,APP);
  assert.equal(result.loginCoverage,false);
  assert.deepEqual(result.returnedUsers,{total:null,items:null},'uncovered observation stays unknown');
  assert.equal(result.registrations.total,1,'registration totals do not depend on login coverage');
  assert.deepEqual(result.rewardedVideos,{total:0,items:[]});
 });

 await t.test('ordering stays deterministic for equal counts and many scenes',async()=>{
  await reset();
  for(const scene of [7,3,3,42,null,3,null] as (number|null)[]){
   await user(APP,'s'+randomBytes(4).toString('hex'),T(COHORT_START)+" + interval '3 hours'",scene);
  }
  const {pool:frozen}=frozenPool(pool,MOMENT);
  const result:any=await yesterdayAnalysis(frozen as any,APP);
  assert.deepEqual(result.registrations.items,[{scene:3,value:3},{scene:null,value:2},{scene:7,value:1},{scene:42,value:1}],
   'count descending; equal counts order by scene ascending with the null scene last');
  assert.equal(result.registrations.total,7);
 });

 await t.test('existing read-only dashboard role needs no new grant',async()=>{
  await reset();
  const u=await user(APP,'role-user',T(COHORT_START)+" + interval '1 hour'",1001);
  await video(APP,u,T(COHORT_START)+" + interval '2 hours'");
  await login(APP,u,TODAY,T(MOMENT));
  const role='dashboard_yesterday_'+randomBytes(5).toString('hex');
  await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-yesterday-analysis-only'`);
  let rolePool:Pool|undefined;
  try{
   await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
   await pool.query(`GRANT SELECT ON game_users,game_saves,game_profiles,game_invitations,game_daily_logins,game_analytics_metadata,game_rewarded_video_events TO ${role}`);
   await pool.query(`ALTER ROLE ${role} SET default_transaction_read_only=on`);
   const url=new URL(TEST_URL);url.username=role;url.password='isolated-yesterday-analysis-only';
   rolePool=new Pool({connectionString:url.toString(),max:1});
   assert.equal((await rolePool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
   const {pool:frozen}=frozenPool(rolePool,MOMENT);
   const result:any=await yesterdayAnalysis(frozen as any,APP);
   assert.equal(result.registrations.total,1);
   assert.equal(result.registrations.items[0].scene,1001);
   assert.deepEqual(result.rewardedVideos,{total:1,items:[{scene:1001,value:1}]});
   assert.equal(result.returnedUsers.total,1);
  }finally{
   if(rolePool)await rolePool.end();
   await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE ${role}`);
  }
 });
 t.after(async()=>{await pool.end();});
});

test('yesterday analysis HTTP is authenticated, app-scoped and read-only on real PostgreSQL', async t => {
 const owner=new Pool({connectionString:guardedUrl()});
 await migrate(owner);
 const suffix=randomBytes(5).toString('hex'),appId='wyh_'+suffix,role='wy_http_'+suffix,password='isolated-yesterday-http-only';
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
 await owner.query(`GRANT SELECT ON game_users,game_saves,game_profiles,game_invitations,game_daily_logins,game_analytics_metadata,game_rewarded_video_events TO ${role}`);
 await owner.query(`ALTER ROLE ${role} SET default_transaction_read_only=on`);
 const pool=new Pool({connectionString:`postgresql://${role}:${password}@127.0.0.1:15439/minigame_test`,max:2});
 const redis=createClient({url:'redis://127.0.0.1:16389/12'});redis.on('error',()=>{});
 await redis.connect();
 const queries=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 const {createDashboardServer}=await import(pathToFileURL(resolve('dashboard/backend.js')).href);
 const salt='11223344556677889900112233445566';
 const config={username:'wytest',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),
  appId,origin:'https://dashboard.example.com',basePath:'/h5dashboard/',environment:'production'};
 const server=createDashboardServer({pool,redis,config,queries});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{
  await new Promise<void>(r=>server.close(r));
  await redis.quit();await pool.end();
  await owner.query('DELETE FROM game_users WHERE app_id=$1',[appId]);
  await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);
  await owner.end();
 });
 const clock=(await owner.query(`SELECT (m.at AT TIME ZONE 'Asia/Shanghai')::date::text AS today,
     (m.at AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS midnight
   FROM (SELECT clock_timestamp() AS at) m`)).rows[0];
 const today=clock.today as string,midnight=new Date(clock.midnight).getTime();
 const Y=(offset:number,hours:number)=>new Date(midnight+offset*86400000+hours*3600000);
 const ids=[randomUUID(),randomUUID(),randomUUID()];
 await owner.query(`INSERT INTO game_users(id,app_id,open_id,created_at,last_login_at,first_login_completed,source_scene,source_scene_reported_at)
   VALUES($1,$4,'wyh_a',$2,$2,true,1001,$2),($3,$4,'wyh_b',$5,$5,true,NULL,NULL),($6,$4,'wyh_c',$7,$7,true,1001,$7)`,
  [ids[0],Y(-1,1),ids[1],appId,Y(-1,2),ids[2],Y(0,0)]);
 await owner.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at)
   SELECT $1,u,gen_random_uuid(),'revive',x.at FROM unnest($2::uuid[],$3::timestamptz[]) AS x(u,at)`,
  [appId,[ids[0],ids[0],ids[1],ids[0],ids[2]],
   [Y(-1,3),Y(-1,4),Y(-1,5),Y(0,1),Y(0,2)]]);
 await owner.query(`INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at)
   SELECT $1,u,(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date,clock_timestamp() FROM unnest($2::uuid[]) AS u`,
  [appId,[ids[0],ids[1]]]);

 assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
 await assert.rejects(()=>pool.query("UPDATE game_users SET open_id='nope' WHERE id=$1",[ids[0]]));
 await assert.rejects(()=>pool.query("INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) VALUES($1,$2,gen_random_uuid(),'x')",[appId,ids[0]]));

 const api=request(server),url='/h5dashboard/api/yesterday-analysis';
 await api.post(url).set('Origin',config.origin).send({}).expect(401);
 const login=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:config.username,password}).expect(200);
 const cookie=String((login.headers['set-cookie'] as unknown as string[])[0]).split(';')[0]!;
 await api.post(url).set('Cookie',cookie).send({}).expect(403);
 await api.get(url).set('Cookie',cookie).expect(404);
 await api.post(url).set('Origin',config.origin).set('Cookie',cookie).send({appId:'wx9999999999999999'}).expect(400);
 await api.post(url+'?appId=wx9999999999999999').set('Origin',config.origin).set('Cookie',cookie).send({}).expect(404);

 const response=await api.post(url).set('Origin',config.origin).set('Cookie',cookie).send({}).expect(200);
 assert.equal(response.headers['cache-control'],'no-store');
 const body=response.body;
 assert.equal(body.today,today);
 assert.equal(body.timezone,'Asia/Shanghai');
 assert.equal(body.loginCoverage,true,'the test database already tracks today');
 assert.deepEqual(body.registrations,{total:2,items:[{scene:1001,value:1},{scene:null,value:1}]},
  'the today-registered and foreign users are excluded; null scene stays its own group');
 assert.deepEqual(body.rewardedVideos,{total:3,items:[{scene:1001,value:2},{scene:null,value:1}]},
  'lifetime and today events are excluded, only yesterday cohort events count');
 assert.deepEqual(body.returnedUsers,{total:2,items:[{scene:1001,value:1},{scene:null,value:1}]},
  'both cohort users have a today login row');
});
