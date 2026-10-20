import assert from 'node:assert/strict';import {test} from 'node:test';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {Pool} from 'pg';import {migrate} from '../src/database/migrate.js';
const url='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
test('dashboard queries use real Beijing-day login records and yesterday registration cohorts',async t=>{
 const pool=new Pool({connectionString:url});t.after(()=>pool.end());await migrate(pool);await pool.query('TRUNCATE game_users CASCADE');
 let api:any;try{api=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);}catch(error){if((error as NodeJS.ErrnoException).code!=='ERR_MODULE_NOT_FOUND')throw error;}
 assert.equal(typeof api?.overview,'function','dashboard metrics query must be implemented');
 const appId='wx1111111111111111';
 await pool.query("UPDATE game_analytics_metadata SET coverage_start=(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date WHERE id=true");
 const users=(await pool.query(`WITH today AS (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date d)
 INSERT INTO game_users(app_id,open_id,created_at,last_login_at)
 SELECT $1,'metric_'||i,(d-CASE WHEN i<=3 THEN 1 ELSE 0 END)::timestamp AT TIME ZONE 'Asia/Shanghai',clock_timestamp() FROM today,generate_series(1,4)i RETURNING id,open_id`,[appId])).rows;
 const returned=users.filter(x=>['metric_1','metric_2','metric_4'].includes(x.open_id));
 await pool.query("INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) SELECT $1,id,(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date,clock_timestamp() FROM unnest($2::uuid[])id",[appId,returned.map(x=>x.id)]);
 const result=await api.overview(pool,appId);assert.equal(result.metrics.dau,3);assert.equal(result.metrics.newUsers,1);assert.equal(result.metrics.totalUsers,4);assert.equal(result.metrics.d1.cohortSize,3);assert.equal(result.metrics.d1.returned,2);assert.equal(result.metrics.d1.rate,2/3);assert.equal(result.timezone,'Asia/Shanghai');assert.equal(result.history.length,14);
 const registrationRow=result.history.find((x:any)=>x.date===result.metrics.d1.cohortDate);
 assert.equal(registrationRow.cohortSize,3,'cohort belongs to this registration date');assert.equal(registrationRow.returned,2,'next-day return belongs on yesterday row');assert.equal(registrationRow.d1Rate,2/3);assert.equal(registrationRow.retentionDate,result.today);assert.equal(registrationRow.d1Pending,false);assert.equal(registrationRow.newUsers,3);assert.equal(registrationRow.dau,null,'registration-day DAU may be unavailable even when next-day retention is covered');
 const todayRow=result.history.find((x:any)=>x.date===result.today);assert.equal(todayRow.cohortSize,1);assert.equal(todayRow.returned,null);assert.equal(todayRow.d1Rate,null);assert.equal(todayRow.d1Pending,true,'today cohort cannot yet have D1 retention');
 const prior=result.history.find((x:any)=>x.date<result.metrics.d1.cohortDate);assert(prior);assert.equal(prior.dau,null);assert.equal(prior.d1Rate,null);
 await t.test('completed historical cohorts use only their next day, including oldest visible row and coverage boundary',async()=>{
  const historicalApp='wx3333333333333333',foreignApp='wx4444444444444444';
  try{
   await pool.query("UPDATE game_analytics_metadata SET coverage_start=(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-12 WHERE id=true");
   const clock=(await pool.query("SELECT d::text AS today,(d-13)::text AS earliest,(d-2)::text AS past FROM (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date d) c")).rows[0];
   await pool.query(`INSERT INTO game_users(app_id,open_id,created_at,last_login_at)
    SELECT CASE WHEN v.name='foreign' THEN $2 ELSE $1 END,v.name,(c.d-v.age)::timestamp AT TIME ZONE 'Asia/Shanghai',clock_timestamp()
    FROM (VALUES ('early_a',13),('early_b',13),('past_a',2),('past_b',2),('foreign',2)) v(name,age)
    CROSS JOIN (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date d) c`,[historicalApp,foreignApp]);
   await pool.query(`INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at)
    SELECT u.app_id,u.id,c.d-CASE u.open_id WHEN 'early_a' THEN 12 WHEN 'early_b' THEN 13 WHEN 'past_b' THEN 0 ELSE 1 END,
     (c.d-CASE u.open_id WHEN 'early_a' THEN 12 WHEN 'early_b' THEN 13 WHEN 'past_b' THEN 0 ELSE 1 END)::timestamp AT TIME ZONE 'Asia/Shanghai'
    FROM game_users u CROSS JOIN (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date d) c WHERE u.app_id=ANY($1::varchar[])`,[[historicalApp,foreignApp]]);
   const h=await api.overview(pool,historicalApp);
   for(const date of [clock.earliest,clock.past]){const row=h.history.find((x:any)=>x.date===date);assert.equal(row.newUsers,2);assert.equal(row.cohortSize,2);assert.equal(row.returned,1,'same-day and day-two logins are not D1; other games excluded');assert.equal(row.d1Rate,.5);assert.equal(row.d1Pending,false);}
   const oldest=h.history.find((x:any)=>x.date===clock.earliest);assert.equal(oldest.dau,null);assert.equal(oldest.retentionDate,h.coverageStart,'next-day data at coverage boundary is usable');
   const current=h.history.find((x:any)=>x.date===h.today);assert.equal(current.d1Pending,true);assert.equal(current.d1Rate,null);assert.equal(current.returned,null);assert.equal(h.metrics.d1.cohortSize,0);assert.equal(h.metrics.d1.rate,null);
  }finally{await pool.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])',[[historicalApp,foreignApp]]);await pool.query('UPDATE game_analytics_metadata SET coverage_start=$1::date WHERE id=true',[result.coverageStart]);}
 });
 await t.test('zero cohorts are undefined retention, not misleading zero percent',async()=>{const empty=await api.overview(pool,'wx2222222222222222');assert.equal(empty.metrics.dau,0);assert.equal(empty.metrics.newUsers,0);assert.equal(empty.metrics.d1.cohortSize,0);assert.equal(empty.metrics.d1.rate,null);});
 await t.test('openid query preserves raw save precision and cross-game isolation',async()=>{
  const user=users[3];const raw='{ "big":9007199254740993123123, "text":"<img onerror=alert(1)>" }\n';await pool.query('INSERT INTO game_saves(user_id,data,version) VALUES($1,$2,7)',[user.id,raw]);
  const record=await api.player(pool,appId,'metric_4');assert.equal(record.user.id,user.id);assert.equal(record.user.openid,'metric_4');assert.equal(record.save.data,raw);assert.equal(record.save.version,7);assert.equal(record.dailyLogins.length,1);assert.equal(record.invitations.summary.total,0);assert.equal(record.inviter,null);
  assert.equal(await api.player(pool,'wx2222222222222222','metric_4'),null);assert.equal(await api.player(pool,appId,"' OR 1=1--"),null);
 });
});
