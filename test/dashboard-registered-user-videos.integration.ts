import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {migrate} from '../src/database/migrate.js';

test('overview registration-user videos count only completed same-app users on their registration Beijing day',async t=>{
 const pool=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});
 const app='wx'+randomBytes(8).toString('hex'),foreign='wx'+randomBytes(8).toString('hex');
 t.after(async()=>{try{await pool.query('DELETE FROM game_users WHERE app_id=ANY($1::text[])',[[app,foreign]]);}finally{await pool.end();}});
 await migrate(pool);const {overview}=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 const empty=await overview(pool,app);assert(empty.history.every((r:any)=>r.registeredUserVideos===0),'empty cohort must have a real zero video total');
 const dates=(await pool.query("SELECT d::text AS today,(d-2)::text AS past,(d-13)::text AS oldest FROM (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date d) c")).rows[0];
 async function user(name:string,day:string,delta:string='0 seconds',complete=true,game=app){
  return (await pool.query(`INSERT INTO game_users(app_id,open_id,created_at,first_login_completed) VALUES($1,$2,($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')+$4::interval,$5) RETURNING id`,[game,name,day,delta,complete])).rows[0].id;
 }
 async function video(id:string,day:string,delta:string='0 seconds',game=app,event=randomUUID()){
  await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at) VALUES($1,$2,$3,'cohort-test',($4::date::timestamp AT TIME ZONE 'Asia/Shanghai')+$5::interval) ON CONFLICT DO NOTHING`,[game,id,event,day,delta]);return event;
 }
 const a=await user('past_start',dates.past),zero=await user('past_nonviewer',dates.past,'1 second');
 const end=await user('past_end',dates.past,'1 day -1 microsecond'),before=await user('before',dates.past,'-1 microsecond');
 const unfinished=await user('unfinished',dates.past,'0 seconds',false),other=await user('foreign',dates.past,'0 seconds',true,foreign);
 const earliest=await user('earliest',dates.oldest),today=await user('today',dates.today),older=await user('older',dates.oldest,'-1 microsecond');
 assert(zero);
 const event=await video(a,dates.past);await video(a,dates.past,'0 seconds',app,event); // retry is still one event
 await video(a,dates.past,'1 second');await video(a,dates.past,'1 day -1 microsecond');
 await video(a,dates.past,'1 day'); // next day does not belong to the registration-day metric
 await video(end,dates.past,'1 day -1 microsecond');
 await video(before,dates.past); // existing user, not new on this day
 await video(unfinished,dates.past);await video(other,dates.past,'0 seconds',foreign);
 await video(earliest,dates.oldest);await video(older,dates.oldest);await video(today,dates.today);
 await video(today,dates.today,'1 day'); // next day is not today's registration-day video
 const result=await overview(pool,app);assert.equal(result.history.length,14);
 const past=result.history.find((r:any)=>r.date===dates.past),first=result.history.find((r:any)=>r.date===dates.oldest),current=result.history.find((r:any)=>r.date===dates.today);
 assert.equal(past.newUsers,3,'zero-event completed registration stays in denominator');assert.equal(past.registeredUserVideos,4,'start inclusive/end exclusive; exclude old, incomplete, foreign and next-day events');
 assert.equal(past.rewardedVideos,6,'existing all-user video total unchanged');assert.equal(first.registeredUserVideos,1);assert.equal(first.rewardedVideos,2);
 assert.equal(current.registeredUserVideos,1);assert.equal(current.newUsers,1);assert.equal(current.rewardedVideos,1);
 assert.equal((await overview(pool,foreign)).history.find((r:any)=>r.date===dates.past).registeredUserVideos,1);
 const expected=new Map([[dates.past,4],[dates.oldest,1],[dates.today,1]]);
 for(const row of result.history)assert.equal(row.registeredUserVideos,expected.get(row.date)??0);
 assert.equal(result.metrics.todayRewardedVideos,1);assert.equal(result.metrics.newUsers,1);
 const raw=(await pool.query(`SELECT (u.created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS d,count(*)::int AS n FROM game_users u JOIN game_rewarded_video_events e ON e.app_id=u.app_id AND e.user_id=u.id WHERE u.app_id=$1 AND u.first_login_completed AND (u.created_at AT TIME ZONE 'Asia/Shanghai')::date=(e.recorded_at AT TIME ZONE 'Asia/Shanghai')::date AND e.recorded_at>=u.created_at GROUP BY 1`,[app])).rows;
 for(const row of result.history)assert.equal(row.registeredUserVideos,raw.find(r=>r.d===row.date)?.n??0);
});
