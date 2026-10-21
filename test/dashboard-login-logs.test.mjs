import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,createHash} from 'node:crypto';
import request from 'supertest';
import {createDashboardServer} from '../dashboard/backend.js';
import * as queries from '../dashboard/queries.mjs';
const config={username:'admin',passwordHash:'00'.repeat(16)+':'+ '00'.repeat(64),appId:'wx1111111111111111',origin:'https://dashboard.example.com',basePath:'/h5dashboard/'};
async function fixture(t,load=async(_pool,_app,offset)=>({today:'2026-10-20',timezone:'Asia/Shanghai',generatedAt:'2026-10-19T16:00:00Z',total:0,offset,limit:50,hasMore:false,items:[]})){
 const token=randomBytes(32).toString('base64url'),key='minigame:dashboard:session:'+createHash('sha256').update(token).digest('hex'),sessions=new Map([[key,JSON.stringify({username:config.username})]]);
 const redis={withCommandOptions(){return this;},get:async k=>sessions.get(k)??null,del:async k=>Number(sessions.delete(k))};
 const pool={},server=createDashboardServer({pool,redis,config,queries:{overview:async()=>({}),player:async()=>null,loginLogs:load}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const api=request(server),cookie='__Secure-minigame-dashboard='+token;
 return {api,pool,redis,sessions,post:body=>api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).set('Cookie',cookie).send(body),cookie};
}
test('login logs require authenticated session, correct Origin and ordinary JSON',async t=>{
 const f=await fixture(t);await f.api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).send({}).expect(401);await f.api.post('/h5dashboard/api/login-logs').set('Cookie',f.cookie).send({}).expect(403);await f.api.post('/h5dashboard/api/login-logs').set('Cookie',f.cookie).set('Origin','https://evil.example').send({}).expect(403);await f.api.post('/h5dashboard/api/login-logs').set('Cookie',f.cookie).set('Origin',config.origin).set('Content-Type','text/plain').send('{}').expect(415);await f.api.get('/h5dashboard/api/login-logs').set('Cookie',f.cookie).expect(404);await f.api.post('/h5dashboard/api/login-logs?offset=0').set('Cookie',f.cookie).set('Origin',config.origin).send({}).expect(404);
 const result=await f.post({offset:0}).expect(200);assert.equal(result.headers['cache-control'],'no-store');f.sessions.clear();await f.post({offset:0}).expect(401);
});
test('login log input is bounded and only explicit offset is forwarded',async t=>{
 const calls=[];const f=await fixture(t,async(pool,appId,offset)=>{calls.push([pool,appId,offset]);return {offset,limit:50,total:80,hasMore:offset<50,items:[]};});
 for(const body of [{offset:-1},{offset:1.5},{offset:'0'},{offset:null},{offset:10000001},{offset:0,limit:5000},{offset:0,sql:'SELECT 1'}])await f.post(body).expect(400).then(r=>assert.equal(r.body.message,'INVALID_REQUEST'));
 assert.equal(calls.length,0);await f.post({}).expect(200).then(r=>assert.equal(r.body.offset,0));await f.post({offset:50}).expect(200).then(r=>{assert.equal(r.body.offset,50);assert.equal(r.body.hasMore,false);});await f.post({offset:10000000}).expect(200);assert.deepEqual(calls,[[f.pool,config.appId,0],[f.pool,config.appId,50],[f.pool,config.appId,10000000]]);
});
test('login log date is optional, calendar-valid and forwarded without changing pagination',async t=>{
 const calls=[];const f=await fixture(t,async(_pool,_app,offset,date)=>{calls.push({offset,date});return {offset,date};});
 await f.post({date:'2026-10-19',offset:50}).expect(200);await f.post({date:'2024-02-29'}).expect(200);await f.post({}).expect(200);
 assert.deepEqual(calls,[{offset:50,date:'2026-10-19'},{offset:0,date:'2024-02-29'},{offset:0,date:null}]);
 for(const date of [null,'','2026-02-29','2026-04-31','2026-13-01','2026-00-01','2026-10-00','2026-1-01','0000-01-01','2026-10-19T00:00:00Z','2026-10-19\' OR true--',20261019,[],{}])await f.post({date}).expect(400).then(r=>assert.equal(r.body.message,'INVALID_REQUEST'));
 assert.equal(calls.length,3,'invalid dates never reach the query');
});
test('login log storage errors fail closed without leaking private details',async t=>{
 const f=await fixture(t,async()=>{throw Error('private database password');});const r=await f.post({offset:0}).expect(503);assert.equal(r.body.message,'DASHBOARD_UNAVAILABLE');assert(!r.text.includes('private'));f.redis.get=async()=>{throw Error('private redis');};await f.post({offset:0}).expect(503).then(r=>assert(!r.text.includes('private')));
});
test('login log query binds game and offset, uses daily first time and adds no deduplication',async()=>{
 assert.equal(typeof queries.loginLogs,'function');const result={items:[],total:0};let captured;
 const returned=await queries.loginLogs({query:async(sql,args)=>{captured={sql,args};return {rows:[{result}]};}},config.appId,50);assert.equal(returned,result);assert(captured.args.includes(config.appId));assert(captured.args.includes(50));assert.match(captured.sql,/game_daily_logins/);assert.match(captured.sql,/first_login_at/);assert.match(captured.sql,/Asia\/Shanghai/);assert.doesNotMatch(captured.sql,/\bDISTINCT\b/i);assert(!captured.sql.includes(config.appId));
});
