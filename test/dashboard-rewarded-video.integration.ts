import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {migrate} from '../src/database/migrate.js';

test('dashboard rewarded-video total counts all stored events only for this game',async t=>{
 const pool=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});
 const appId='wx'+randomBytes(8).toString('hex'),foreignApp='wx'+randomBytes(8).toString('hex');
 t.after(async()=>{await pool.query('DELETE FROM game_users WHERE app_id=ANY($1::text[])',[[appId,foreignApp]]);await pool.end();});
 await migrate(pool);
 const {overview}=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 assert.equal((await overview(pool,appId)).metrics.totalRewardedVideos,0,'empty game must return zero video events');
 const users=(await pool.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'video_a'),($1,'video_b'),($2,'video_foreign') RETURNING id,app_id,open_id",[appId,foreignApp])).rows;
 const a=users.find(x=>x.open_id==='video_a')!,b=users.find(x=>x.open_id==='video_b')!,foreign=users.find(x=>x.open_id==='video_foreign')!;
 const event=randomUUID();
 await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,client_info,recorded_at)
 VALUES($1,$2,$3,'revive','{}',clock_timestamp()-interval '45 days'),
 ($1,$2,$4,'double_reward','{}',clock_timestamp()),
 ($1,$5,$3,'revive','{}',clock_timestamp()),
 ($6,$7,$3,'revive','{}',clock_timestamp())`,[appId,a.id,event,randomUUID(),b.id,foreignApp,foreign.id]);
 // Same user/event replay never increments; same UUID belonging to another user is a separate completed event.
 await pool.query("INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) VALUES($1,$2,$3,'revive') ON CONFLICT DO NOTHING",[appId,a.id,event]);
 const result=await overview(pool,appId);
 assert.equal(result.metrics.totalRewardedVideos,3);
 assert.equal((await overview(pool,foreignApp)).metrics.totalRewardedVideos,1);
 assert.equal(result.history.length,14,'video metric must not change existing trend');
 assert.equal(result.metrics.totalUsers,2);
 await pool.query('DELETE FROM game_users WHERE id=$1',[b.id]);
 assert.equal((await overview(pool,appId)).metrics.totalRewardedVideos,2,'metric is stored-event total; cascade deletion removes deleted player events');
});
