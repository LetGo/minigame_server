import assert from 'node:assert/strict';import {test} from 'node:test';import {randomBytes,randomUUID} from 'node:crypto';import {Pool} from 'pg';import {migrate} from '../src/database/migrate.js';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const {previewDailyCheckin,runDailyCheckin}=await import(process.env.MINIGAME_TEST_DIST_DIR?pathToFileURL(resolve(process.env.MINIGAME_TEST_DIST_DIR,'subscriptions/daily-checkin.js')).href:'../src/subscriptions/daily-checkin.js');
const template='2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4';
test('daily reminders select accepted users WITHOUT Beijing-day login, honor window and dedupe attempts',async t=>{
 const pool=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test',max:6}),appId='wx'+randomBytes(8).toString('hex');await migrate(pool);
 t.after(async()=>{await pool.query('DELETE FROM game_users WHERE app_id=$1',[appId]);await pool.end();});
 const clock=()=>new Date('2026-01-20T01:00:00Z');
 const uid=(await pool.query("INSERT INTO game_users(app_id,open_id,last_login_at) VALUES($1,$2,'2026-01-19T15:59:59.999999Z') RETURNING id",[appId,'daily_'+randomUUID()])).rows[0].id;
 await pool.query("INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status,recorded_at) VALUES($1,$2,$3,$4,'accept','2026-01-19T08:00:00Z')",[appId,uid,randomUUID(),template]);
 const view=await previewDailyCheckin(pool,{appId},clock);assert.equal(view.eligibleCount,1);assert.equal(view.inWindow,true);assert.equal(view.today,'2026-01-20');
 let calls=0;const delivery={async send(){calls++;}};
 const early=await runDailyCheckin(pool,delivery,{appId,delayMs:0},()=>new Date('2026-01-20T00:59:59.999Z'));assert.equal(early.sent,0);assert.equal(calls,0);
 await pool.query("INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,'2026-01-20','2026-01-19T16:00:00Z')",[appId,uid]);
 assert.equal((await previewDailyCheckin(pool,{appId},clock)).eligibleCount,0);
 await pool.query('DELETE FROM game_daily_logins WHERE app_id=$1 AND user_id=$2',[appId,uid]);
 await pool.query("UPDATE game_users SET last_login_at='2026-01-19T16:00:00Z' WHERE id=$1",[uid]);assert.equal((await previewDailyCheckin(pool,{appId},clock)).eligibleCount,0);
 await pool.query("UPDATE game_users SET last_login_at='2026-01-19T15:59:59.999999Z' WHERE id=$1",[uid]);
 const sent=await runDailyCheckin(pool,delivery,{appId,delayMs:0},clock);assert.equal(sent.sent,1);assert.equal(sent.stopped,false);assert.equal(calls,1);
 assert.equal((await pool.query('SELECT scheduled_date::text AS day FROM game_subscription_sends WHERE user_id=$1',[uid])).rows[0].day,'2026-01-20');
 // Even fresh accept cannot defeat same-day uniqueness.
 await pool.query("INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status,recorded_at) VALUES($1,$2,$3,$4,'accept','2026-01-20T01:00:01Z')",[appId,uid,randomUUID(),template]);
 assert.equal((await runDailyCheckin(pool,delivery,{appId,delayMs:0},()=>new Date('2026-01-20T01:01:00Z'))).sent,0);assert.equal(calls,1);
 const late=await runDailyCheckin(pool,delivery,{appId,delayMs:0},()=>new Date('2026-01-20T02:00:00Z'));assert.equal(late.sent,0);assert.equal(calls,1);
});
