import 'reflect-metadata';
import assert from 'node:assert/strict';import {test} from 'node:test';
import {randomBytes} from 'node:crypto';import {mkdtemp,copyFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Pool} from 'pg';import {createClient} from 'redis';import request from 'supertest';
import {migrate} from '../src/database/migrate.js';import {loadConfig} from '../src/config.js';import {createApplication} from '../src/application.js';import {WechatClient} from '../src/auth/wechat.client.js';import {Infrastructure} from '../src/infrastructure.js';
const dbUrl='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
const appId='wx9876543210abcdef';
test('daily login upgrade records only known current-day logins without inventing history',async t=>{
 const admin=new Pool({connectionString:dbUrl});const name='daily_upgrade_'+randomBytes(5).toString('hex');const previous=await mkdtemp(join(tmpdir(),'daily-upgrade-'));let db:Pool|undefined;let created=false;
 try{
  for(const f of ['001_users.sql','002_game_saves.sql','003_invites.sql','004_source_scene.sql'])await copyFile(join('migrations',f),join(previous,f));
  await admin.query(`CREATE DATABASE ${name}`);created=true;const url=new URL(dbUrl);url.pathname='/'+name;db=new Pool({connectionString:url.href});await migrate(db,previous);
  const rows=(await db.query(`INSERT INTO game_users(app_id,open_id,last_login_at) VALUES($1,'known_today',clock_timestamp()),($1,'old_latest',clock_timestamp()-interval '2 days') RETURNING id,open_id`,[appId])).rows;
  const history=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  await migrate(db);assert.notEqual((await db.query("SELECT to_regclass('game_daily_logins') AS name")).rows[0].name,null,'daily activity migration must install its table');
  assert.notEqual((await db.query("SELECT to_regclass('game_analytics_metadata') AS name")).rows[0].name,null);
  const daily=(await db.query('SELECT user_id,activity_date::text FROM game_daily_logins')).rows;assert.equal(daily.length,1);assert.equal(daily[0].user_id,rows.find(x=>x.open_id==='known_today').id);
  const day=(await db.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS activity_day")).rows[0].activity_day;assert.equal(daily[0].activity_date,day);
  const meta=(await db.query('SELECT coverage_start::text,tracking_started_at FROM game_analytics_metadata WHERE id=true')).rows[0];assert.equal(meta.coverage_start,day);assert(meta.tracking_started_at instanceof Date);
  await migrate(db);assert.equal((await db.query('SELECT count(*)::int n FROM game_daily_logins')).rows[0].n,1);assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations WHERE name=ANY($1::text[]) ORDER BY name',[history.map(x=>x.name)])).rows,history);
 }finally{if(db)await db.end();if(created)await admin.query(`DROP DATABASE ${name}`);await admin.end();await rm(previous,{recursive:true,force:true});}
});

test('successful logins write exactly one Beijing-day activity row inside the registration transaction',async t=>{
 const config=loadConfig({WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'explicit-daily-login-stub',DATABASE_URL:dbUrl,REDIS_URL:'redis://127.0.0.1:16389/15',LOGIN_RATE_LIMIT:'200'});
 const pool=new Pool({connectionString:dbUrl});const redis=createClient({url:config.redisUrl});redis.on('error',()=>{});await redis.connect();
 await migrate(pool);await pool.query('TRUNCATE game_users CASCADE');await redis.flushDb();
 const wechat=new WechatClient(config,async input=>Response.json({openid:new URL(String(input)).searchParams.get('js_code'),session_key:'explicit-not-real-session'}));
 const app=await createApplication(config,{wechat});await app.listen(0,'127.0.0.1');
 t.after(async()=>{await app.close();await redis.quit();await pool.end();});
 const login=async(code:string,status=200)=>(await request(app.getHttpServer()).post('/h5login/api/auth/wechat-login').send({code}).expect(status)).body;
 const first=await login('daily_new');
 const rows=await pool.query('SELECT user_id,activity_date::text FROM game_daily_logins WHERE user_id=$1',[first.user.id]);
 assert.equal(rows.rowCount,1,'a successful fresh login must persist daily activity');
 const expected=(await pool.query("SELECT (last_login_at AT TIME ZONE 'Asia/Shanghai')::date::text activity_date FROM game_users WHERE id=$1",[first.user.id])).rows[0].activity_date;
 assert.equal(rows.rows[0].activity_date,expected);
 await t.test('concurrent logins deduplicate users rather than counting requests',async()=>{
  const sessions=await Promise.all(Array.from({length:6},()=>login('daily_new')));assert(sessions.every(x=>x.user.id===first.user.id&&!x.isNewUser));
  assert.equal((await pool.query('SELECT count(*)::int n FROM game_daily_logins WHERE user_id=$1',[first.user.id])).rows[0].n,1);
 });
 await t.test('authenticated cloud reads do not count as successful login activity',async()=>{
  await pool.query('DELETE FROM game_daily_logins WHERE user_id=$1',[first.user.id]);
  await request(app.getHttpServer()).post('/h5login/api/data/get').set('Authorization','Bearer '+first.accessToken).send({}).expect(200);
  assert.equal((await pool.query('SELECT count(*)::int n FROM game_daily_logins WHERE user_id=$1',[first.user.id])).rows[0].n,0);
  await login('daily_new');assert.equal((await pool.query('SELECT count(*)::int n FROM game_daily_logins WHERE user_id=$1',[first.user.id])).rows[0].n,1);
 });
 await t.test('failed Redis session creation cannot count a registration or its activity',async()=>{
  const infra=app.get(Infrastructure);const original=infra.redis.withCommandOptions.bind(infra.redis);
  infra.redis.withCommandOptions=(()=>({set:async()=>{throw new Error('do not expose this storage failure');}})) as unknown as typeof infra.redis.withCommandOptions;
  try{const failure=await login('daily_failed',503);assert.equal(failure.message,'LOGIN_STORAGE_UNAVAILABLE');}
  finally{infra.redis.withCommandOptions=original;}
  assert.equal((await pool.query('SELECT id FROM game_users WHERE app_id=$1 AND open_id=$2',[appId,'daily_failed'])).rowCount,0);
 });
 await t.test('daily storage failure rolls back login and cleans acknowledged Redis session',async()=>{
  const infra=app.get(Infrastructure);const original=infra.pool.connect.bind(infra.pool);const before=await redis.keys('minigame:session:*');
  infra.pool.connect=(async()=>{const client=await original();const query=client.query.bind(client);client.query=((...args:any[])=>{if(typeof args[0]==='string'&&args[0].includes('INSERT INTO game_daily_logins'))return Promise.reject(new Error('private activity error'));return (query as any)(...args);}) as typeof client.query;const release=client.release.bind(client);client.release=((error?:Error|boolean)=>{client.query=query as typeof client.query;release(error);}) as typeof client.release;return client;}) as typeof infra.pool.connect;
  try{assert.equal((await login('daily_record_failed',503)).message,'LOGIN_STORAGE_UNAVAILABLE');}finally{infra.pool.connect=original;}
  assert.equal((await pool.query('SELECT id FROM game_users WHERE app_id=$1 AND open_id=$2',[appId,'daily_record_failed'])).rowCount,0);assert.deepEqual((await redis.keys('minigame:session:*')).sort(),before.sort());
 });
 await t.test('Beijing midnight constraint distinguishes adjacent days in UTC',async()=>{
  await pool.query("INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,'2000-01-01','2000-01-01T15:59:59.999999Z'),($1,$2,'2000-01-02','2000-01-01T16:00:00Z')",[appId,first.user.id]);
  await assert.rejects(()=>pool.query("INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,'2000-01-03','2000-01-01T16:00:00Z')",[appId,first.user.id]));
 });
});
