import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scryptSync} from 'node:crypto';
import request from 'supertest';
import {createDashboardServer} from '../dashboard/backend.js';
class Redis{map=new Map();withCommandOptions(){return this;}async eval(_,{keys}){const n=Number(this.map.get(keys[0])??0)+1;this.map.set(keys[0],String(n));return n;}async set(k,v){this.map.set(k,v);return 'OK';}async get(k){return this.map.get(k)??null;}async del(k){this.map.delete(k);return 1;}}
const password='isolated-retention-http-password',salt='0123456789abcdef0123456789abcdef';
const config={username:'admin',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),appId:'wx1111111111111111',origin:'https://dashboard.example.com',basePath:'/h5dashboard/',environment:'production'};
const report={schemaVersion:1,appId:config.appId,timezone:'Asia/Shanghai',environment:'production',asOfDate:'2026-11-01',generatedAt:'2026-11-02T00:10:00+08:00',coverageStart:'2026-10-17',trackingStartedAt:'2026-10-17T15:58:42Z',historyDays:120,periods:[1,3,5,7,14,20,30],cohorts:[],summary:[]};
async function start(t,loader=async()=>report){
 const pool={query(){throw new Error('retention HTTP must never query DB');}},redis=new Redis();
 const queries={overview:async()=>({}),player:async()=>null};
 const server=createDashboardServer({pool,redis,config,queries,retentionReport:loader,loginRateLimit:50});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const api=request(server);const login=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:'admin',password}).expect(200);
 return {api,cookie:login.headers['set-cookie'][0].split(';')[0]};
}
test('retention report is authenticated GET-only and returns persisted JSON with no-store',async t=>{
 let calls=0;const {api,cookie}=await start(t,async()=>{calls++;return report;});
 await api.get('/h5dashboard/api/retention-report').expect(401);assert.equal(calls,0);
 const response=await api.get('/h5dashboard/api/retention-report').set('Cookie',cookie).expect(200);
 assert.deepEqual(response.body,report);assert.equal(response.headers['cache-control'],'no-store');assert.match(response.headers['content-type'],/^application\/json/);assert.equal(calls,1);
});
test('client cannot choose app/date/file or trigger report generation',async t=>{
 let calls=0;const {api,cookie}=await start(t,async(...args)=>{assert.equal(args.length,0);calls++;return report;});
 for(const suffix of ['?appId=wx9999999999999999','?date=2026-10-01','?path=/etc/passwd','/'])await api.get('/h5dashboard/api/retention-report'+suffix).set('Cookie',cookie).expect(404);
 for(const method of ['post','put','delete'])await api[method]('/h5dashboard/api/retention-report').set('Origin',config.origin).set('Cookie',cookie).send({}).expect(404);
 assert.equal(calls,0);
});
test('missing, invalid or failing report loader fails closed and never leaks private details',async t=>{
 for(const loader of [null,async()=>null,async()=>{throw new Error('private /home/ubuntu/db-secret');}]){
  const {api,cookie}=await start(t,loader);const r=await api.get('/h5dashboard/api/retention-report').set('Cookie',cookie).expect(503);
  assert.equal(r.body.message,'RETENTION_REPORT_UNAVAILABLE');assert.equal(r.text.includes('private'),false);assert.equal(r.text.includes('/home'),false);
 }
});
test('report loader cannot serve another app and logout invalidates report access',async t=>{
 const {api,cookie}=await start(t,async()=>({...report,appId:'wx9999999999999999'}));
 await api.get('/h5dashboard/api/retention-report').set('Cookie',cookie).expect(503);
 await api.get('/h5dashboard/api/me').set('Cookie',cookie).expect(200);
 await api.post('/h5dashboard/api/logout').set('Origin',config.origin).set('Cookie',cookie).send({}).expect(200);
 await api.get('/h5dashboard/api/retention-report').set('Cookie',cookie).expect(401);
});
