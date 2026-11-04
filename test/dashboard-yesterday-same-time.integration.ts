import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {migrate} from '../src/database/migrate.js';

// Disposable integration PostgreSQL ONLY. Hard-guarded below before any write.
const TEST_URL='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';

function guardedUrl(url=TEST_URL){
 const parsed=new URL(url);
 assert.equal(parsed.hostname,'127.0.0.1','integration tests must never target a remote database');
 assert.equal(parsed.port,'15439','integration tests must use disposable test PostgreSQL');
 assert.equal(parsed.pathname,'/minigame_test');
 return url;
}

// Trusted test-only pool wrapper: replaces the ONE materialized DB clock expression in the
// production query text with a fixed timestamptz constant, so "yesterday same time" can be
// exercised at exact microsecond boundaries. No runtime override exists in dashboard/queries.mjs.
function frozenPool(pool:Pool,at:string){
 const calls:string[]=[];
 const wrapper={
  async query(text:string,values?:unknown[]){
   const hits=text.match(/clock_timestamp\(\)\s+AS\s+at/g)??[];
   assert.equal(hits.length,1,'overview must capture exactly one SQL moment');
   assert.equal((text.match(/clock_timestamp\(\)/g)??[]).length,1,'overview must not capture a second clock');
   calls.push(text);
   return pool.query(text.replace(hits[0],`'${at}'::timestamptz AS at`),values as any[]);
  },
 };
 return {pool:wrapper,calls};
}

// SQL timestamp literal helper; test-owned constants only, never request data.
const T=(value:string)=>`'${value}'::timestamptz`;
const MINUS=" - interval '1 microsecond'",PLUS=" + interval '1 microsecond'";

const DAY='2026-10-19',MOMENT='2026-10-20T15:30:00.123456+08:00',
 DAY_START='2026-10-19T00:00:00+08:00',CUTOFF='2026-10-19T15:30:00.123456+08:00';

