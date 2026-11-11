import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import {loadConfig} from '../src/config.js';
import {migrate} from '../src/database/migrate.js';

test('compiled nearby leaderboard API with real isolated PostgreSQL/Redis',{timeout:60000},async t=>{
 const owner=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test',connectionTimeoutMillis:3000,statement_timeout:10000});
 const redis=createClient({url:'redis://127.0.0.1:16389/15',socket:{connectTimeout:3000,reconnectStrategy:false}});redis.on('error',()=>{});
 const appId='wx'+randomBytes(8).toString('hex'),foreignApp='wx'+randomBytes(8).toString('hex'),role='nearby_'+randomBytes(6).toString('hex');
 const build=resolve(process.env.MINIGAME_TEST_DIST_DIR??'dist');let app:any,created=false;
 t.after(async()=>{await app?.close();if(redis.isOpen){await redis.flushDb();await redis.quit();}await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::text[])',[[appId,foreignApp]]);if(created){await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);}await owner.end();});
 await migrate(owner);await redis.connect();await redis.flushDb();
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'nearby-isolated-only'`);created=true;
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await owner.query(`GRANT SELECT ON game_users,game_profiles TO ${role}`);await owner.query(`GRANT SELECT,INSERT,UPDATE ON game_leaderboard_scores TO ${role}`);
 const ids=(await owner.query("INSERT INTO game_users(app_id,open_id) SELECT $1,'nearby_'||n FROM generate_series(1,45) n RETURNING id",[appId])).rows.map(r=>r.id as string);
 const config=loadConfig({WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'explicit-nearby-stub',DATABASE_URL:`postgresql://${role}:nearby-isolated-only@127.0.0.1:15439/minigame_test`,REDIS_URL:'redis://127.0.0.1:16389/15'});
 const {createApplication}=await import(pathToFileURL(resolve(build,'application.js')).href);
 const {Infrastructure}=await import(pathToFileURL(resolve(build,'infrastructure.js')).href);
 app=await createApplication(config);await app.listen(0,'127.0.0.1');
 async function session(userId:string,sessionApp=appId){const token=randomBytes(32).toString('base64url');await redis.set('minigame:session:'+createHash('sha256').update(token).digest('hex'),JSON.stringify({appId:sessionApp,userId}),{EX:300});return token;}
 async function call(endpoint:string,body:unknown,token:string|undefined,status=200){
  const response=await fetch(`http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/leaderboards/`+endpoint,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await response.json() as any;assert.equal(response.status,status,`${endpoint}: ${JSON.stringify(data)}`);assert.equal(response.headers.get('cache-control'),'no-store');return {data,headers:response.headers};
 }
 const key=(type='boss')=>`minigame:leaderboard:${appId}:${type}`;
 async function seed(type='boss',count=45){await owner.query("INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value,dirty) SELECT $1,$2,id,1000+floor(n/2)::int,false FROM unnest($3::uuid[]) WITH ORDINALITY AS q(id,n)",[appId,type,ids.slice(0,count)]);return (await owner.query('SELECT user_id,value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type=$2 ORDER BY value DESC,user_id DESC',[appId,type])).rows;}
 t.beforeEach(async()=>{await owner.query('DELETE FROM game_leaderboard_scores WHERE app_id=$1',[appId]);await redis.flushDb();});
 await t.test('middle player receives exactly five ahead, self and five behind with global ranks',async()=>{
  const ordered=await seed();const me=ordered[20]!;const token=await session(me.user_id);
  const {data}=await call('nearby',{type:'boss'},token);
  assert.equal(data.type,'boss');assert.equal(data.entries.length,11);assert.equal(data.self.rank,21);assert.equal(data.self.userId,me.user_id);
  assert.deepEqual(data.entries.map((r:any)=>[r.userId,r.value,r.rank]),ordered.slice(15,26).map((r:any,i:number)=>[r.user_id,r.value,i+16]));
  assert.deepEqual(data.entries[5],data.self);assert(data.entries.every((r:any)=>r.nickname==='游客'&&r.avatarUrl===''));
  const top=(await call('list',{type:'boss'},token)).data;assert.equal(top.entries.length,30);assert.equal(top.entries[0].rank,1);
 });
 await t.test('head and tail windows do not shift or refill and preserve global ranks',async()=>{
  const ordered=await seed();
  for(const position of [0,1,4,5,39,44]){
   const token=await session(ordered[position]!.user_id);const {data}=await call('nearby',{type:'boss'},token);
   const start=Math.max(0,position-5),end=Math.min(ordered.length,position+6);
   assert.deepEqual(data.entries.map((r:any)=>[r.userId,r.rank]),ordered.slice(start,end).map((r:any,i:number)=>[r.user_id,start+i+1]));
   assert.equal(data.self.rank,position+1);assert.equal(data.entries.some((r:any)=>r.userId==='__ready__'),false);
  }
 });
 await t.test('empty and short boards return only real entries, including the one-player case',async()=>{
  for(const count of [0,1,3,10]){
   await owner.query('DELETE FROM game_leaderboard_scores WHERE app_id=$1',[appId]);await redis.unlink([key(),key()+':epoch']);
   const ordered=await seed('boss',count);const position=Math.floor(count/2),id=ordered[position]?.user_id??ids[0]!;
   const {data}=await call('nearby',{type:'boss'},await session(id));
   const start=Math.max(0,position-5),end=Math.min(count,position+6);
   assert.deepEqual(data.entries.map((r:any)=>r.userId),ordered.slice(start,end).map((r:any)=>r.user_id));
   assert.equal(data.self.rank,count?position+1:null);assert.equal(data.self.value,count?ordered[position]!.value:null);
   if(count===1)assert.deepEqual(data.entries,[data.self]);
  }
 });
 await t.test('unreported and below-threshold players have empty nearby entries and durable maximum self values',async()=>{
  const token=await session(ids[0]!);
  for(const [type,minimum] of [['boss',30],['stage',101]] as const){
   const absent=(await call('nearby',{type},token)).data;assert.equal(absent.self.rank,null);assert.equal(absent.self.value,null);assert.deepEqual(absent.entries,[]);
   for(const value of [0,minimum-1]){
    await call('report',{type,value},token);const {data}=await call('nearby',{type},token);
    assert.equal(data.self.rank,null);assert.equal(data.self.value,value);assert.deepEqual(data.entries,[]);
   }
   await call('report',{type,value:minimum},token);const qualified=(await call('nearby',{type},token)).data;
   assert.equal(qualified.self.rank,1);assert.equal(qualified.self.value,minimum);assert.deepEqual(qualified.entries,[qualified.self]);
  }
 });
 await t.test('an unranked self never falls back to Top30 when other players form a nonempty board',async()=>{
  const me=(await owner.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'nearby_unranked') RETURNING id",[appId])).rows[0].id;
  const token=await session(me);
  for(const [type,minimum] of [['boss',30],['stage',101]] as const){
   await seed(type);const top=(await call('list',{type},token)).data;assert.equal(top.entries.length,30);assert.equal(top.self.rank,null);
   const absent=(await call('nearby',{type},token)).data;assert.deepEqual(absent.entries,[]);assert.equal(absent.self.value,null);assert.equal(absent.self.userId,me);
   for(const value of [0,minimum-1]){
    await call('report',{type,value},token);const {data}=await call('nearby',{type},token);assert.deepEqual(data.entries,[]);assert.equal(data.self.rank,null);assert.equal(data.self.value,value);assert.equal(data.self.userId,me);
   }
  }
 });
 await t.test('boss and stage, games and sessions remain isolated and profiles retain established fields',async()=>{
  const me=ids[0]!,other=ids[1]!,token=await session(me);
  await call('report',{type:'boss',value:35},token);await call('report',{type:'stage',value:120},token);
  await call('report',{type:'boss',value:80},await session(other));
  const foreign=(await owner.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'nearby_foreign') RETURNING id",[foreignApp])).rows[0].id;
  await owner.query("INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value) VALUES($1,'boss',$2,2147483647)",[foreignApp,foreign]);
  await owner.query("INSERT INTO game_profiles(user_id,nickname,avatar_url) VALUES($1,'附近玩家','https://example.com/avatar.png')",[me]);
  const boss=(await call('nearby',{type:'boss'},token)).data;const stage=(await call('nearby',{type:'stage'},token)).data;
  assert.equal(boss.self.rank,2);assert.equal(boss.self.value,35);assert.equal(stage.self.rank,1);assert.equal(stage.self.value,120);assert.equal(stage.entries.length,1);assert.equal(boss.entries.length,2);
  assert.equal(boss.self.nickname,'附近玩家');assert.equal(boss.self.avatarUrl,'https://example.com/avatar.png');assert.deepEqual(Object.keys(boss.self).sort(),['avatarUrl','nickname','rank','userId','value']);
  await owner.query("UPDATE game_profiles SET nickname='新昵称' WHERE user_id=$1",[me]);assert.equal((await call('nearby',{type:'boss'},token)).data.self.nickname,'新昵称');
  const upper=(await call('nearby',{type:'boss'},await session(me.toUpperCase()))).data;assert.equal(upper.self.userId,me);assert.equal(upper.self.rank,2);
 });
 await t.test('caller cannot override actor, radius, game, type or supply extra request/query fields',async()=>{
  const token=await session(ids[0]!);
  for(const body of [{},[],{type:'bad'},{type:'Boss'},{type:'boss',userId:ids[1]},{type:'boss',gameId:'x'},{type:'boss',radius:5},{type:'boss',limit:11},{type:'boss',value:30}]){
   assert.equal((await call('nearby',body,token,400)).data.message,'INVALID_LEADERBOARD_REQUEST');
  }
  assert.equal((await call('nearby',null,token,400)).data.message,'INVALID_JSON');
  await call('nearby?type=boss',{type:'boss'},token,400);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_leaderboard_scores WHERE app_id=$1',[appId])).rows[0].n,0);
 });
 await t.test('missing, invalid, foreign, nonexistent and incomplete sessions cannot query nearby',async()=>{
  const incomplete=(await owner.query("INSERT INTO game_users(app_id,open_id,first_login_completed) VALUES($1,'nearby_incomplete',false) RETURNING id",[appId])).rows[0].id;
  for(const token of [undefined,'malformed',randomBytes(32).toString('base64url'),await session(ids[0]!,foreignApp),await session(randomUUID()),await session(incomplete)])assert.equal((await call('nearby',{type:'boss'},token,401)).data.message,'SESSION_INVALID');
 });
 await t.test('list and nearby share 60 per minute across tokens and boards without consuming report quota',async()=>{
  const me=ids[0]!,a=await session(me),b=await session(me);
  for(let i=0;i<60;i++)await call(i%2?'nearby':'list',{type:i%3?'boss':'stage'},i%2?a:b);
  for(const endpoint of ['list','nearby']){const denied=await call(endpoint,{type:'boss'},b,429);assert.equal(denied.data.message,'LEADERBOARD_RATE_LIMITED');assert(Number(denied.headers.get('retry-after'))>0);}
  await call('report',{type:'boss',value:30},a);
 });
 await t.test('nearby alone recovers missing or stale-policy indexes before reading',async()=>{
  await seed();const ordered=(await owner.query("SELECT user_id,value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type='boss' ORDER BY value DESC,user_id DESC",[appId])).rows;
  const token=await session(ordered[35]!.user_id);const first=(await call('nearby',{type:'boss'},token)).data;
  assert.equal(first.self.rank,36);await redis.unlink(key());assert.deepEqual((await call('nearby',{type:'boss'},token)).data,first);
  await redis.unlink(key());await redis.zAdd(key(),[{score:-1,value:'__ready__'},{score:0,value:ordered[35]!.user_id}]);await redis.set(key()+':epoch','old-generation:min=50');
  assert.deepEqual((await call('nearby',{type:'boss'},token)).data,first);assert.equal(await redis.zScore(key(),'__ready__'),-1);
  const runId=/^run_id:([^\r\n]+)/m.exec(await redis.info('server'))![1]!;assert.equal(await redis.get(key()+':epoch'),runId+':min=30');
 });
 await t.test('only window profiles are fetched and rank/score/window form one Redis snapshot under changes',async()=>{
  const ordered=await seed(),me=ordered[20]!,token=await session(me.user_id);await call('nearby',{type:'boss'},token);
  const infra=app.get(Infrastructure) as any,query=infra.pool.query,commands=infra.redis.withCommandOptions;let profileIds:string[]=[],changed=false;
  try{
   infra.pool.query=function(sql:string,...params:unknown[]){if(sql.startsWith('SELECT u.id,p.nickname'))profileIds=(params[0] as any[])[1];return query.call(this,sql,...params);};
   infra.redis.withCommandOptions=function(options:unknown){const api=commands.call(this,options);return new Proxy(api,{get(target,k){if(k==='eval')return async(script:string,options:any)=>{const result=await target.eval(script,options);if(!changed&&script.includes('local nearby=')){changed=true;await redis.zAdd(key(),{score:2000,value:me.user_id});}return result;};const f=Reflect.get(target,k);return typeof f==='function'?f.bind(target):f;}});};
   const {data}=await call('nearby',{type:'boss'},token);assert.equal(data.self.rank,21);assert.equal(data.self.value,me.value);assert.deepEqual(data.entries[5],data.self);assert.equal(profileIds.length,11);assert.equal(new Set(profileIds).size,11);
  }finally{infra.pool.query=query;infra.redis.withCommandOptions=commands;}
  assert.equal(changed,true);assert.equal((await call('nearby',{type:'boss'},token)).data.self.rank,1);
 });
 await t.test('rebuild lock and dependency failures are explicit sanitized 503 responses, not empty boards',async()=>{
  const token=await session(ids[0]!);const client=await owner.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`minigame:leaderboard-lock:${appId}:boss`]);assert.equal((await call('nearby',{type:'boss'},token,503)).data.message,'LEADERBOARD_REBUILDING');}finally{await client.query('ROLLBACK');client.release();}
  await call('nearby',{type:'boss'},token);const infra=app.get(Infrastructure) as any,query=infra.pool.query,commands=infra.redis.withCommandOptions;
  try{infra.pool.query=async()=>{throw Error('private-nearby-sql');};const failed=await call('nearby',{type:'boss'},token,503);assert.equal(failed.data.message,'LEADERBOARD_STORAGE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(failed.data),/private|SELECT|stack/);}finally{infra.pool.query=query;}
  try{infra.redis.withCommandOptions=function(options:unknown){const api=commands.call(this,options);return new Proxy(api,{get(target,k){if(k==='eval')return async()=>{throw Error('private-nearby-redis');};const f=Reflect.get(target,k);return typeof f==='function'?f.bind(target):f;}});};const failed=await call('nearby',{type:'boss'},token,503);assert.equal(failed.data.message,'LEADERBOARD_STORAGE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(failed.data),/private|redis|stack/);}finally{infra.redis.withCommandOptions=commands;}
 });
});
