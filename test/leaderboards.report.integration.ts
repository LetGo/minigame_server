import 'reflect-metadata';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import {loadConfig} from '../src/config.js';
import {migrate} from '../src/database/migrate.js';

test('compiled leaderboard authenticated report persists a stage score',async t=>{
 const owner=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});
 const redis=createClient({url:'redis://127.0.0.1:16389/15'});redis.on('error',()=>{});
 const appId='wx'+randomBytes(8).toString('hex');let app:any;
 t.after(async()=>{await app?.close();if(redis.isOpen){await redis.flushDb();await redis.quit();}await owner.query('DELETE FROM game_users WHERE app_id=$1',[appId]);await owner.end();});
 await migrate(owner);await redis.connect();await redis.flushDb();
 const uid=(await owner.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'leaderboard_test') RETURNING id",[appId])).rows[0].id;
 const token=randomBytes(32).toString('base64url');await redis.set('minigame:session:'+createHash('sha256').update(token).digest('hex'),JSON.stringify({appId,userId:uid}),{EX:300});
 const build=resolve(process.env.MINIGAME_TEST_DIST_DIR??'dist');
 const {createApplication}=await import(pathToFileURL(resolve(build,'application.js')).href);
 app=await createApplication(loadConfig({WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'explicit-isolated-test',DATABASE_URL:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test',REDIS_URL:'redis://127.0.0.1:16389/15'}));
 await app.listen(0,'127.0.0.1');
 const response=await fetch(`http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/leaderboards/report`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({type:'stage',value:500}),signal:AbortSignal.timeout(10000)});
 const body=await response.json() as any;assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.type,'stage');assert.equal(body.value,500);assert.equal(body.rank,1);assert.equal(body.improved,true);
 const listed=await fetch(`http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/leaderboards/list`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({type:'stage'}),signal:AbortSignal.timeout(10000)});
 const list=await listed.json() as any;assert.equal(listed.status,200,JSON.stringify(list));assert.deepEqual(list,{type:'stage',entries:[{userId:uid,rank:1,nickname:'游客',avatarUrl:'',value:500}],self:{userId:uid,rank:1,nickname:'游客',avatarUrl:'',value:500}});
});