test('overview yesterday-same-time metrics use one snapshot and only completed in-app registrations',async t=>{
 const pool=new Pool({connectionString:guardedUrl()});t.after(()=>pool.end());
 await migrate(pool);
 const target=(await pool.query('SELECT current_database() AS db')).rows[0];
 assert.equal(target.db,'minigame_test','refusing to seed anything but the disposable test database');
 const {overview}=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 const reset=async(coverage:string)=>{await pool.query('TRUNCATE game_users CASCADE');
  await pool.query('UPDATE game_analytics_metadata SET coverage_start=$1::date WHERE id=true',[coverage]);};
 const user=async(appId:string,openId:string,created:string,completed=true)=>(await pool.query(
  `INSERT INTO game_users(app_id,open_id,created_at,last_login_at,first_login_completed)
   VALUES($1,$2,${created},${created},${completed?'true':'false'}) RETURNING id`,[appId,openId])).rows[0].id as string;
 const login=async(appId:string,userId:string,date:string,first:string)=>pool.query(
  `INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,$3::date,${first})`,[appId,userId,date]);
 const invite=async(appId:string,inviter:string,invitee:string,at:string,claimed=false)=>pool.query(
  `INSERT INTO game_invitations(app_id,inviter_user_id,invitee_user_id,invited_at,claim_id,reward_claimed_at)
   VALUES($1,$2,$3,${at},${claimed?'gen_random_uuid()':'NULL'},${claimed?at:'NULL'})`,[appId,inviter,invitee]);
 const video=async(appId:string,userId:string,at:string)=>pool.query(
  `INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at) VALUES($1,$2,$3,'revive',${at})`,[appId,userId,randomUUID()]);

 await t.test('contract and frozen cutoff',async()=>{
  await reset('2026-01-01');const appId='wx1010101010101010';
  const {pool:frozen}=frozenPool(pool,MOMENT);const result:any=await overview(frozen as any,appId);
  assert.ok(result.yesterdaySameTime,'overview must expose a yesterdaySameTime object');
  assert.deepEqual(Object.keys(result.yesterdaySameTime).sort(),['cutoffAt','date','dau','invitedNewUsers','newUsers','todayRewardedVideos']);
  assert.equal(result.yesterdaySameTime.date,'2026-10-19');
  assert.equal(Date.parse(result.yesterdaySameTime.cutoffAt),Date.parse(CUTOFF),'cutoff is the same Beijing wall clock one day earlier');
  assert.match(result.yesterdaySameTime.cutoffAt,/\.123456/,'cutoff keeps database microsecond precision');
  assert.equal(result.yesterdaySameTime.dau,0);
  assert.equal(result.yesterdaySameTime.newUsers,0);
  assert.equal(result.yesterdaySameTime.invitedNewUsers,0);
  assert.equal(result.yesterdaySameTime.todayRewardedVideos,0);
  assert.equal(Date.parse(result.generatedAt),Date.parse(MOMENT),'yesterday metrics reuse the existing generatedAt moment');
  assert.equal(result.today,'2026-10-20');
 });

 await t.test('window is Beijing midnight through cutoff inclusive, at microsecond precision',async()=>{
  await reset('2026-01-01');const app='wx1010101010101010',foreign='wx1111111111111111';
  const inviter=await user(app,'inviter',T('2026-10-10T00:00:00+08:00'));
  const start=await user(app,'start',T(DAY_START));
  const mid=await user(app,'mid',T(CUTOFF)+MINUS);
  const cut=await user(app,'cut',T(CUTOFF));
  const after=await user(app,'after',T(CUTOFF)+PLUS);
  const late=await user(app,'late',T(CUTOFF)+" + interval '1 minute'");
  await user(app,'before',T(DAY_START)+MINUS);
  const incomplete=await user(app,'incomplete',T(DAY_START)+" + interval '1 minute'",false);
  const noDaily=await user(app,'no-daily',T('2026-10-10T00:00:00+08:00'));
  // A mutable last_login_at in the window must never count as DAU without a daily login row.
  await pool.query(`UPDATE game_users SET last_login_at=${T(CUTOFF)} WHERE id=$1`,[noDaily]);
  await pool.query("UPDATE game_users SET last_login_at='2030-01-01T00:00:00+08:00' WHERE id=$1",[start]);
  const foreignInviter=await user(foreign,'foreign-inviter',T('2026-10-10T00:00:00+08:00'));
  const foreignUser=await user(foreign,'foreign-user',T(DAY_START));

  await login(app,start,DAY,T(DAY_START));
  await login(app,mid,DAY,T(CUTOFF)+MINUS);
  await login(app,cut,DAY,T(CUTOFF));
  await login(app,after,DAY,T(CUTOFF)+PLUS);
  await login(app,late,DAY,T(CUTOFF)+" + interval '1 minute'");
  await login(app,await user(app,'previous',T('2026-10-10T00:00:00+08:00')),'2026-10-18',T(DAY_START)+MINUS);
  await login(foreign,foreignUser,DAY,T(CUTOFF));

  await invite(app,inviter,start,T(DAY_START),true);
  await invite(app,inviter,cut,T(CUTOFF),false);
  await invite(app,inviter,mid,T(CUTOFF)+PLUS,false); // delayed attribution after cutoff
  await invite(app,inviter,late,T(DAY_START),false); // registered after cutoff
  await invite(app,inviter,incomplete,T(DAY_START),false); // incomplete registration
  await invite(foreign,foreignInviter,foreignUser,T(CUTOFF));

  await video(app,start,T(DAY_START));
  await video(app,cut,T(CUTOFF));
  await video(app,mid,T(CUTOFF)+PLUS);
  await video(app,start,T(DAY_START)+MINUS);
  await video(app,late,T(CUTOFF)+" + interval '1 hour'");
  await video(foreign,foreignUser,T(CUTOFF));
  await video(app,start,T('2026-10-20T01:00:00+08:00'));

  const {pool:frozen}=frozenPool(pool,MOMENT);const result:any=await overview(frozen as any,app);
  const ys=result.yesterdaySameTime;
  assert.equal(ys.date,DAY);assert.equal(Date.parse(ys.cutoffAt),Date.parse(CUTOFF));
  assert.equal(ys.dau,3,'both cutoff edges count; +1µs, previous-day and today rows do not; mutable last_login_at is ignored');
  assert.equal(ys.newUsers,3,'registrations from midnight through cutoff inclusive only');
  assert.equal(ys.invitedNewUsers,2,'claimed+unclaimed count; bind after cutoff is not retrospective; incomplete/foreign/after-cutoff excluded');
  assert.equal(ys.todayRewardedVideos,2,'yesterday video count through cutoff, not today and not later yesterday');
  assert.equal(result.metrics.todayRewardedVideos,1,'existing today metric is unchanged');
  assert.equal(result.metrics.newUsers,0);assert.equal(result.metrics.dau,0);

  const row=result.history.find((x:any)=>x.date===DAY);assert.ok(row,'history keeps its Beijing-day row');
  assert.equal(row.newUsers,5,'unchanged full-day history includes after-cutoff registrations');
  assert.equal(row.invitedNewUsers,4,'unchanged history attributes the late bind to the registration day');
  assert.equal(row.dau,5,'unchanged history DAU counts every stored login for that activity_date');
  assert.equal(row.rewardedVideos,4,'unchanged history counts every event that Beijing day, excluding today/foreign');
 });

 await t.test('exact Beijing midnight has a zero-length window and includes only that instant',async()=>{
  await reset('2026-01-01');const app='wx2020202020202020';
  const at='2026-10-20T00:00:00+08:00',day='2026-10-19T00:00:00+08:00';
  const exact=await user(app,'exact',T(day));
  await user(app,'before',T(day)+MINUS);
  await user(app,'after',T(day)+PLUS);
  await login(app,exact,'2026-10-19',T(day));
  await invite(app,await user(app,'inviter',T('2026-10-10T00:00:00+08:00')),exact,T(day),true);
  await video(app,exact,T(day));await video(app,exact,T(day)+PLUS);
  const {pool:frozen}=frozenPool(pool,at);const result:any=await overview(frozen as any,app);
  const ys=result.yesterdaySameTime;
  assert.equal(ys.date,'2026-10-19');assert.equal(Date.parse(ys.cutoffAt),Date.parse(day),'midnight cutoff is exactly yesterday 00:00');
  assert.equal(ys.newUsers,1);assert.equal(ys.dau,1);assert.equal(ys.invitedNewUsers,1);assert.equal(ys.todayRewardedVideos,1);
 });

 await t.test('DAU is null when yesterday is not after coverage, otherwise a known count including zero',async()=>{
  await reset('2026-10-19');const app='wx3030303030303030';
  const u=await user(app,'u',T(DAY_START)+" + interval '1 hour'");
  await login(app,u,DAY,T(DAY_START)+" + interval '2 hours'");
  const {pool:frozen}=frozenPool(pool,MOMENT);
  let result:any=await overview(frozen as any,app);
  assert.equal(result.yesterdaySameTime.dau,null,'coverage_start day is backfilled from mutable last_login_at, so same-time DAU is unknown');
  assert.equal(result.yesterdaySameTime.newUsers,1,'registration counts do not depend on login coverage');
  await pool.query("UPDATE game_analytics_metadata SET coverage_start='2026-10-20'::date WHERE id=true");
  result=await overview(frozen as any,app);
  assert.equal(result.yesterdaySameTime.dau,null,'a future/incomplete coverage start is still unknown');
  await pool.query("UPDATE game_analytics_metadata SET coverage_start='2026-10-18'::date WHERE id=true");
  result=await overview(frozen as any,app);
  assert.equal(result.yesterdaySameTime.dau,1,'covered yesterday is measurable');
  await pool.query('DELETE FROM game_daily_logins WHERE app_id=$1',[app]);
  result=await overview(frozen as any,app);
  assert.equal(result.yesterdaySameTime.dau,0,'covered-but-empty is zero, distinct from unknown null');
  const empty:any=await overview(frozen as any,'wx4040404040404040');
  assert.equal(empty.yesterdaySameTime.dau,0);assert.equal(empty.yesterdaySameTime.newUsers,0);
  assert.equal(empty.yesterdaySameTime.invitedNewUsers,0);assert.equal(empty.yesterdaySameTime.todayRewardedVideos,0);
 });

 await t.test('month, year and DST-sensitive boundaries are the same instant in any DB session timezone',async()=>{
  await reset('2025-12-01');const app='wx5050505050505050';
  const monthMoment='2026-03-01T00:30:00+08:00',monthDay='2026-02-28',monthCut='2026-02-28T00:30:00+08:00';
  await user(app,'month-in',T(monthCut)+MINUS);
  await user(app,'month-out',T(monthCut)+PLUS);
  const yearMoment='2027-01-01T00:00:00+08:00',yearDay='2026-12-31',yearCut='2026-12-31T00:00:00+08:00';
  await user(app,'year-before',T(yearCut)+MINUS);
  await user(app,'year-exact',T(yearCut));
  await user(app,'year-after',T(yearCut)+PLUS);
  const dstMoment='2026-03-09T04:00:00+08:00',dstDay='2026-03-08',dstCut='2026-03-08T04:00:00+08:00';
  await user(app,'dst-in',T(dstCut)+MINUS);
  await user(app,'dst-exact',T(dstCut));
  await user(app,'dst-out',T(dstCut)+PLUS);
  const sessions=[['UTC','UTC'],['America/New_York','DST-observing session'],['Asia/Shanghai','Beijing session']] as const;
  for(const [tz,label] of sessions){
   const sessionPool=new Pool({connectionString:guardedUrl(),options:`-c timezone=${tz}`,max:1});
   try{
    const {pool:frozen}=frozenPool(sessionPool,monthMoment);const month:any=await overview(frozen as any,app);
    assert.equal(month.yesterdaySameTime.date,monthDay,label);
    assert.equal(Date.parse(month.yesterdaySameTime.cutoffAt),Date.parse(monthCut),label);
    assert.equal(month.yesterdaySameTime.newUsers,1,label);
    const {pool:yearFrozen}=frozenPool(sessionPool,yearMoment);const year:any=await overview(yearFrozen as any,app);
    assert.equal(year.yesterdaySameTime.date,yearDay,label);assert.equal(Date.parse(year.yesterdaySameTime.cutoffAt),Date.parse(yearCut),label);
    assert.equal(year.yesterdaySameTime.newUsers,1,'only the exact year-boundary midnight instant is inside the zero-length window');
    const {pool:dstFrozen}=frozenPool(sessionPool,dstMoment);const dst:any=await overview(dstFrozen as any,app);
    assert.equal(dst.yesterdaySameTime.date,dstDay,label);assert.equal(Date.parse(dst.yesterdaySameTime.cutoffAt),Date.parse(dstCut),label);
    assert.equal(dst.yesterdaySameTime.newUsers,2,'same Beijing wall clock on the US DST transition day');
   }finally{await sessionPool.end();}
  }
 });

 await t.test('existing read-only dashboard role needs no new grant',async()=>{
  await reset('2026-01-01');const app='wx6060606060606060';
  const u=await user(app,'role-user',T(DAY_START)+" + interval '1 hour'");
  await login(app,u,DAY,T(DAY_START)+" + interval '2 hours'");
  const role='dashboard_yesterday_'+randomBytes(5).toString('hex');
  await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-yesterday-test-only'`);
  let rolePool:Pool|undefined;
  try{
   await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
   await pool.query(`GRANT SELECT ON game_users,game_saves,game_profiles,game_invitations,game_daily_logins,game_analytics_metadata,game_rewarded_video_events TO ${role}`);
   await pool.query(`ALTER ROLE ${role} SET default_transaction_read_only=on`);
   const url=new URL(TEST_URL);url.username=role;url.password='isolated-yesterday-test-only';
   rolePool=new Pool({connectionString:url.toString(),max:1});
   assert.equal((await rolePool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
   await assert.rejects(()=>rolePool!.query("UPDATE game_users SET last_login_at=clock_timestamp() WHERE app_id=$1",[app]));
   const {pool:frozen}=frozenPool(rolePool,MOMENT);const result:any=await overview(frozen as any,app);
   assert.equal(result.yesterdaySameTime.date,DAY);assert.equal(result.yesterdaySameTime.dau,1);assert.equal(result.yesterdaySameTime.newUsers,1);
   assert.equal(result.yesterdaySameTime.invitedNewUsers,0);assert.equal(result.yesterdaySameTime.todayRewardedVideos,0);
  }finally{
   if(rolePool)await rolePool.end();
   await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE ${role}`);
  }
 });
});
