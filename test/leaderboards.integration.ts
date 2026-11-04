import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import {loadConfig} from '../src/config.js';
import {migrate} from '../src/database/migrate.js';

test('compiled leaderboard API with real PostgreSQL/Redis and least-privilege role',async t=>{
 const owner=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});
 const redis=createClient({url:'redis://127.0.0.1:16389/15'});redis.on('error',()=>{});
 const appId='wx'+randomBytes(8).toString('hex'),foreignApp='wx'+randomBytes(8).toString('hex'),role='lb_'+randomBytes(6).toString('hex');
 const build=resolve(process.env.MINIGAME_TEST_DIST_DIR??'dist');
 let app:any,second:any,created=false;const keys:string[]=[];
 t.after(async()=>{await second?.close();await app?.close();if(redis.isOpen){await redis.flushDb();await redis.quit();}await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::text[])',[[appId,foreignApp]]);if(created){await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);}await owner.end();});
 await migrate(owner);await redis.connect();await redis.flushDb();
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'leaderboard-isolated-only'`);created=true;
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
 await owner.query(`GRANT SELECT ON game_users,game_profiles TO ${role}`);
 await owner.query(`GRANT SELECT,INSERT,UPDATE ON game_leaderboard_scores TO ${role}`);
 const ids=(await owner.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'a'),($1,'b'),($1,'c') RETURNING id",[appId])).rows.map(r=>r.id as string);
 const [a,b,c]=ids as [string,string,string];
 const foreign=(await owner.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'foreign') RETURNING id",[foreignApp])).rows[0].id;
 const config=loadConfig({WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'explicit-leaderboard-stub',DATABASE_URL:`postgresql://${role}:leaderboard-isolated-only@127.0.0.1:15439/minigame_test`,REDIS_URL:'redis://127.0.0.1:16389/15'});
 const {createApplication}=await import(pathToFileURL(resolve(build,'application.js')).href);
 const {Infrastructure}=await import(pathToFileURL(resolve(build,'infrastructure.js')).href);
 app=await createApplication(config);await app.listen(0,'127.0.0.1');
 async function session(value:unknown){const token=randomBytes(32).toString('base64url');await redis.set('minigame:session:'+createHash('sha256').update(token).digest('hex'),JSON.stringify(value),{EX:300});return token;}
 const token=await session({appId,userId:a}),again=await session({appId,userId:a}),bt=await session({appId,userId:b});
 const board=(type='stage')=>`minigame:leaderboard:${appId}:${type}`;
 async function call(path:string,body:unknown,access:string|undefined=token,status=200,target=app){
  const result=await fetch(`http://127.0.0.1:${target.getHttpServer().address().port}/h5login/api/leaderboards/`+path,{method:'POST',headers:{'content-type':'application/json',...(access?{authorization:'Bearer '+access}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const json=await result.json() as any;assert.equal(result.status,status,`${path}: ${JSON.stringify(json)}`);assert.equal(result.headers.get('cache-control'),'no-store');return {data:json,headers:result.headers};
 }
 const report=async(value:number,type='stage',access=token,target=app)=>(await call('report',{type,value},access,200,target)).data;
 const list=async(type='stage',access=token)=>(await call('list',{type},access)).data;
 async function until(check:()=>Promise<boolean>){const until=Date.now()+7000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,50));}assert.fail('background synchronization did not converge');}
 t.beforeEach(async()=>{
  await owner.query('DELETE FROM game_leaderboard_scores WHERE app_id=$1',[appId]);
  keys.splice(0,keys.length,board(),board('boss'),...ids.flatMap(id=>['list','report'].map(op=>`minigame:leaderboard-rate:${appId}:${op}:${id}`)));
  await redis.del(keys);
 });
 await t.test('zero is durably saved but does not enter the ranked Redis index',async()=>{
  assert.deepEqual(await list(),{type:'stage',entries:[],self:{userId:a,rank:null,value:null,nickname:'游客',avatarUrl:''}});
  assert.deepEqual(await report(0),{type:'stage',value:0,rank:null,improved:true});
  const result=await list();assert.equal(result.self.value,0);assert.equal(result.self.rank,null);assert.deepEqual(result.entries,[]);
  assert.equal(await redis.zScore(board(),a),null);assert.equal(await redis.zCard(board()),1);
  assert.deepEqual((await owner.query('SELECT value,dirty FROM game_leaderboard_scores WHERE app_id=$1 AND user_id=$2',[appId,a])).rows[0],{value:0,dirty:false});
 });
 await t.test('rebuild indexes only qualifying scores and still returns an unranked durable maximum',async()=>{
  for(const [type,minimum] of [['stage',101],['boss',30]] as const){
   await owner.query('INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value,dirty) VALUES($1,$2,$3,$6-1,false),($1,$2,$4,$6,false),($1,$2,$5,$6+1,false)',[appId,type,a,b,c,minimum]);
   const result=await list(type);assert.deepEqual(result.entries.map((r:any)=>[r.userId,r.value,r.rank]),[[c,minimum+1,1],[b,minimum,2]]);
   assert.equal(result.self.rank,null);assert.equal(result.self.value,minimum-1);assert.equal(await redis.zScore(board(type),a),null);assert.equal(await redis.zCard(board(type)),3);
   await redis.unlink(board(type));assert.deepEqual((await list(type)).entries,result.entries);
   assert.equal(Number((await owner.query('SELECT count(*) n FROM game_leaderboard_scores WHERE app_id=$1 AND board_type=$2',[appId,type])).rows[0].n),3);
  }
 });
 await t.test('a ready index from the pre-threshold policy is rebuilt before being served',async()=>{
  await report(100);await report(101,'stage',bt);
  const runId=/^run_id:([^\r\n]+)/m.exec(await redis.info('server'))![1]!;
  await redis.zAdd(board(),{score:100,value:a});await redis.set(board()+':epoch',runId);
  const result=await list();assert.deepEqual(result.entries.map((r:any)=>[r.userId,r.value]),[[b,101]]);assert.equal(result.self.rank,null);assert.equal(result.self.value,100);assert.equal(await redis.zScore(board(),a),null);
  assert.equal(await redis.get(board()+':epoch'),runId+':min=101');
 });
 await t.test('stage 101 and boss 30 qualify inclusively without losing lower-score history',async()=>{
  for(const [type,minimum] of [['stage',101],['boss',30]] as const){
   assert.deepEqual(await report(minimum-1,type),{type,value:minimum-1,rank:null,improved:true});
   assert.deepEqual(await report(0,type),{type,value:minimum-1,rank:null,improved:false});
   assert.equal(await redis.zScore(board(type),a),null);assert.equal((await list(type)).self.value,minimum-1);
   assert.deepEqual(await report(minimum,type),{type,value:minimum,rank:1,improved:true});
   assert.deepEqual(await report(minimum-1,type),{type,value:minimum,rank:1,improved:false});
   assert.equal((await list(type)).self.rank,1);assert.equal(await redis.zCard(board(type)),2);
   assert.equal((await report(minimum+1,type)).value,minimum+1);
  }
 });
 await t.test('lowering the old 300/50 thresholds rebuilds clean historical scores into the 101/30 indexes',async()=>{
  const runId=/^run_id:([^\r\n]+)/m.exec(await redis.info('server'))![1]!;
  for(const [type,minimum,oldMinimum] of [['stage',101,300],['boss',30,50]] as const){
   await owner.query('INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value,dirty) VALUES($1,$2,$3,$6,false),($1,$2,$4,$7,false),($1,$2,$5,$6-1,false)',[appId,type,a,b,c,minimum,oldMinimum]);
   await redis.zAdd(board(type),[{score:-1,value:'__ready__'},{score:oldMinimum,value:b}]);
   await redis.set(board(type)+':epoch',runId+':min='+oldMinimum);
   const result=await list(type);
   assert.deepEqual(result.entries.map((r:any)=>[r.userId,r.value,r.rank]),[[b,oldMinimum,1],[a,minimum,2]]);
   assert.equal(result.self.rank,2);assert.equal(result.self.value,minimum);
   assert.equal(await redis.zScore(board(type),c),null);assert.equal(await redis.get(board(type)+':epoch'),runId+':min='+minimum);
  }
 });
 await t.test('pending below-threshold scores are acknowledged without creating ranked members and survive API restart',async()=>{
  await list();await list('boss');
  await owner.query("INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value) VALUES($1,'stage',$2,100),($1,'boss',$2,29)",[appId,a]);
  await until(async()=>Number((await owner.query('SELECT count(*) n FROM game_leaderboard_scores WHERE app_id=$1 AND dirty',[appId])).rows[0].n)===0);
  for(const type of ['stage','boss']){assert.equal(await redis.zScore(board(type),a),null);assert.equal((await list(type)).self.rank,null);}
  await second?.close();second=undefined;await app.close();app=await createApplication(config);await app.listen(0,'127.0.0.1');
  assert.equal((await list()).self.value,100);assert.equal((await list('boss')).self.value,29);assert.deepEqual((await list()).entries,[]);
 });
 await t.test('delayed below-threshold projections cannot remove or lower a concurrently qualified member',{timeout:12000},async()=>{
  second??=await createApplication(config);if(!second.getHttpServer().listening)await second.listen(0,'127.0.0.1');
  const infra=app.get(Infrastructure) as any,original=infra.redis.withCommandOptions;let reached!:()=>void,release!:()=>void;
  const atProjection=new Promise<void>(r=>{reached=r;}),allowed=new Promise<void>(r=>{release=r;});let pending:Promise<any>|undefined;
  try{
   infra.redis.withCommandOptions=function(options:unknown){const api=original.call(this,options);return new Proxy(api,{get(target,key){if(key==='eval')return async(script:string,opts:any)=>{if(script.includes("'ZADD'")&&opts.arguments?.[1]==='100'){reached();await allowed;}return target.eval(script,opts);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};
   pending=report(100);await atProjection;assert.equal((await report(101,'stage',again,second)).rank,1);release();
   const old=await pending;assert.equal(old.value,101);assert.equal(old.rank,1);assert.equal(await redis.zScore(board(),a),101);assert.equal((await list()).self.value,101);
  }finally{release();infra.redis.withCommandOptions=original;if(pending)await Promise.allSettled([pending]);}
 });
 await t.test('historical max is atomic; int32 upper bound is exact and lower/repeated scores are ignored',async()=>{
  assert.equal((await report(10)).improved,true);assert.equal((await report(9)).improved,false);assert.equal((await report(10)).improved,false);
  const max=await report(2147483647);assert.equal(max.value,2147483647);assert.equal((await report(0)).value,2147483647);
  const row=(await owner.query('SELECT value,dirty FROM game_leaderboard_scores WHERE app_id=$1 AND user_id=$2',[appId,a])).rows[0];assert.deepEqual(row,{value:2147483647,dirty:false});
 });
 await t.test('top30 UID ties and self outside top30 match independent PostgreSQL ordering',async()=>{
  const fixtures=(await owner.query("INSERT INTO game_users(app_id,open_id) SELECT $1,'rank_fixture_'||n FROM generate_series(1,45) n RETURNING id",[appId])).rows.map(r=>r.id);
  await owner.query("INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value,dirty) SELECT $1,'stage',id,1000,false FROM game_users WHERE id=ANY($2::uuid[])",[appId,fixtures]);await report(500);
  const expected=(await owner.query("SELECT user_id,value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type='stage' ORDER BY value DESC,user_id DESC LIMIT 30",[appId])).rows;
  const result=await list();assert.equal(result.entries.length,30);assert.equal(result.self.rank,46);assert.equal(result.self.value,500);
  assert.deepEqual(result.entries.map((r:any)=>[r.userId,r.value,r.rank]),expected.map((r:any,i:number)=>[r.user_id,r.value,i+1]));
  assert.equal(result.entries.some((r:any)=>r.userId==='__ready__'),false);
 });
 await t.test('stage and boss and games are isolated; current profile updates are reflected',async()=>{
  await report(515);await report(77,'boss');
  await owner.query("INSERT INTO game_profiles(user_id,nickname,avatar_url) VALUES($1,'张三','https://example.com/a.png') ON CONFLICT(user_id) DO UPDATE SET nickname=EXCLUDED.nickname,avatar_url=EXCLUDED.avatar_url",[a]);
  const value=await list();assert.equal(value.self.value,515);assert.equal(value.self.nickname,'张三');assert.equal(value.self.avatarUrl,'https://example.com/a.png');assert.equal((await list('boss')).self.value,77);
  await owner.query("INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value) VALUES($1,'stage',$2,2147483647)",[foreignApp,foreign]);
  assert.equal((await list()).entries.length,1);
  await owner.query("UPDATE game_profiles SET nickname='改名' WHERE user_id=$1",[a]);assert.equal((await list()).entries[0].nickname,'改名');
 });
 await t.test('invalid type, scores, extra fields, query args and bodies cannot write records',async()=>{
  for(const body of [{},[],{type:'unknown',value:1},{type:'Stage',value:1},{type:'stage',value:-1},{type:'stage',value:0.1},{type:'stage',value:'1'},{type:'stage',value:null},{type:'stage',value:true},{type:'stage',value:2147483648},{type:'stage',value:1,userId:b},{type:'stage',value:1,gameId:'other'}])assert.equal((await call('report',body,token,400)).data.message,'INVALID_LEADERBOARD_REQUEST');
  await call('report?type=stage',{type:'stage',value:1},token,400);await call('list',{type:'stage',limit:31},token,400);await call('list',{},token,400);
  assert.equal(Number((await owner.query('SELECT count(*) n FROM game_leaderboard_scores WHERE app_id=$1',[appId])).rows[0].n),0);
 });
 await t.test('missing/invalid/foreign/nonexistent/incomplete sessions are denied and UUID spelling canonicalized',async()=>{
  for(const access of ['', 'malformed',randomBytes(32).toString('base64url'),await session(null),await session({appId:foreignApp,userId:a}),await session({appId,userId:foreign}),await session({appId,userId:randomUUID()}),await session({appId,userId:'invalid'})])await call('list',{type:'stage'},access,401);
  const incomplete=(await owner.query("INSERT INTO game_users(app_id,open_id,first_login_completed) VALUES($1,'incomplete_lb',false) RETURNING id",[appId])).rows[0].id;
  await call('report',{type:'stage',value:1},await session({appId,userId:incomplete}),401);
  await report(505);const upper=await session({appId,userId:a.toUpperCase()});assert.equal((await list('stage',upper)).self.userId,a);assert.equal((await list('stage',upper)).self.rank,1);
 });
 await t.test('independent report/list quotas are shared across tokens and board types',async()=>{
  for(let i=0;i<60;i++)await report(i,i%2?'stage':'boss',i%2?token:again);
  const denied=await call('report',{type:'stage',value:100},again,429);assert.equal(denied.data.message,'LEADERBOARD_RATE_LIMITED');assert(Number(denied.headers.get('retry-after'))>0);
  await list();await report(1,'stage',bt);
  await redis.del(`minigame:leaderboard-rate:${appId}:list:${a}`);
  for(let i=0;i<60;i++)await list(i%2?'stage':'boss',i%2?token:again);
  await call('list',{type:'stage'},token,429);assert((await redis.ttl(`minigame:leaderboard-rate:${appId}:list:${a}`))>0);
 });
 await t.test('multiple API instances and tokens cannot lose a concurrent maximum',async()=>{
  second??=await createApplication(config);if(!second.getHttpServer().listening)await second.listen(0,'127.0.0.1');
  const values=[1,500,13,400,100,20,499,2,300,5];
  await report(0);
  await Promise.all(values.map((v,i)=>report(v,'stage',i%2?token:again,i%2?app:second)));
  assert.equal((await list()).self.value,500);assert.equal(Number((await owner.query("SELECT value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type='stage' AND user_id=$2",[appId,a])).rows[0].value),500);
 });
 await t.test('missing index rebuilds durable scores and no temporary key becomes the leaderboard',async()=>{
  await report(512);await report(599,'stage',bt);await redis.unlink(board());
  const result=await list();assert.deepEqual(result.entries.map((r:any)=>r.value),[599,512]);assert.equal(result.self.rank,2);assert.equal(await redis.zScore(board(),'__ready__'),-1);assert.equal(await redis.ttl(board()),-1);
 });
 await t.test('database restrictions enforce same-game rows, valid types/values and no runtime delete/DDL',async()=>{
  for(const args of [[appId,'stage',foreign,1],[appId,'bad',a,1],[appId,'stage',a,-1]])await assert.rejects(()=>owner.query('INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value) VALUES($1,$2,$3,$4)',args));
  const rights=(await owner.query("SELECT has_table_privilege($1,'game_leaderboard_scores','SELECT') can_read,has_table_privilege($1,'game_leaderboard_scores','INSERT') can_insert,has_table_privilege($1,'game_leaderboard_scores','UPDATE') can_update,has_table_privilege($1,'game_leaderboard_scores','DELETE') can_delete,has_schema_privilege($1,'public','CREATE') can_ddl",[role])).rows[0];assert.deepEqual(rights,{can_read:true,can_insert:true,can_update:true,can_delete:false,can_ddl:false});
 });
 await t.test('rebuild and a concurrent writer cannot publish an older maximum over the new score',{timeout:12000},async()=>{
  await report(501);second??=await createApplication(config);if(!second.getHttpServer().listening)await second.listen(0,'127.0.0.1');
  const writer=second.get(Infrastructure) as any,reader=app.get(Infrastructure) as any,connect=writer.pool.connect,commands=reader.redis.withCommandOptions;
  let reachedWrite!:()=>void,releaseWrite!:()=>void,reachedPublish!:()=>void,releasePublish!:()=>void;
  const atWrite=new Promise<void>(r=>{reachedWrite=r;}),allowWrite=new Promise<void>(r=>{releaseWrite=r;}),atPublish=new Promise<void>(r=>{reachedPublish=r;}),allowPublish=new Promise<void>(r=>{releasePublish=r;});let writing:Promise<any>|undefined,reading:Promise<any>|undefined,done=false;
  try{
   writer.pool.connect=function(...args:unknown[]){if(args.length)return connect.apply(this,args);return connect.call(this).then((client:any)=>{const query=client.query.bind(client),release=client.release.bind(client);client.query=async(sql:string,...args:unknown[])=>{if(sql.includes('pg_advisory_xact_lock_shared')){reachedWrite();await allowWrite;}return query(sql,...args);};client.release=(discard:boolean)=>{client.query=query;release(discard);};return client;});};
   writing=report(5000,'stage',token,second).then(value=>{done=true;return value;});await atWrite;await redis.unlink(board());
   reader.redis.withCommandOptions=function(options:unknown){const api=commands.call(this,options);return new Proxy(api,{get(target,key){if(key==='eval')return async(script:string,opts:unknown)=>{if(script.includes("'RENAME'")){reachedPublish();await allowPublish;}return target.eval(script,opts);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};
   reading=list();await atPublish;releaseWrite();await new Promise(r=>setTimeout(r,50));assert.equal(done,false,'writer must wait for exclusive rebuild lock');releasePublish();await reading;await writing;
   assert.equal((await list()).self.value,5000);
  }finally{releaseWrite();releasePublish();writer.pool.connect=connect;reader.redis.withCommandOptions=commands;await Promise.allSettled([writing,reading].filter(Boolean) as Promise<any>[]);}
 });
 await t.test('unknown COMMIT result is retryable without lowering or duplicating the durable maximum',async()=>{
  await report(501);const infra=app.get(Infrastructure) as any,connect=infra.pool.connect;
  try{
   infra.pool.connect=function(...args:unknown[]){if(args.length)return connect.apply(this,args);return connect.call(this).then((client:any)=>{const query=client.query.bind(client),release=client.release.bind(client);client.query=async(sql:unknown,...params:unknown[])=>{const result=await query(sql,...params);if(sql==='COMMIT')throw new Error('private-commit-ack-lost');return result;};client.release=(discard:boolean)=>{client.query=query;release(discard);};return client;});};
   const failed=await call('report',{type:'stage',value:700},token,503);assert.equal(failed.data.message,'LEADERBOARD_STORAGE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(failed.data),/private|COMMIT|postgres|stack/);
  }finally{infra.pool.connect=connect;}
  const retry=await report(699);assert.equal(retry.value,700);assert.equal(retry.improved,false);
  assert.equal(Number((await owner.query('SELECT count(*) n FROM game_leaderboard_scores WHERE app_id=$1 AND user_id=$2',[appId,a])).rows[0].n),1);
 });
 await t.test('an older projection acknowledgement cannot clear a newer pending maximum',async()=>{
  await report(501);const infra=app.get(Infrastructure) as any,query=infra.pool.query;let injected=false;
  try{
   infra.pool.query=async function(sql:string,...args:unknown[]){if(!injected&&sql.startsWith('UPDATE game_leaderboard_scores SET dirty=false')){injected=true;await owner.query('UPDATE game_leaderboard_scores SET value=800,dirty=true WHERE app_id=$1 AND user_id=$2',[appId,a]);}return query.call(this,sql,...args);};
   await report(600);
  }finally{infra.pool.query=query;}
  assert.equal(injected,true);assert.deepEqual((await owner.query('SELECT value,dirty FROM game_leaderboard_scores WHERE app_id=$1 AND user_id=$2',[appId,a])).rows[0],{value:800,dirty:true});
  await until(async()=>await redis.zScore(board(),a)===800);
 });
 await t.test('database and Redis dependency failures return only sanitized errors',async()=>{
  await report(501);const infra=app.get(Infrastructure) as any,query=infra.pool.query,connect=infra.pool.connect,commands=infra.redis.withCommandOptions;
  async function failure(){const r=await call('report',{type:'stage',value:515},token,503);assert.equal(r.data.message,'LEADERBOARD_STORAGE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(r.data),/private|SELECT|postgres|stack/);}
  try{infra.pool.query=async()=>{throw new Error('private-pg-query');};await failure();}finally{infra.pool.query=query;}
  try{infra.pool.connect=function(...args:unknown[]){if(args.length)return connect.apply(this,args);return Promise.reject(new Error('private-pg-connect'));};await failure();}finally{infra.pool.connect=connect;}
  for(const operation of ['get','eval'])try{infra.redis.withCommandOptions=function(options:unknown){const api=commands.call(this,options);return new Proxy(api,{get(target,key){if(key===operation)return async()=>{throw new Error('private-redis-transport');};const method=Reflect.get(target,key);return typeof method==='function'?method.bind(target):method;}});};await failure();}finally{infra.redis.withCommandOptions=commands;}
  assert.equal((await list()).self.value,501);
 });
 await t.test('a held rebuild lock returns explicit unavailability, not an invented empty leaderboard',async()=>{
  const client=await owner.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`minigame:leaderboard-lock:${appId}:stage`]);const result=await call('list',{type:'stage'},token,503);assert.equal(result.data.message,'LEADERBOARD_REBUILDING');}finally{await client.query('ROLLBACK');client.release();}
  assert.deepEqual((await list()).entries,[]);
 });
 await t.test('restarted API resumes durable pending work on first leaderboard use',async()=>{
  await second?.close();second=undefined;await app.close();
  await owner.query("INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value) VALUES($1,'stage',$2,821)",[appId,a]);
  await redis.zAdd(board(),{score:-1,value:'__ready__'});
  app=await createApplication(config);await app.listen(0,'127.0.0.1');await list();
  await until(async()=>await redis.zScore(board(),a)===821);assert.equal((await list()).self.value,821);
 });
 await t.test('an older restored Redis generation cannot hide a newer already-acknowledged durable score',async()=>{
  await report(580);await redis.zAdd(board(),{score:1,value:a});await redis.set(board()+':epoch','restored-from-an-older-redis-run');
  assert.equal((await owner.query('SELECT dirty FROM game_leaderboard_scores WHERE app_id=$1 AND user_id=$2',[appId,a])).rows[0].dirty,false);
  assert.equal((await list()).self.value,580);
 });
 await t.test('loss of temporary rebuild members cannot publish a partial leaderboard',async()=>{
  await report(512);await redis.unlink(board());const infra=app.get(Infrastructure) as any,original=infra.redis.withCommandOptions;let injected=false;
  try{infra.redis.withCommandOptions=function(options:unknown){const api=original.call(this,options);return new Proxy(api,{get(target,key){if(key==='eval')return async(script:string,opts:any)=>{if(!injected&&script.includes("'RENAME'")){injected=true;await redis.zRem(opts.keys[0],a);}return target.eval(script,opts);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};await call('list',{type:'stage'},token,503);assert.equal(await redis.exists(board()),0);}finally{infra.redis.withCommandOptions=original;}
  assert.equal((await list()).self.value,512);
 });
 await t.test('rebuild generation fencing prevents an obsolete builder replacing a newer index',async()=>{
  await report(512);await redis.unlink(board());const infra=app.get(Infrastructure) as any,original=infra.redis.withCommandOptions;let injected=false;
  try{
   infra.redis.withCommandOptions=function(options:unknown){const api=original.call(this,options);return new Proxy(api,{get(target,key){if(key==='eval')return async(script:string,opts:any)=>{
    if(!injected&&script.includes("'RENAME'")){injected=true;await redis.set(board()+':rebuild-owner','newer-generation',{EX:60});await redis.zAdd(board(),[{score:-1,value:'__ready__'},{score:500,value:b}]);}
    return target.eval(script,opts);
   };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};
   await call('list',{type:'stage'},token,503);assert.equal(injected,true);assert.equal(await redis.zScore(board(),b),500);assert.equal(await redis.get(board()+':rebuild-owner'),'newer-generation');
  }finally{infra.redis.withCommandOptions=original;await redis.unlink(board()+':rebuild-owner');}
 });
 await t.test('committed scores survive Redis projection failure and synchronize autonomously',async()=>{
  await report(501);const infra=app.get(Infrastructure) as any,original=infra.redis.withCommandOptions;
  try{
   infra.redis.withCommandOptions=function(options:unknown){const api=original.call(this,options);return new Proxy(api,{get(target,key){if(key==='eval')return async(script:string,opts:unknown)=>{if(script.includes("'ZADD'"))throw new Error('private-projection-failure');return target.eval(script,opts);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});};
   const failure=await call('report',{type:'stage',value:580},token,503);assert.equal(failure.data.message,'LEADERBOARD_STORAGE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(failure.data),/private|postgres|stack/);
  }finally{infra.redis.withCommandOptions=original;}
  const pending=(await owner.query('SELECT value,dirty FROM game_leaderboard_scores WHERE app_id=$1 AND user_id=$2',[appId,a])).rows[0];assert.deepEqual(pending,{value:580,dirty:true});
  await until(async()=>await redis.zScore(board(),a)===580);
  assert.equal((await list()).self.value,580);
 });
});
