import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import {loadConfig} from '../src/config.js';
import {migrate} from '../src/database/migrate.js';

test('compiled rewarded-video completion HTTP records authenticated player events with restricted storage role',async t=>{
 const owner=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'}),role='video_'+randomBytes(6).toString('hex'),appId='wx'+randomBytes(8).toString('hex');
 const redis=createClient({url:'redis://127.0.0.1:16389/15'});redis.on('error',()=>{});
 let app:any,created=false;
 t.after(async()=>{await app?.close();if(redis.isOpen){await redis.flushDb();await redis.quit();}await owner.query('DELETE FROM game_users WHERE app_id=$1',[appId]);if(created){await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);}await owner.end();});
 await migrate(owner);await redis.connect();await redis.flushDb();
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-video-test-only'`);created=true;
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
 await owner.query(`GRANT SELECT,INSERT,UPDATE ON game_users TO ${role}`);
 await owner.query(`GRANT SELECT,INSERT ON game_daily_logins TO ${role}`);
 await owner.query(`GRANT INSERT ON game_login_events TO ${role}`);
 await owner.query(`GRANT SELECT ON game_profiles TO ${role}`);
 if((await owner.query("SELECT to_regclass('game_rewarded_video_events') AS name")).rows[0].name)await owner.query(`GRANT SELECT,INSERT ON game_rewarded_video_events TO ${role}`);
 const build=resolve(process.env.MINIGAME_TEST_DIST_DIR??'dist');
 const {createApplication}=await import(pathToFileURL(resolve(build,'application.js')).href);
 const {WechatClient}=await import(pathToFileURL(resolve(build,'auth/wechat.client.js')).href);
 const config=loadConfig({WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'explicit-video-test-stub',DATABASE_URL:`postgresql://${role}:isolated-video-test-only@127.0.0.1:15439/minigame_test`,REDIS_URL:'redis://127.0.0.1:16389/15'});
 const wechat=new WechatClient(config,async(input:URL|RequestInfo)=>Response.json({openid:new URL(String(input)).searchParams.get('js_code'),session_key:'video-test-only-never-return'}));
 app=await createApplication(config,{wechat});await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/`;
 async function call(path:string,body:unknown,token?:string,expected=200){const r=await fetch(base+path,{signal:AbortSignal.timeout(8000),method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const data=await r.json() as any;assert.equal(r.status,expected,`${path} => ${JSON.stringify(data)}`);assert.equal(r.headers.get('cache-control'),'no-store');return {data,headers:r.headers};}
 const login=async(code:string,clientInstanceId?:string)=>(await call('auth/wechat-login',{code,...(clientInstanceId?{clientInstanceId}:{})})).data;
 const a=await login('video_a_'+role),b=await login('video_b_'+role),path='analytics/rewarded-video/completed';
 t.beforeEach(async()=>{await redis.del([`minigame:rewarded-video-rate:${appId}:${a.user.id}`,`minigame:rewarded-video-rate:${appId}:${b.user.id}`]);});
 const payload={eventId:randomUUID(),placement:'revive',clientInfo:{level:12,adUnitId:'test-ad-unit',nested:{value:'中文'},clientCompletedAt:'2000-01-01T00:00:00Z'}};
 const before=Date.now(),first=(await call(path,payload,a.accessToken)).data;
 assert.deepEqual(Object.keys(first).sort(),['alreadyRecorded','eventId','placement','recordedAt','userId']);assert.equal(first.alreadyRecorded,false);assert.equal(first.eventId,payload.eventId);assert.equal(first.userId,a.user.id);assert.equal(first.placement,'revive');assert(Date.parse(first.recordedAt)>=before-1000&&Date.parse(first.recordedAt)<=Date.now()+1000);
 const row=(await owner.query('SELECT * FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[appId,a.user.id,payload.eventId])).rows[0];assert.deepEqual(row.client_info,payload.clientInfo);assert.equal(row.recorded_at.toISOString(),first.recordedAt);
 await t.test('不同实例登录、广告事件关联与跨会话重试保留首次归属',async()=>{
  const instanceA=randomUUID()+'_ios_apple_iphone15,2',instanceB=randomUUID()+'_android_xiaomi_23049rad8c',code='identity_'+role;
  const a=await login(code,instanceA),b=await login(code,instanceB);
  const events=(await owner.query('SELECT client_instance_id,session_id FROM game_login_events WHERE app_id=$1 AND user_id=$2 ORDER BY login_at',[appId,a.user.id])).rows;
  assert.equal(events.length,2);assert.equal(events[0].client_instance_id,instanceA);assert.equal(events[1].client_instance_id,instanceB);
  assert.notEqual(events[0].session_id,events[1].session_id);
  const event={eventId:randomUUID(),placement:'Fish_Gacha'};
  await call(path,event,a.accessToken);await call(path,event,b.accessToken);
  const row=(await owner.query('SELECT client_instance_id,session_id FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[appId,a.user.id,event.eventId])).rows[0];
  assert.equal(row.client_instance_id,instanceA);assert.equal(row.session_id,events[0].session_id);
  await call('auth/wechat-login',{code,clientInstanceId:'bad'},undefined,400);
  await call('auth/wechat-login',{code,clientInstanceId:null},undefined,400);
  for (const tail of ['_ios_apple', '_ios_apple_bad\n', '_ios_apple_'+ 'x'.repeat(41), '_ios_apple_<script>']) await call('auth/wechat-login',{code,clientInstanceId:randomUUID()+tail},undefined,400);
 });
 await t.test('same completed event retries are idempotent and changed payload is rejected',async()=>{
  assert.deepEqual((await call(path,payload,a.accessToken)).data,{...first,alreadyRecorded:true});
  assert.deepEqual((await call(path,{...payload,clientInfo:{clientCompletedAt:payload.clientInfo.clientCompletedAt,nested:{value:'中文'},adUnitId:'test-ad-unit',level:12}},a.accessToken)).data,{...first,alreadyRecorded:true});
  assert.equal((await call(path,{...payload,placement:'different'},a.accessToken,409)).data.message,'REWARDED_VIDEO_EVENT_CONFLICT');
  await call(path,{...payload,clientInfo:{level:13}},a.accessToken,409);
  const stored=(await owner.query('SELECT placement,client_info FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[appId,a.user.id,payload.eventId])).rows[0];assert.equal(stored.placement,'revive');assert.deepEqual(stored.client_info,payload.clientInfo);
 });
 await t.test('invalid or oversized client payload is rejected before any event is stored',async()=>{
  const count=async()=>Number((await owner.query('SELECT count(*) n FROM game_rewarded_video_events WHERE app_id=$1',[appId])).rows[0].n),before=await count();
  let tooDeep:any={};for(let i=0;i<9;i++)tooDeep={nested:tooDeep};
  const invalid:unknown[]=[{},[],{eventId:randomUUID()}, {...payload,eventId:'not-uuid'}, {...payload,userId:b.user.id}, {...payload,openid:'spoof'}, {...payload,recordedAt:'2000-01-01'}, {...payload,placement:''}, {...payload,placement:' revive'}, {...payload,placement:'revive '}, {...payload,placement:'a\nb'}, {...payload,placement:'\u0085'}, {...payload,placement:'x'.repeat(65)}, {...payload,placement:'\ud800'}, {...payload,clientInfo:null}, {...payload,clientInfo:[]}, {...payload,clientInfo:'bad'}, {...payload,clientInfo:{text:'x'.repeat(8182)}}, {...payload,clientInfo:{bad:'\u0000'}}, {...payload,clientInfo:{'\u0000':'bad'}}, {...payload,clientInfo:{bad:'\ud800'}}, {...payload,clientInfo:tooDeep}];
  for(const body of invalid)assert.equal((await call(path,body,a.accessToken,400)).data.message,'INVALID_REWARDED_VIDEO_REQUEST');
  await call(path+'?userId='+b.user.id,payload,a.accessToken,400);
  assert.equal(await count(),before);
 });
 await t.test('valid Unicode, metadata size and nesting boundaries retain full client JSON',async()=>{
  const edge={eventId:randomUUID(),placement:'😀'.repeat(64),clientInfo:{text:'x'.repeat(8181)}};
  assert.equal(Buffer.byteLength(JSON.stringify(edge.clientInfo)),8192);
  const result=(await call(path,edge,a.accessToken)).data;assert.equal(result.placement,edge.placement);
  let depthEight:any={};for(let i=0;i<8;i++)depthEight={nested:depthEight};
  await call(path,{eventId:randomUUID(),placement:'复活',clientInfo:depthEight},a.accessToken);
  const simple={eventId:randomUUID(),placement:'daily_reward'};const first=(await call(path,simple,a.accessToken)).data;
  assert.deepEqual((await call(path,{...simple,clientInfo:{}},a.accessToken)).data,{...first,alreadyRecorded:true});
 });
 await t.test('concurrent retries across login tokens store exactly one event while other players are independent',async()=>{
  const again=await login('video_a_'+role),event={eventId:randomUUID(),placement:'concurrent',clientInfo:{value:1}};
  const results=await Promise.all(Array.from({length:12},(_,i)=>call(path,event,i%2?a.accessToken:again.accessToken)));
  assert.equal(results.filter(r=>!r.data.alreadyRecorded).length,1);assert.equal(new Set(results.map(r=>r.data.recordedAt)).size,1);
  assert.equal(Number((await owner.query('SELECT count(*) n FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[appId,a.user.id,event.eventId])).rows[0].n),1);
  const other=(await call(path,event,b.accessToken)).data;assert.equal(other.alreadyRecorded,false);assert.equal(other.userId,b.user.id);
 });
 await t.test('missing, malformed, foreign-app, nonexistent and incomplete player sessions are rejected',async()=>{
  await call(path,payload,undefined,401);await call(path,payload,'malformed',401);await call(path,payload,randomBytes(32).toString('base64url'),401);
  async function session(value:unknown){const token=randomBytes(32).toString('base64url');await redis.set('minigame:session:'+createHash('sha256').update(token).digest('hex'),JSON.stringify(value),{EX:60});return token;}
  await call(path,payload,await session({appId:'wx0000000000000000',userId:a.user.id}),401);
  await call(path,payload,await session({appId,userId:randomUUID()}),401);
  await call(path,payload,await session({appId,userId:'invalid'}),401);
  const incomplete=(await owner.query("INSERT INTO game_users(app_id,open_id,first_login_completed) VALUES($1,'incomplete',false) RETURNING id",[appId])).rows[0].id;
  await call(path,payload,await session({appId,userId:incomplete}),401);
  await owner.query('DELETE FROM game_users WHERE id=$1',[incomplete]);
 });
 await t.test('request parser and unsafe numeric metadata produce sanitized errors',async()=>{
  for(const [body,status,message]of [['{bad-client-body',400,'INVALID_JSON'],['null',400,'INVALID_JSON'],[JSON.stringify({...payload,eventId:randomUUID(),clientInfo:{text:'x'.repeat(17000)}}),413,'REQUEST_TOO_LARGE'],[`{"eventId":"${randomUUID()}","placement":"revive","clientInfo":{"value":1e400}}`,400,'INVALID_REWARDED_VIDEO_REQUEST']] as const){
   const r=await fetch(base+path,{signal:AbortSignal.timeout(8000),method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+a.accessToken},body});const data=await r.json() as any;assert.equal(r.status,status);assert.equal(data.message,message);assert.doesNotMatch(JSON.stringify(data),/bad-client-body|stack|postgres/);
  }
 });
 await t.test('rate limit is shared across tokens, has Retry-After and does not duplicate events',async()=>{
  const again=await login('video_a_'+role),event={eventId:randomUUID(),placement:'rate_test'};
  for(let i=0;i<60;i++)await call(path,event,i%2?a.accessToken:again.accessToken);
  const denied=await call(path,event,again.accessToken,429);assert.equal(denied.data.message,'REWARDED_VIDEO_RATE_LIMITED');assert(Number(denied.headers.get('retry-after'))>0);
  assert.equal(Number((await owner.query('SELECT count(*) n FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[appId,a.user.id,event.eventId])).rows[0].n),1);
  assert((await redis.ttl(`minigame:rewarded-video-rate:${appId}:${a.user.id}`))>0);
  await call(path,event,b.accessToken);
 });
 await t.test('database and Redis failures are sanitized and uncertain commits remain safely retryable',async()=>{
  const {Infrastructure}=await import(pathToFileURL(resolve(build,'infrastructure.js')).href),infra=app.get(Infrastructure) as any;
  const event={eventId:randomUUID(),placement:'storage_failure'},assertFailure=async()=>{const r=(await call(path,event,a.accessToken,503)).data;assert.equal(r.message,'REWARDED_VIDEO_STORAGE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(r),/private-storage|SELECT|INSERT|stack|postgres/);};
  const query=infra.pool.query,connect=infra.pool.connect,commands=infra.redis.withCommandOptions;
  try{infra.pool.query=async()=>{throw new Error('private-storage-query');};await assertFailure();}finally{infra.pool.query=query;}
  try{infra.pool.connect=function(...args:unknown[]){if(args.length)return connect.apply(this,args);return Promise.reject(new Error('private-storage-connect'));};await assertFailure();}finally{infra.pool.connect=connect;}
  for(const operation of ['get','eval']){
   try{infra.redis.withCommandOptions=function(options:unknown){const api=commands.call(this,options);return new Proxy(api,{get(target,key){if(key===operation)return async()=>{throw new Error('private-storage-redis');};const method=Reflect.get(target,key);return typeof method==='function'?method.bind(target):method;}});};await assertFailure();}finally{infra.redis.withCommandOptions=commands;}
  }
  assert.equal(Number((await owner.query('SELECT count(*) n FROM game_rewarded_video_events WHERE app_id=$1 AND event_id=$2',[appId,event.eventId])).rows[0].n),0);
  try{
   infra.pool.connect=function(...connectArgs:unknown[]){if(connectArgs.length)return connect.apply(this,connectArgs);return connect.call(this).then((client:any)=>{const raw=client.query.bind(client);client.query=async function(sql:unknown,...args:unknown[]){const result=await raw(sql,...args);if(sql==='COMMIT')throw new Error('private-storage-commit-response-lost');return result;};const release=client.release.bind(client);client.release=(discard:boolean)=>{client.query=raw;release(discard);};return client;});};
   await assertFailure();
  }finally{infra.pool.connect=connect;}
  const receipt=(await call(path,event,a.accessToken)).data;assert.equal(receipt.alreadyRecorded,true);
  assert.equal(Number((await owner.query('SELECT count(*) n FROM game_rewarded_video_events WHERE app_id=$1 AND event_id=$2',[appId,event.eventId])).rows[0].n),1);
 });
 await t.test('schema rejects wrong-game players and malformed rows while runtime has append-only rights',async()=>{
  const rights=(await owner.query("SELECT has_table_privilege($1,'game_rewarded_video_events','SELECT') can_read,has_table_privilege($1,'game_rewarded_video_events','INSERT') can_insert,has_table_privilege($1,'game_rewarded_video_events','UPDATE') can_update,has_table_privilege($1,'game_rewarded_video_events','DELETE') can_delete,has_schema_privilege($1,'public','CREATE') can_ddl",[role])).rows[0];assert.deepEqual(rights,{can_read:true,can_insert:true,can_update:false,can_delete:false,can_ddl:false});
  const foreignApp='wx'+randomBytes(8).toString('hex');const foreign=(await owner.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'foreign_video') RETURNING id",[foreignApp])).rows[0].id;
  try{await assert.rejects(()=>owner.query("INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) VALUES($1,$2,$3,'wrong_game')",[appId,foreign,randomUUID()]),(e:any)=>e.code==='23503');}finally{await owner.query('DELETE FROM game_users WHERE id=$1',[foreign]);}
  for(const [placement,info]of [['',{}],[' leading',{}],['a\nb',{}],['valid',[]],['valid',{text:'x'.repeat(17000)}]] as const)await assert.rejects(()=>owner.query('INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,client_info) VALUES($1,$2,$3,$4,$5)',[appId,a.user.id,randomUUID(),placement,JSON.stringify(info)]),(e:any)=>e.code==='23514');
  const indexes=(await owner.query("SELECT indexdef FROM pg_indexes WHERE tablename='game_rewarded_video_events'")).rows.map(r=>r.indexdef).join('\n');assert.match(indexes,/app_id, recorded_at DESC/);assert.match(indexes,/app_id, placement, recorded_at DESC/);
 });
});
