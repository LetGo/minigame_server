import assert from 'node:assert/strict';import {test} from 'node:test';import {randomUUID} from 'node:crypto';import {mkdtemp,copyFile,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {Pool} from 'pg';import {migrate} from '../src/database/migrate.js';
test('009 upgrades existing008 receipts without changing history and enforces only scheduled per-day uniqueness',async()=>{
 const connection={host:'127.0.0.1',port:15439,user:'minigame_test',password:'local_integration_only',connectionTimeoutMillis:3000};
 const admin=new Pool({...connection,database:'minigame_test'}),name='minigame_daily_upgrade_'+randomUUID().replaceAll('-',''),dir=await mkdtemp(join(tmpdir(),'minigame-daily-upgrade-'));let db:Pool|undefined,created=false;
 try{
  await admin.query(`CREATE DATABASE ${name}`);created=true;db=new Pool({...connection,database:name});
  for(const file of await readdir(resolve('migrations')))if(file.endsWith('.sql')&&file<'009_')await copyFile(resolve('migrations',file),join(dir,file));
  await migrate(db,dir);const history=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;assert.equal(history.length,8);
  const app='wx1111222233334444',uid=(await db.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',[app,'upgrade_fixture'])).rows[0].id,req=randomUUID(),template='2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4';
  await db.query("INSERT INTO game_subscription_sends(app_id,user_id,request_id,template_id,page,state,upstream_code,finished_at) VALUES($1,$2,$3,$4,'index','sent',0,clock_timestamp())",[app,uid,req,template]);
  const original=(await db.query('SELECT to_jsonb(s) AS row FROM game_subscription_sends s WHERE request_id=$1',[req])).rows[0].row;
  await migrate(db);assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations WHERE name=ANY($1::text[]) ORDER BY name',[history.map(r=>r.name)])).rows,history);
  const upgraded=(await db.query('SELECT to_jsonb(s) AS row FROM game_subscription_sends s WHERE request_id=$1',[req])).rows[0].row;assert.equal(upgraded.scheduled_date,null);delete upgraded.scheduled_date;assert.deepEqual(upgraded,original);
  const insert=(day:string|null)=>db!.query("INSERT INTO game_subscription_sends(app_id,user_id,request_id,template_id,page,state,upstream_code,finished_at,scheduled_date) VALUES($1,$2,$3,$4,'index','sent',0,clock_timestamp(),$5)",[app,uid,randomUUID(),template,day]);
  await insert('2026-10-20');await assert.rejects(()=>insert('2026-10-20'),{code:'23505'});await insert('2026-10-21');await insert(null);await insert(null);
  await migrate(db);assert.equal((await db.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='009_scheduled_subscriptions.sql'")).rows[0].n,1);
 }finally{if(db)await db.end();if(created)await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
