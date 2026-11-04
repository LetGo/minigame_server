import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import {loadConfig} from '../src/config.js';
import {migrate} from '../src/database/migrate.js';

test('compiled login restores only the authenticated user stored profile and fails atomically on profile storage errors',async t=>{
 const owner=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});
 const suffix=randomBytes(6).toString('hex'),role='login_profile_'+suffix,appId='wx'+randomBytes(8).toString('hex'),foreignApp='wx'+randomBytes(8).toString('hex');
 const config=loadConfig({WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'explicit-login-profile-stub',DATABASE_URL:`postgresql://${role}:isolated-profile-only@127.0.0.1:15439/minigame_test`,REDIS_URL:'redis://127.0.0.1:16389/15'});
 const redis=createClient({url:config.redisUrl});redis.on('error',()=>{});let app:any,created=false;const tokens:string[]=[];
 try{
  await migrate(owner);await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-profile-only'`);created=true;
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await owner.query(`GRANT SELECT,INSERT,UPDATE ON game_users,game_profiles TO ${role}`);await owner.query(`GRANT SELECT,INSERT ON game_daily_logins TO ${role}`);await owner.query(`GRANT INSERT ON game_login_events TO ${role}`);await redis.connect();
  const build=resolve(process.env.MINIGAME_TEST_DIST_DIR??'dist');const {createApplication}=await import(pathToFileURL(resolve(build,'application.js')).href);const {WechatClient}=await import(pathToFileURL(resolve(build,'auth/wechat.client.js')).href);
  const wechat=new WechatClient(config,async(input:URL|RequestInfo)=>Response.json({openid:new URL(String(input)).searchParams.get('js_code'),session_key:'private-profile-session-key'}));
  app=await createApplication(config,{wechat});await app.listen(0,'127.0.0.1');const base=`http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/`;
  async function call(path:string,body:unknown,token?:string,status=200){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});assert.equal(r.status,status);assert.equal(r.headers.get('cache-control'),'no-store');const data=await r.json() as any;if(data.accessToken)tokens.push(data.accessToken);assert.doesNotMatch(JSON.stringify(data),/private-profile-session-key|explicit-login-profile-stub|session_key/);return data;}
  let first:any;
  await t.test('unregistered profile returns explicit nulls without blocking first login',async()=>{
   first=await call('auth/wechat-login',{code:'profile_actor_'+suffix});assert.equal(first.isNewUser,true);assert.equal(first.user.nickname,null);assert.equal(first.user.avatarUrl,null);assert.deepEqual(Object.keys(first.user).sort(),['avatarUrl','id','nickname','openid']);
  });
  // These cases need the first successful session even when the initial RED assertion fails.
  assert(first?.accessToken);
  await t.test('upload then relogin returns current saved nickname/avatar without changing UID or eligibility',async()=>{
   const profile={nickname:'登录玩家🚀 <b>raw</b>',avatarUrl:'https://example.test/avatar.png?size=64'};
   await call('users/profile',profile,first.accessToken);const later=await call('auth/wechat-login',{code:'profile_actor_'+suffix});assert.equal(later.isNewUser,false);assert.deepEqual(later.user,{id:first.user.id,openid:'profile_actor_'+suffix,...profile});
   const updated={nickname:'已更新资料',avatarUrl:'https://example.test/new.png'};await call('users/profile',updated,first.accessToken);const newest=await call('auth/wechat-login',{code:'profile_actor_'+suffix});assert.deepEqual(newest.user,{id:first.user.id,openid:'profile_actor_'+suffix,...updated});
  });
  await t.test('explicit empty avatar saves nickname and returns null after relogin',async()=>{
   for(const avatarUrl of ['',null]){
    const nickname=avatarUrl===null?'只有昵称null':'只有昵称空串';
    const saved=await call('users/profile',{nickname,avatarUrl},first.accessToken);assert.deepEqual(saved.user,{id:first.user.id,nickname,avatarUrl:null});
    const row=(await owner.query('SELECT nickname,avatar_url FROM game_profiles WHERE user_id=$1',[first.user.id])).rows[0];assert.deepEqual(row,{nickname,avatar_url:null});
    const again=await call('auth/wechat-login',{code:'profile_actor_'+suffix});assert.equal(again.user.nickname,nickname);assert.equal(again.user.avatarUrl,null);assert.equal(again.isNewUser,false);
   }
  });
  await t.test('omitting avatar creates a null avatar but preserves an existing avatar on nickname-only update',async()=>{
   const openid='nickname_only_'+suffix;const user=await call('auth/wechat-login',{code:openid});
   assert.deepEqual((await call('users/profile',{nickname:'首次只有昵称'},user.accessToken)).user,{id:user.user.id,nickname:'首次只有昵称',avatarUrl:null});
   const avatarUrl='https://example.test/keep.png';await call('users/profile',{nickname:'已有头像',avatarUrl},user.accessToken);
   assert.deepEqual((await call('users/profile',{nickname:'只改昵称'},user.accessToken)).user,{id:user.user.id,nickname:'只改昵称',avatarUrl});
   const later=await call('auth/wechat-login',{code:openid});assert.equal(later.user.nickname,'只改昵称');assert.equal(later.user.avatarUrl,avatarUrl);
  });
  await t.test('nonempty invalid avatars and invalid nicknames still fail without changing saved profile',async()=>{
   const before=(await owner.query('SELECT nickname,avatar_url,updated_at FROM game_profiles WHERE user_id=$1',[first.user.id])).rows[0];
   for(const avatarUrl of [' ',false,42,{},[], 'http://example.test/a.png','javascript:alert(1)','https://u:p@example.test/a.png','https://example.test/\n','https://example.test/'+ 'a'.repeat(2048),'\ud800'])await call('users/profile',{nickname:'不能覆盖',avatarUrl},first.accessToken,400);
   for(const body of [{nickname:'',avatarUrl:null},{nickname:' '.repeat(3),avatarUrl:null},{nickname:'a'.repeat(65),avatarUrl:null},{nickname:'bad\nname',avatarUrl:''},{avatarUrl:''},{nickname:'伪造',avatarUrl:null,userId:first.user.id}])await call('users/profile',body,first.accessToken,400);
   assert.deepEqual((await owner.query('SELECT nickname,avatar_url,updated_at FROM game_profiles WHERE user_id=$1',[first.user.id])).rows[0],before);
  });
  await t.test('concurrent nickname-only updates do not erase a concurrently uploaded avatar',async()=>{
   const openid='nickname_race_'+suffix,user=await call('auth/wechat-login',{code:openid});
   const avatarUrl='https://example.test/raced.png';await Promise.all([call('users/profile',{nickname:'上传头像',avatarUrl},user.accessToken),call('users/profile',{nickname:'只更新昵称'},user.accessToken)]);
   assert.equal((await call('auth/wechat-login',{code:openid})).user.avatarUrl,avatarUrl);
  });
  await t.test('same openid in another app cannot supply a profile and client fields cannot override it',async()=>{
   const openid='foreign_only_'+suffix;const foreign=(await owner.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',[foreignApp,openid])).rows[0].id;
   await owner.query('INSERT INTO game_profiles(user_id,nickname,avatar_url) VALUES($1,$2,$3)',[foreign,'foreign-secret-name','https://example.test/foreign.png']);const local=await call('auth/wechat-login',{code:openid});assert.notEqual(local.user.id,foreign);assert.equal(local.user.nickname,null);assert.equal(local.user.avatarUrl,null);
   await call('auth/wechat-login',{code:openid,nickname:'forged',avatarUrl:'https://example.test/forged.png'},undefined,400);
  });
  await t.test('failed profile SELECT returns sanitized 503 and rolls back registration/activity without issuing a session',async()=>{
   const keysBefore=(await redis.keys('minigame:session:*')).sort();await owner.query(`REVOKE SELECT ON game_profiles FROM ${role}`);
   try{const failure=await call('auth/wechat-login',{code:'profile_failure_'+suffix},undefined,503);assert.equal(failure.message,'LOGIN_STORAGE_UNAVAILABLE');assert.equal(failure.accessToken,undefined);assert.doesNotMatch(JSON.stringify(failure),/SELECT|permission|game_profiles|postgres/);assert.equal((await owner.query('SELECT count(*)::int n FROM game_users WHERE app_id=$1 AND open_id=$2',[appId,'profile_failure_'+suffix])).rows[0].n,0);assert.deepEqual((await redis.keys('minigame:session:*')).sort(),keysBefore);}finally{await owner.query(`GRANT SELECT ON game_profiles TO ${role}`);}
  });
 }finally{
  if(app)await app.close();if(redis.isOpen){const {createHash}=await import('node:crypto');for(const token of tokens)await redis.del('minigame:session:'+createHash('sha256').update(token).digest('hex'));await redis.quit();}
  await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])',[[appId,foreignApp]]);if(created){await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);}await owner.end();
 }
});
