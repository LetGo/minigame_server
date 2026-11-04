import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,copyFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Pool} from 'pg';
import {migrate} from '../src/database/migrate.js';

test('010 allows null profile avatars without rewriting existing profiles or weakening nonempty length checks',async()=>{
 const connection={host:'127.0.0.1',port:15439,user:'minigame_test',password:'local_integration_only',connectionTimeoutMillis:3000};
 const admin=new Pool({...connection,database:'minigame_test'}),name='minigame_avatar_upgrade_'+randomUUID().replaceAll('-',''),dir=await mkdtemp(join(tmpdir(),'minigame-avatar-upgrade-'));let db:Pool|undefined,created=false;
 try{
  await admin.query(`CREATE DATABASE ${name}`);created=true;db=new Pool({...connection,database:name});
  for(const file of await readdir(resolve('migrations')))if(/^\d+_.*\.sql$/.test(file)&&file<'010_')await copyFile(resolve('migrations',file),join(dir,file));
  await migrate(db,dir);const history=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;assert.equal(history.length,9);
  const uid=(await db.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',['wx1111222233334444','avatar_upgrade'])).rows[0].id;
  await db.query('INSERT INTO game_profiles(user_id,nickname,avatar_url) VALUES($1,$2,$3)',[uid,'原昵称','https://example.test/original.png']);
  const original=(await db.query('SELECT to_jsonb(p) row FROM game_profiles p WHERE user_id=$1',[uid])).rows;
  const acl=(await db.query("SELECT relacl FROM pg_class WHERE oid='game_profiles'::regclass")).rows;
  await assert.rejects(()=>db!.query('UPDATE game_profiles SET avatar_url=NULL WHERE user_id=$1',[uid]),{code:'23502'});
  await migrate(db);assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations WHERE name=ANY($1::text[]) ORDER BY name',[history.map(r=>r.name)])).rows,history);
  assert.deepEqual((await db.query('SELECT to_jsonb(p) row FROM game_profiles p WHERE user_id=$1',[uid])).rows,original);
  assert.deepEqual((await db.query("SELECT relacl FROM pg_class WHERE oid='game_profiles'::regclass")).rows,acl);
  await db.query('UPDATE game_profiles SET avatar_url=NULL WHERE user_id=$1',[uid]);assert.equal((await db.query('SELECT avatar_url FROM game_profiles WHERE user_id=$1',[uid])).rows[0].avatar_url,null);
  for(const avatar of ['', 'a'.repeat(2049)])await assert.rejects(()=>db!.query('UPDATE game_profiles SET avatar_url=$2 WHERE user_id=$1',[uid,avatar]),{code:'23514'});
  await assert.rejects(()=>db!.query("UPDATE game_profiles SET nickname='' WHERE user_id=$1",[uid]),{code:'23514'});
  await migrate(db);assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE name='010_optional_profile_avatar.sql'")).rows[0].n,1);
 }finally{if(db)await db.end();if(created)await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
