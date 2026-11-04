import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import {createHash,randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import request from 'supertest';
import type {Request} from 'express';
import {DataService} from '../src/data/data.service.js';
import type {AppConfig} from '../src/config.js';
import type {Infrastructure} from '../src/infrastructure.js';
import {migrate} from '../src/database/migrate.js';

// Reuse ONLY the existing fixed isolated-test constant, never production config.
const fixtureSource=readFileSync(new URL('./dashboard-save-repair.integration.ts',import.meta.url),'utf8');
const connectionString=/const url='([^']+)'/.exec(fixtureSource)?.[1];
assert.ok(connectionString,'existing isolated PG test URL must be present');
const storage=new URL(connectionString);
assert.equal(storage.hostname,'127.0.0.1');assert.equal(storage.port,'15439');assert.equal(storage.pathname,'/minigame_test');
const moduleUrl=new URL('../dashboard/save-repair.mjs',import.meta.url).href;
const {createSaveRepair}=await import(moduleUrl);
const {createDashboardServer}=await import(new URL('../dashboard/backend.js',import.meta.url).href);
const ledger={Dia:20,_getDia:960,_useDia:900};
const raw='{\n  "Dia" : 20, "_getDia" : 960, "_useDia" : 900,\n  "Is_Remove_AD_All": false, "huge":900719925474099312345,\n  "nested":{"Dia":777,"_getDia":123,"_useDia":456}, "text":"钻石\\n 原文"\n}\t\n';
const expectedRaw=raw.replace('"Dia" : 20','"Dia" : 10020').replace('"_getDia" : 960','"_getDia" : 30960');
const fingerprint=(data:string)=>createHash('sha256').update(data).digest('hex');
const compensation={amount:10000,before:ledger,after:{Dia:10020,_getDia:30960,_useDia:900},delta:{Dia:10000,_getDia:30000,_useDia:0}};
function errorIs(code:string,status:number){return (error:unknown)=>{assert.equal((error as Error).message,code);assert.equal((error as {status:number}).status,status);return true;};}
function memoryRedis(){const values=new Map<string,string>();return {values,withCommandOptions(){return this;},async get(key:string){return values.get(key)??null;},async set(key:string,value:string){values.set(key,value);return 'OK';},async del(key:string){return values.delete(key)?1:0;},async eval(){return 1;}};}

