import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createClient} from 'redis';
import {loadConfig} from '../src/config.js';
import {migrate} from '../src/database/migrate.js';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {createApplication}=await import(process.env.MINIGAME_TEST_DIST_DIR?pathToFileURL(resolve(process.env.MINIGAME_TEST_DIST_DIR,'application.js')).href:'../src/application.js');
const templateId='2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4';
test('subscription reports use authenticated staging feature gate and restricted PostgreSQL role',async t=>{
 const owner=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});
 const redis=createClient({url:'redis://127.0.0.1:16389/15'});redis.on('error',()=>{});
 const appId='wx'+randomBytes(8).toString('hex'),role='subscribe_'+randomBytes(6).toString('hex');
 let app:any,disabled:any,roleCreated=false;const tokens:string[]=[];
 t.after(async()=>{await app?.close();await disabled?.close();if(redis.isOpen){await redis.flushDb();await redis.quit();}await owner.query('DELETE FROM game_users WHERE app_id=$1',[appId]);if(roleCreated){await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);}await owner.end();});
 await migrate(owner);await redis.connect();await redis.flushDb();
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-subscribe-test-only'`);roleCreated=true;
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await owner.query(`GRANT SELECT ON game_users TO ${role}`);
 if((await owner.query("SELECT to_regclass('game_subscription_reports') name")).rows[0].name)await owner.query(`GRANT SELECT,INSERT ON game_subscription_reports TO ${role}`);
 const uid=(await owner.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'subscribe_fixture') RETURNING id",[appId])).rows[0].id;
 async function token(payload:unknown){const value=randomBytes(32).toString('base64url'),key='minigame:session:'+createHash('sha256').update(value).digest('hex');tokens.push(key);await redis.set(key,JSON.stringify(payload),{EX:120});return value;}
 const access=await token({appId,userId:uid}),config=loadConfig({SUBSCRIBE_MESSAGES_ENABLED:'true',WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'isolated-subscribe-stub',DATABASE_URL:`postgresql://${role}:isolated-subscribe-test-only@127.0.0.1:15439/minigame_test`,REDIS_URL:'redis://127.0.0.1:16389/15'});
 app=await createApplication(config);await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/subscriptions/checkin/`;
 async function call(path:string,body:unknown,auth:string|undefined=access,status=200){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+auth}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const data=await r.json() as any;assert.equal(r.status,status,JSON.stringify(data));assert.equal(r.headers.get('cache-control'),'no-store');return {data,headers:r.headers};}
 const first=(await call('report',{eventId:randomUUID(),templateId,status:'accept'})).data;
 assert.equal(first.status,'accept');assert.equal(first.templateId,templateId);assert.equal(first.alreadyRecorded,false);assert(Number.isFinite(Date.parse(first.recordedAt)));
 await t.test('template metadata preserves exact ID, values and one-time trial contract',async()=>{
  const {data}=await call('template',{});assert.deepEqual(data,{templateId,templateNumber:85,type:'once',miniprogramState:'trial',data:{phrase1:{value:'未签到'},thing10:{value:'签到领海量奖励'},thing5:{value:'您的猫咪提示您有海量钻石待领取'}}});
 });
 await t.test('idempotent status reports never grant server-verified subscription credit',async()=>{
  const body={eventId:first.eventId,templateId,status:'accept'};
  assert.deepEqual((await call('report',body)).data,{...first,alreadyRecorded:true});
  assert.equal((await call('report',{...body,status:'reject'},access,409)).data.message,'SUBSCRIPTION_REPORT_CONFLICT');
  const eventId=randomUUID(),copies=await Promise.all(Array.from({length:8},()=>call('report',{eventId,templateId,status:'reject'})));
  assert.equal(copies.filter(x=>!x.data.alreadyRecorded).length,1);assert.equal(new Set(copies.map(x=>x.data.recordedAt)).size,1);
  for(const status of ['ban','filter'])await call('report',{eventId:randomUUID(),templateId,status});
  const columns=(await owner.query("SELECT column_name FROM information_schema.columns WHERE table_name='game_subscription_reports'")).rows.map(x=>x.column_name);assert(!columns.some(x=>/credit|quota|verified/.test(x)));
 });
 await t.test('identity, template and input overrides are rejected',async()=>{
  const body={eventId:randomUUID(),templateId,status:'accept'};
  for(const value of [{},[],{...body,eventId:'bad'},{...body,status:'ok'},{...body,templateId:'other'},{...body,userId:uid},{...body,openid:'spoof'},{...body,appId},{...body,recordedAt:'fake'}])await call('report',value,access,400);
  await call('report?uid='+uid,body,access,400);await call('template',{userId:uid},access,400);
  for(const invalid of ['',randomBytes(32).toString('base64url'),await token({appId:'wx0000000000000000',userId:uid}),await token({appId,userId:randomUUID()})])await call('report',body,invalid,401);
  await call('send',{userId:uid},access,404);
 });
 await t.test('rate limits are per authenticated user and do not change report data',async()=>{
  const key=`minigame:subscribe-rate:${appId}:${uid}`;await redis.del(key);
  for(let i=0;i<60;i++)await call('template',{});
  const result=await call('template',{},access,429);assert.equal(result.data.message,'SUBSCRIPTION_RATE_LIMITED');assert(Number(result.headers.get('retry-after'))>0);await redis.del(key);
 });
 await t.test('feature disabled leaves no public subscription routes and creates no send worker',async()=>{
  disabled=await createApplication({...config,subscribeMessagesEnabled:false});await disabled.listen(0,'127.0.0.1');
  const r=await fetch(`http://127.0.0.1:${disabled.getHttpServer().address().port}/h5login/api/subscriptions/checkin/template`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+access},body:'{}',signal:AbortSignal.timeout(8000)});assert.equal(r.status,404);
  const rights=(await owner.query("SELECT has_table_privilege($1,'game_subscription_reports','INSERT') i,has_table_privilege($1,'game_subscription_reports','UPDATE') u,has_table_privilege($1,'game_subscription_reports','DELETE') d",[role])).rows[0];assert.deepEqual(rights,{i:true,u:false,d:false});
 });
});
