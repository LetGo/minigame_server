import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scryptSync} from 'node:crypto';
import request from 'supertest';
import {createDashboardServer} from '../dashboard/backend.js';
const password='test-repair-password',salt='0123456789abcdef0123456789abcdef';
const config={username:'admin',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),appId:'wx1111111111111111',origin:'https://dashboard.example.com',basePath:'/h5dashboard/',saveRepairEnabled:true};
class Sessions{map=new Map();withCommandOptions(){return this;}async get(k){return this.map.get(k)??null;}async set(k,v){this.map.set(k,v);return 'OK';}async del(k){this.map.delete(k);return 1;}async eval(){return 1;}}
async function start(t,{enabled=true,service}={}){
 const calls=[],saveRepair=service??Object.fromEntries(['lookup','preview','apply'].map(method=>[method,async(...args)=>{calls.push({method,args});return {ok:true};}]));
 const server=createDashboardServer({pool:{},redis:new Sessions(),config:{...config,saveRepairEnabled:enabled},queries:{overview:async()=>({}),player:async()=>null},saveRepair});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const api=request(server),r=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:config.username,password}).expect(200);
 return {api,cookie:r.headers['set-cookie'][0].split(';')[0],calls};
}
const input={openid:'o-example',version:5,fingerprint:'a'.repeat(64),changes:{removeAds:true,addDia:100}};
const apply={...input,requestId:'11111111-1111-4111-8111-111111111111',reason:'恢复丢失数据'};
test('write flag must explicitly enable apply, leaving lookup and preview non-destructive',async t=>{
 const {api,cookie,calls}=await start(t,{enabled:false});
 const post=(method,body)=>api.post(path(method)).set('Origin',config.origin).set('Cookie',cookie).send(body);
 await post('lookup',{openid:input.openid}).expect(200);await post('preview',input).expect(200);
 const denied=await post('apply',apply).expect(403);assert.equal(denied.body.message,'SAVE_REPAIR_DISABLED');assert.deepEqual(calls.map(x=>x.method),['lookup','preview']);
});
test('known repair failures are translated safely; unknown SQL details never leave backend',async t=>{
 for(const [message,status]of [['SAVE_REPAIR_INVALID_REQUEST',400],['SAVE_REPAIR_INVALID_SAVE',422],['SAVE_REPAIR_INVALID_LEDGER',422],['SAVE_REPAIR_DIAMOND_OVERFLOW',400],['SAVE_REPAIR_NO_SAVE',404],['PLAYER_NOT_FOUND',404],['SAVE_REPAIR_VERSION_CONFLICT',409],['SAVE_REPAIR_REQUEST_CONFLICT',409],['SAVE_REPAIR_NO_CHANGES',400],['postgresql://private:password@host SQL failure',503]]){
  const {api,cookie}=await start(t,{service:{preview:async()=>{throw new Error(message);}}});
  const r=await api.post(path('preview')).set('Origin',config.origin).set('Cookie',cookie).send(input).expect(status);
  assert.equal(r.body.message,status===503?'DASHBOARD_UNAVAILABLE':message);assert(!r.text.includes('password'));
 }
});
test('missing service and malformed JSON fail closed and cannot invoke apply',async t=>{
 const {api,cookie,calls}=await start(t,{service:{}});
 await api.post(path('apply')).set('Origin',config.origin).set('Cookie',cookie).send(apply).expect(503);
 assert.deepEqual(calls,[]);
 const s=await start(t);await s.api.post(path('apply')).set('Origin',config.origin).set('Cookie',s.cookie).set('Content-Type','application/json').send('{bad').expect(400);assert.deepEqual(s.calls,[]);
});
const path=method=>'/h5dashboard/api/save-repair/'+method;
test('repair routes require login and same Origin, disallow GET/query and forward fixed actor only',async t=>{
 const {api,cookie,calls}=await start(t);
 for(const method of ['lookup','preview','apply']){
  await api.post(path(method)).set('Origin',config.origin).send({}).expect(401);
  await api.post(path(method)).set('Cookie',cookie).set('Origin','https://evil.example').send({}).expect(403);
  await api.get(path(method)).set('Cookie',cookie).expect(404);
  await api.post(path(method)+'?force=true').set('Origin',config.origin).set('Cookie',cookie).send({}).expect(404);
 }
 for(const [method,body]of [['lookup',{openid:input.openid}],['preview',input],['apply',apply]]){
  const r=await api.post(path(method)).set('Origin',config.origin).set('Cookie',cookie).send(body).expect(200);assert.deepEqual(r.body,{ok:true});assert.equal(r.headers['cache-control'],'no-store');
 }
 assert.deepEqual(calls,[{method:'lookup',args:[{openid:input.openid}]},{method:'preview',args:[input]},{method:'apply',args:[apply,'admin']}]);
});

test('raw JSON fractional diamond numbers cannot round silently into valid integer grants',async t=>{
 const {api,cookie,calls}=await start(t);
 for(const token of ['100.00000000000000000001','0.99999999999999999999','1e2','100.0','0','-0','"100"']){
  const text=JSON.stringify(apply).replace('"addDia":100','"addDia":'+token);
  const r=await api.post(path('apply')).set('Origin',config.origin).set('Cookie',cookie).set('Content-Type','application/json').send(text).expect(400);
  assert.equal(r.body.message,'SAVE_REPAIR_INVALID_REQUEST');
 }
 assert.equal(calls.length,0);
 const valid=JSON.stringify(apply);await api.post(path('apply')).set('Origin',config.origin).set('Cookie',cookie).set('Content-Type','application/json').send(valid).expect(200);assert.equal(calls.length,1);
});
