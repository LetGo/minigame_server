import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {migrate} from '../src/database/migrate.js';

test('dashboard video count uses Beijing calendar day with inclusive start and exclusive end',async t=>{
 const pool=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});
 const appId='wx'+randomBytes(8).toString('hex'),foreignApp='wx'+randomBytes(8).toString('hex');
 t.after(async()=>{await pool.query('DELETE FROM game_users WHERE app_id=ANY($1::text[])',[[appId,foreignApp]]);await pool.end();});
 await migrate(pool);
 const {overview}=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 assert.equal((await overview(pool,appId)).metrics.todayRewardedVideos,0,'empty day must return zero');
 const users=(await pool.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'video_a'),($1,'video_b'),($2,'video_foreign') RETURNING id,app_id,open_id",[appId,foreignApp])).rows;
 const a=users.find(x=>x.open_id==='video_a')!,b=users.find(x=>x.open_id==='video_b')!,foreign=users.find(x=>x.open_id==='video_foreign')!;
 const day=(await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS day")).rows[0].day;
 const midnight=`$8::date::timestamp AT TIME ZONE 'Asia/Shanghai'`,next=`($8::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'`;
 const event=randomUUID();
 await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,client_info,recorded_at)
 VALUES($1,$2,$3,'old','{}',(${midnight})-interval '1 microsecond'),
 ($1,$2,$4,'day_start','{}',${midnight}),
 ($1,$5,gen_random_uuid(),'day_end','{}',(${next})-interval '1 microsecond'),
 ($1,$5,gen_random_uuid(),'now','{}',clock_timestamp()),
 ($1,$2,gen_random_uuid(),'next_day','{}',${next}),
 ($1,$2,gen_random_uuid(),'older','{}',(${midnight})-interval '45 days'),
 ($6,$7,$3,'foreign','{}',${midnight})`,[appId,a.id,event,randomUUID(),b.id,foreignApp,foreign.id,day]);
 await pool.query("INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) VALUES($1,$2,$3,'old') ON CONFLICT DO NOTHING",[appId,a.id,event]);
 const result=await overview(pool,appId);
 assert.equal(result.today,day);
 assert.equal(result.metrics.todayRewardedVideos,3,'only this app and Beijing day, including exact midnight');
 assert.equal(Object.hasOwn(result.metrics,'totalRewardedVideos'),false,'dashboard contract no longer advertises all-time video count');
 assert.equal((await overview(pool,foreignApp)).metrics.todayRewardedVideos,1);
 assert.equal(result.history.length,14);
 assert.equal(result.metrics.totalUsers,2);
 await pool.query('DELETE FROM game_users WHERE id=$1',[b.id]);
 assert.equal((await overview(pool,appId)).metrics.todayRewardedVideos,1,'cascade removes only stored player events');
 const historical=(await pool.query("SELECT count(*)::int n FROM game_rewarded_video_events WHERE app_id=$1 AND recorded_at<($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')",[appId,day])).rows[0].n;
 assert.equal(historical,2,'daily display must not delete historical events');
});