test('three-times diamond ledger: real isolated PG18, restricted roles and authenticated HTTP',{timeout:120000},async t=>{
 const owner=new Pool({connectionString,max:3,statement_timeout:5000});
 const tag=randomBytes(5).toString('hex'),reader='diamond_r_'+tag,writer='diamond_w_'+tag,password=randomBytes(20).toString('hex');
 const roles:string[]=[],apps:string[]=[],uids:string[]=[];let readPool:Pool|undefined,writePool:Pool|undefined;
 t.after(async()=>{
  await readPool?.end();await writePool?.end();
  try{if(apps.length){await owner.query('DELETE FROM game_dashboard_save_repairs WHERE app_id=ANY($1::varchar[])',[apps]);await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])',[apps]);}
   for(const role of roles){await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);}
   assert.equal((await owner.query('SELECT 1 FROM game_dashboard_save_repairs WHERE app_id=ANY($1::varchar[])',[apps])).rowCount,0);
   assert.equal((await owner.query('SELECT 1 FROM game_users WHERE app_id=ANY($1::varchar[])',[apps])).rowCount,0);
   assert.equal((await owner.query('SELECT 1 FROM game_saves WHERE user_id=ANY($1::uuid[])',[uids])).rowCount,0);
   assert.equal((await owner.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])',[roles])).rowCount,0);
   t.diagnostic('Cleanup readback verified: no fixture users/saves/audits and no temporary roles remain.');
  }finally{await owner.end();}
 });
 const version=(await owner.query('SHOW server_version_num')).rows[0].server_version_num;
 assert.ok(Number(version)>=180000&&Number(version)<190000,'must use isolated PostgreSQL 18');
 await migrate(owner);
 for(const role of [reader,writer]){await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);roles.push(role);await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await owner.query(`GRANT SELECT ON game_users,game_profiles,game_saves TO ${role}`);}
 await owner.query(`ALTER ROLE ${reader} SET default_transaction_read_only=on`);
 await owner.query(`GRANT UPDATE(data,version,updated_at) ON game_saves TO ${writer}`);
 await owner.query(`GRANT SELECT,INSERT ON game_dashboard_save_repairs TO ${writer}`);
 const poolFor=(role:string)=>{const url=new URL(connectionString);url.username=role;url.password=password;return new Pool({connectionString:url.href,max:5,statement_timeout:5000});};
 readPool=poolFor(reader);writePool=poolFor(writer);
 assert.equal((await readPool.query('SELECT current_user')).rows[0].current_user,reader);
 assert.equal((await writePool.query('SELECT current_user')).rows[0].current_user,writer);
 assert.equal((await readPool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
 async function fixture(data=raw){
  const app='diamond_'+randomBytes(8).toString('hex'),uid=randomUUID(),openid='diamond_player';apps.push(app);uids.push(uid);
  await owner.query('INSERT INTO game_users(id,app_id,open_id,first_login_completed) VALUES($1,$2,$3,true)',[uid,app,openid]);
  await owner.query('INSERT INTO game_saves(user_id,data,version) VALUES($1,$2,5)',[uid,data]);
  const service=createSaveRepair({pool:readPool,writePool,appId:app,enabled:true});
  const base={openid,version:5,fingerprint:fingerprint(data),changes:{addDia:10000}};
  const operation={...base,requestId:randomUUID(),reason:'三倍钻石补偿：客服工单 001'};
  const stored=async()=>(await owner.query('SELECT data,version,updated_at FROM game_saves WHERE user_id=$1',[uid])).rows[0];
  const audits=async()=>(await owner.query('SELECT * FROM game_dashboard_save_repairs WHERE app_id=$1 ORDER BY created_at',[app])).rows;
  const initial=await stored();
  const unchanged=async()=>{assert.deepEqual(await stored(),initial);assert.deepEqual(await audits(),[]);};
  return {app,uid,openid,service,base,operation,stored,audits,initial,unchanged};
 }
 async function http(sub:TestContext,f:Awaited<ReturnType<typeof fixture>>){
  const redis=memoryRedis(),salt='0123456789abcdef0123456789abcdef',pw='diamond-ledger-test-only';
  const config={username:'ledger_admin',passwordHash:salt+':'+scryptSync(pw,salt,64).toString('hex'),appId:f.app,origin:'https://diamond.example.test',basePath:'/h5dashboard/',saveRepairEnabled:true};
  const server=createDashboardServer({pool:readPool,redis,config,queries:{overview:async()=>({}),player:async()=>null},saveRepair:f.service});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  sub.after(()=>new Promise<void>((resolve,reject)=>server.close((error?:Error)=>error?reject(error):resolve())));
  const api=request(server),login=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:config.username,password:pw}).expect(200);
  const cookie=String(login.headers['set-cookie']?.[0]??'').split(';')[0]!;assert.ok(cookie.includes('__Secure-minigame-dashboard='));
  const post=(action:string,body:object)=>api.post('/h5dashboard/api/save-repair/'+action).set('Cookie',cookie).set('Origin',config.origin).send(body);
  return {api,post,cookie,config};
 }
 await t.test('normal 20/960/900 +10000 previews delta, persists exact bytes and a complete receipt',async()=>{
  const f=await fixture(),preview=await f.service.preview(f.base);
  assert.deepEqual(preview.before,{...ledger,Is_Remove_AD_All:false});
  assert.deepEqual(preview.after,{...compensation.after,Is_Remove_AD_All:false});
  assert.deepEqual(preview.delta,compensation.delta);await f.unchanged();
  const result=await f.service.apply(f.operation,'ledger_admin'),stored=await f.stored(),audit=await f.audits();
  assert.equal(result.save.version,6);assert.equal(stored.version,6);assert.equal(stored.data,expectedRaw);
  assert.deepEqual(Buffer.from(stored.data),Buffer.from(expectedRaw));
  assert.deepEqual(result.diamondCompensation,compensation);assert.equal(audit.length,1);
  const row=audit[0];assert.equal(row.app_id,f.app);assert.equal(row.user_id,f.uid);assert.equal(row.actor,'ledger_admin');assert.equal(row.reason,f.operation.reason);assert.equal(row.request_id,f.operation.requestId);
  assert.equal(row.before_version,5);assert.equal(row.after_version,6);assert.equal(row.before_data,raw);assert.equal(row.after_data,expectedRaw);
  assert.match(row.request_hash,/^[a-f0-9]{64}$/);assert.ok(row.created_at instanceof Date);assert.ok(Number.isFinite(row.created_at.getTime()));
  assert.deepEqual(row.result,result);assert.deepEqual(row.result.diamondCompensation,compensation);
 });
 await t.test('restricted reader and writer cannot mutate unrelated columns or existing audit receipts',async()=>{
  const f=await fixture();
  await assert.rejects(()=>readPool!.query('UPDATE game_saves SET version=version+1 WHERE user_id=$1',[f.uid]));
  await assert.rejects(()=>writePool!.query('DELETE FROM game_saves WHERE user_id=$1',[f.uid]));
  await assert.rejects(()=>writePool!.query('UPDATE game_users SET open_id=$1 WHERE id=$2',['tampered',f.uid]));
  await assert.rejects(()=>writePool!.query('UPDATE game_dashboard_save_repairs SET actor=$1 WHERE app_id=$2',['tampered',f.app]));
  await assert.rejects(()=>writePool!.query('DELETE FROM game_dashboard_save_repairs WHERE app_id=$1',[f.app]));
  await f.unchanged();
 });
 await t.test('identical concurrent request grants once, persists once and returns the original receipt on retry',async()=>{
  const f=await fixture(),results=await Promise.all(Array.from({length:6},()=>f.service.apply(f.operation,'ledger_admin')));
  assert.equal(results.filter(r=>!r.alreadyApplied).length,1);assert.equal(results.filter(r=>r.alreadyApplied).length,5);
  const original=results.find(r=>!r.alreadyApplied);assert.ok(original);
  for(const result of results)assert.deepEqual({...result,alreadyApplied:false},original);
  assert.deepEqual(await f.service.apply(f.operation,'ledger_admin'),{...original,alreadyApplied:true});
  assert.equal((await f.stored()).data,expectedRaw);assert.equal((await f.stored()).version,6);assert.equal((await f.audits()).length,1);
 });
 for(const conflict of ['reason','amount','actor'] as const)await t.test('same request ID with different '+conflict+' is rejected without another grant',async()=>{
  const f=await fixture(),first=await f.service.apply(f.operation,'ledger_admin'),saved=await f.stored(),audits=await f.audits();
  const retry=conflict==='reason'?{...f.operation,reason:'different reason'}:conflict==='amount'?{...f.operation,changes:{addDia:10001}}:f.operation;
  await assert.rejects(()=>f.service.apply(retry,conflict==='actor'?'other_admin':'ledger_admin'),errorIs('SAVE_REPAIR_REQUEST_CONFLICT',409));
  assert.deepEqual(await f.stored(),saved);assert.deepEqual(await f.audits(),audits);assert.deepEqual(audits[0].result,first);
 });
 await t.test('different request IDs racing at one version have exactly one winner',async()=>{
  const f=await fixture(),requests=[f.operation,{...f.operation,requestId:randomUUID()}];
  const results=await Promise.allSettled(requests.map(operation=>f.service.apply(operation,'ledger_admin')));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const loser=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.ok(loser);errorIs('SAVE_REPAIR_VERSION_CONFLICT',409)(loser.reason);
  assert.equal((await f.stored()).version,6);assert.equal((await f.stored()).data,expectedRaw);assert.equal((await f.audits()).length,1);
 });
 await t.test('authenticated actual DataService.save after preview invalidates apply and preserves uploaded bytes',async()=>{
  const f=await fixture();await f.service.preview(f.base);
  const token=randomBytes(32).toString('base64url'),redis=memoryRedis();
  redis.values.set('minigame:session:'+fingerprint(token),JSON.stringify({appId:f.app,userId:f.uid}));
  const clientRedis={...redis,async eval(){return [1,60];}};
  const dataService=new DataService({appId:f.app} as AppConfig,{pool:owner,redis:clientRedis} as unknown as Infrastructure);
  const uploaded=raw.replace('"Dia" : 20','"Dia" : 21').replace('"_getDia" : 960','"_getDia" : 963')+' ';
  const uploadRequest={get:(header:string)=>header.toLowerCase()==='authorization'?'Bearer '+token:undefined,query:{},body:{version:5,data:uploaded}} as unknown as Request;
  const saved=await dataService.save(uploadRequest);assert.equal(saved.version,6);
  await assert.rejects(()=>dataService.save(uploadRequest),/SAVE_VERSION_CONFLICT/);
  const uploadedState=await f.stored();assert.equal(uploadedState.data,uploaded);assert.equal(uploadedState.version,6);
  await assert.rejects(()=>f.service.apply(f.operation,'ledger_admin'),errorIs('SAVE_REPAIR_VERSION_CONFLICT',409));
  assert.deepEqual(await f.stored(),uploadedState);assert.deepEqual(await f.audits(),[]);
 });
 await t.test('fingerprint changes at the same version reject preview and apply (owner-emulated byte change)',async()=>{
  const f=await fixture();await f.service.preview(f.base);
  // Deliberately owner-emulated out-of-band change: the real client upload is tested above.
  await owner.query('UPDATE game_saves SET data=$2 WHERE user_id=$1',[f.uid,raw+' ']);const state=await f.stored();
  await assert.rejects(()=>f.service.preview(f.base),errorIs('SAVE_REPAIR_VERSION_CONFLICT',409));
  await assert.rejects(()=>f.service.apply(f.operation,'ledger_admin'),errorIs('SAVE_REPAIR_VERSION_CONFLICT',409));
  assert.deepEqual(await f.stored(),state);assert.deepEqual(await f.audits(),[]);
 });
 const amounts=[0,-1,1.5,'10000',null,true,2147483648,Number.MAX_SAFE_INTEGER,NaN,Infinity];
 for(const [index,amount]of amounts.entries())await t.test('invalid amount '+index+' ('+String(amount)+') rejects preview and apply atomically',async()=>{
  const f=await fixture(),base={...f.base,changes:{addDia:amount}};
  await assert.rejects(()=>f.service.preview(base),errorIs('SAVE_REPAIR_INVALID_REQUEST',400));
  await assert.rejects(()=>f.service.apply({...f.operation,changes:base.changes},'ledger_admin'),errorIs('SAVE_REPAIR_INVALID_REQUEST',400));
  await f.unchanged();
 });
 const tampering=[{changes:{addDia:10000,Dia:10020}},{changes:{addDia:10000,_getDia:30960}},{changes:{addDia:10000,_useDia:0}},{changes:{addDia:10000,after:compensation.after}},{after:compensation.after},{balance:10020},{statistic:30960},{data:'{}'},{force:true}];
 for(const [index,extra]of tampering.entries())await t.test('tampered after/balance/statistic payload '+index+' is rejected without writes',async()=>{
  const f=await fixture();
  await assert.rejects(()=>f.service.preview({...f.base,...extra}),errorIs('SAVE_REPAIR_INVALID_REQUEST',400));
  await assert.rejects(()=>f.service.apply({...f.operation,...extra},'ledger_admin'),errorIs('SAVE_REPAIR_INVALID_REQUEST',400));await f.unchanged();
 });
 const malformed:[string,string,string,number][]=[
  ['missing Dia','{"_getDia":960,"_useDia":900,"Is_Remove_AD_All":false}','SAVE_REPAIR_INVALID_SAVE',422],
  ['string Dia',raw.replace('"Dia" : 20','"Dia" : "20"'),'SAVE_REPAIR_INVALID_SAVE',422],
  ['fraction',raw.replace('"_getDia" : 960','"_getDia" : 960.5'),'SAVE_REPAIR_INVALID_SAVE',422],
  ['negative raw',raw.replace('"_useDia" : 900','"_useDia" : -3'),'SAVE_REPAIR_INVALID_SAVE',422],
  ['null',raw.replace('"_getDia" : 960','"_getDia" : null'),'SAVE_REPAIR_INVALID_SAVE',422],
  ['duplicate key',raw.replace('"Dia" : 20','"Dia" : 20,"Dia":20'),'SAVE_REPAIR_INVALID_SAVE',422],
  ['exponent raw',raw.replace('"Dia" : 20','"Dia" : 2e1'),'SAVE_REPAIR_INVALID_SAVE',422],
  ['income not multiple of three',raw.replace('"_getDia" : 960','"_getDia" : 961'),'SAVE_REPAIR_INVALID_LEDGER',422],
  ['use not multiple of three',raw.replace('"_useDia" : 900','"_useDia" : 901'),'SAVE_REPAIR_INVALID_LEDGER',422],
  ['inconsistent balance',raw.replace('"Dia" : 20','"Dia" : 21'),'SAVE_REPAIR_INVALID_LEDGER',422],
  ['int32 ledger bound',raw.replace('"_getDia" : 960','"_getDia" : 2147483648'),'SAVE_REPAIR_INVALID_LEDGER',422],
  ['income overflow',JSON.stringify({Dia:715827882,_getDia:2147483646,_useDia:0,Is_Remove_AD_All:false}),'SAVE_REPAIR_DIAMOND_OVERFLOW',400],
 ];
 for(const [name,data,code,status]of malformed)await t.test(name+' rejects preview/apply and leaves raw data plus audit untouched',async()=>{
  const f=await fixture(data);
  await assert.rejects(()=>f.service.preview(f.base),errorIs(code,status));
  await assert.rejects(()=>f.service.apply(f.operation,'ledger_admin'),errorIs(code,status));await f.unchanged();
 });
 await t.test('valid int32 amount whose tripled income overflows is rejected with 400',async()=>{
  const f=await fixture(),changes={addDia:2147483647};
  await assert.rejects(()=>f.service.preview({...f.base,changes}),errorIs('SAVE_REPAIR_DIAMOND_OVERFLOW',400));
  await assert.rejects(()=>f.service.apply({...f.operation,changes},'ledger_admin'),errorIs('SAVE_REPAIR_DIAMOND_OVERFLOW',400));await f.unchanged();
 });
 await t.test('combined removeAds and diamond grant touch only the permitted root spans',async()=>{
  const f=await fixture(),operation={...f.operation,changes:{addDia:10000,removeAds:true}};
  const result=await f.service.apply(operation,'ledger_admin');
  assert.equal((await f.stored()).data,expectedRaw.replace('"Is_Remove_AD_All": false','"Is_Remove_AD_All": true'));
  assert.equal(result.fields.Is_Remove_AD_All,true);assert.deepEqual(result.diamondCompensation,compensation);assert.equal((await f.audits()).length,1);
 });
 for(const fault of ['save UPDATE permission','audit INSERT permission'])await t.test(fault+' failure rolls back save and audit; same request retries once',async()=>{
  const f=await fixture(),grant=fault.startsWith('save')?'UPDATE(data,version,updated_at) ON game_saves':'INSERT ON game_dashboard_save_repairs';
  await owner.query(`REVOKE ${grant} FROM ${writer}`);
  try{await assert.rejects(()=>f.service.apply(f.operation,'ledger_admin'),(error:unknown)=>{assert.equal((error as {code:string}).code,'42501');return true;});await f.unchanged();}
  finally{await owner.query(`GRANT ${grant} TO ${writer}`);}
  const result=await f.service.apply(f.operation,'ledger_admin');assert.equal(result.save.version,6);assert.equal((await f.stored()).data,expectedRaw);
  const retry=await f.service.apply(f.operation,'ledger_admin');assert.deepEqual(retry,{...result,alreadyApplied:true});assert.equal((await f.audits()).length,1);assert.equal((await f.stored()).version,6);
 });
 await t.test('row-targeted database UPDATE trigger failure rolls back and permits same-key retry',async()=>{
  const f=await fixture(),fn='diamond_fault_'+tag,trigger='diamond_fault_trigger_'+tag;
  await owner.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_DIAMOND_UPDATE_FAILURE'; END $$`);
  try{
   await owner.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON game_saves FOR EACH ROW WHEN (OLD.user_id='${f.uid}'::uuid) EXECUTE FUNCTION ${fn}()`);
   try{await assert.rejects(()=>f.service.apply(f.operation,'ledger_admin'),/TEST_DIAMOND_UPDATE_FAILURE/);await f.unchanged();}
   finally{await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON game_saves`);}
  }finally{await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);}
  const result=await f.service.apply(f.operation,'ledger_admin');assert.equal(result.save.version,6);assert.equal((await f.audits()).length,1);assert.equal((await f.stored()).data,expectedRaw);
 });
 await t.test('COMMIT succeeded but response lost: connection is released and retry returns exact persisted receipt',async()=>{
  const f=await fixture();let armed=true,released=0,committed=0,rollbacks=0;
  // Wrap only this service connection. Real BEGIN, UPDATE, INSERT and COMMIT all reach PG.
  // No mutation of the shared pool and no synthetic save/audit responses.
  const responseLossPool={async connect(){const client=await writePool!.connect();return {
   async query(text:string,values?:unknown[]){const result=await client.query(text,values);if(text==='ROLLBACK')rollbacks++;if(text==='COMMIT'){committed++;if(armed){armed=false;throw new Error('TEST_COMMIT_RESPONSE_LOST');}}return result;},
   release(error?:Error){released++;client.release(error);},
  };}};
  const service=createSaveRepair({pool:readPool,writePool:responseLossPool,appId:f.app,enabled:true});
  await assert.rejects(()=>service.apply(f.operation,'ledger_admin'),/TEST_COMMIT_RESPONSE_LOST/);
  assert.equal(released,1);assert.equal(committed,1);assert.equal(rollbacks,1);
  const stored=await f.stored(),audits=await f.audits();assert.equal(stored.data,expectedRaw);assert.equal(stored.version,6);assert.equal(audits.length,1);
  assert.deepEqual(audits[0].result.diamondCompensation,compensation);
  const receipt=await service.apply(f.operation,'ledger_admin');assert.deepEqual(receipt,{...audits[0].result,alreadyApplied:true});
  assert.equal(released,2);assert.equal(committed,2);assert.deepEqual(await f.stored(),stored);assert.deepEqual(await f.audits(),audits);
 });
 await t.test('HTTP rejects missing authentication with 401 and wrong/missing Origin with 403 without writes',async sub=>{
  const f=await fixture(),{api,cookie,config}=await http(sub,f);
  for(const action of ['lookup','preview','apply']){
   const body=action==='lookup'?{openid:f.openid}:action==='preview'?f.base:f.operation;
   assert.equal((await api.post('/h5dashboard/api/save-repair/'+action).set('Origin',config.origin).send(body).expect(401)).body.message,'DASHBOARD_LOGIN_REQUIRED');
   assert.equal((await api.post('/h5dashboard/api/save-repair/'+action).set('Cookie',cookie).set('Origin','https://evil.example.test').send(body).expect(403)).body.message,'ORIGIN_FORBIDDEN');
   assert.equal((await api.post('/h5dashboard/api/save-repair/'+action).set('Cookie',cookie).send(body).expect(403)).body.message,'ORIGIN_FORBIDDEN');
  }await f.unchanged();
 });
 await t.test('authenticated HTTP preview/apply and identical retry persist triple-income receipt',async sub=>{
  const f=await fixture(),{post}=await http(sub,f),lookup=(await post('lookup',{openid:f.openid}).expect(200)).body;
  assert.equal(lookup.user.id,f.uid);assert.equal(lookup.save.version,5);assert.equal(lookup.fingerprint,f.base.fingerprint);
  const preview=(await post('preview',f.base).expect(200)).body;assert.deepEqual(preview.delta,compensation.delta);assert.equal(preview.after._getDia,30960);await f.unchanged();
  const result=(await post('apply',f.operation).expect(200)).body;assert.deepEqual(result.diamondCompensation,compensation);
  assert.deepEqual((await post('apply',f.operation).expect(200)).body,{...result,alreadyApplied:true});
  assert.equal((await f.stored()).data,expectedRaw);assert.equal((await f.stored()).version,6);assert.equal((await f.audits()).length,1);assert.equal((await f.audits())[0].actor,'ledger_admin');
  const stale={...f.operation,requestId:randomUUID()};assert.equal((await post('apply',stale).expect(409)).body.message,'SAVE_REPAIR_VERSION_CONFLICT');
 });
 const httpErrors:[string,string,string,number][]=[
  ['invalid ledger',raw.replace('"Dia" : 20','"Dia" : 21'),'SAVE_REPAIR_INVALID_LEDGER',422],
  ['invalid save',raw.replace('"Dia" : 20','"Dia" : "20"'),'SAVE_REPAIR_INVALID_SAVE',422],
  ['overflow',JSON.stringify({Dia:715827882,_getDia:2147483646,_useDia:0,Is_Remove_AD_All:false}),'SAVE_REPAIR_DIAMOND_OVERFLOW',400],
 ];
 for(const [name,data,code,status]of httpErrors)await t.test('authenticated HTTP maps '+name+' service errors on preview/apply',async sub=>{
  const f=await fixture(data),{post}=await http(sub,f);
  assert.equal((await post('preview',f.base).expect(status)).body.message,code);
  assert.equal((await post('apply',f.operation).expect(status)).body.message,code);await f.unchanged();
 });
});
