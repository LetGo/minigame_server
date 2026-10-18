import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes} from 'node:crypto';
import request from 'supertest';
import {createDashboardServer} from '../dashboard/backend.js';

const config={username:'admin',passwordHash:'00'.repeat(16)+':'+ '00'.repeat(64),appId:'wx1111111111111111',origin:'https://dashboard.example.com',basePath:'/h5dashboard/'};
const day=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
function snapshot(ms,serial=1){return {today:day(ms),generatedAt:new Date(ms).toISOString(),metrics:{serial}};}
async function fixture(t,loader,initial=Date.parse('2026-10-18T04:00:00Z'),appId=config.appId){
 let now=initial,calls=0,players=0,redisDown=false;const sessions=new Map();
 const cookies=Array.from({length:2},()=>{const token=randomBytes(32).toString('base64url');sessions.set('minigame:dashboard:session:'+createHash('sha256').update(token).digest('hex'),JSON.stringify({username:config.username}));return '__Secure-minigame-dashboard='+token;});
 const redis={withCommandOptions(){return this;},async get(key){if(redisDown)throw Error('private redis failure');return sessions.get(key)??null;},async del(key){sessions.delete(key);return 1;}};
 const queries={overview:async(_pool,game)=>{calls++;return loader?loader({now,calls,game}):snapshot(now,calls);},player:async()=>{players++;return {user:{id:'fixture'}};}};
 const server=createDashboardServer({pool:{},redis,config:{...config,appId},queries,overviewClock:()=>now});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const api=request(server),get=(cookie=cookies[0])=>api.get('/h5dashboard/api/overview').set('Cookie',cookie);
 return {api,get,cookies,sessions,advance(ms){now+=ms;},setNow(ms){now=ms;},get now(){return now;},get calls(){return calls;},get players(){return players;},outage(){redisDown=true;}};
}
test('authenticated overview shares a 30-second snapshot but never caches authorization or player records',async t=>{
 const f=await fixture(t);const first=await f.get().expect(200);f.advance(29999);
 const hit=await f.get(f.cookies[1]).expect(200);assert.equal(f.calls,1,'separate dashboard sessions should share the cached overview');assert.deepEqual(hit.body,first.body,'cache hit preserves real generatedAt and metrics');assert.equal(hit.headers['cache-control'],'no-store');
 await f.api.get('/h5dashboard/api/overview').expect(401);assert.equal(f.calls,1);
 for(let i=0;i<2;i++)await f.api.post('/h5dashboard/api/player').set('Origin',config.origin).set('Cookie',f.cookies[0]).send({openid:'fixture'}).expect(200);assert.equal(f.players,2,'player saves remain uncached');
 f.advance(1);const refreshed=await f.get().expect(200);assert.equal(f.calls,2);assert.notEqual(refreshed.body.generatedAt,first.body.generatedAt,'exact TTL boundary refreshes');
 await f.api.post('/h5dashboard/api/logout').set('Origin',config.origin).set('Cookie',f.cookies[0]).send({}).expect(200);await f.get().expect(401);assert.equal(f.calls,2,'cached data must not bypass a revoked session');
 f.outage();const failed=await f.get(f.cookies[1]).expect(503);assert.equal(f.calls,2);assert(!failed.text.includes('private'),'Redis failure stays fail-closed even on a cache hit');
});
test('cold and expired concurrent HTTP requests share exactly one database load',async t=>{
 const f=await fixture(t);for(let batch=0;batch<2;batch++){
  const results=await Promise.all(Array.from({length:40},(_,i)=>f.get(f.cookies[i%2]).expect(200)));
  assert.equal(f.calls,batch+1);assert(results.every(r=>JSON.stringify(r.body)===JSON.stringify(results[0].body)));
  f.advance(30000);
 }
});
test('Beijing midnight expires an otherwise fresh cache',async t=>{
 const f=await fixture(t,null,Date.parse('2026-10-18T15:59:59.999Z'));assert.equal((await f.get().expect(200)).body.today,'2026-10-18');
 f.advance(1);const next=await f.get().expect(200);assert.equal(next.body.today,'2026-10-19');assert.equal(f.calls,2);
});
test('a query crossing Beijing midnight is discarded and all waiters receive the new day',async t=>{
 let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 const f=await fixture(t,async({now,calls})=>{if(calls===1){started();await gate;}return snapshot(now,calls);},Date.parse('2026-10-18T15:59:59.999Z'));
 const pending=Array.from({length:20},()=>f.get().expect(200).then(r=>r));await entered;f.advance(1);release();
 const results=await Promise.all(pending);assert.equal(f.calls,2);assert(results.every(r=>r.body.today==='2026-10-19'&&r.body.metrics.serial===2));
});
test('query failures are neither leaked nor cached and never serve an expired successful snapshot',async t=>{
 let fail=false;const f=await fixture(t,({now,calls})=>{if(fail)throw Error('private database connection');return snapshot(now,calls);});
 await f.get().expect(200);f.advance(30000);fail=true;const results=await Promise.all(Array.from({length:15},()=>f.get().expect(503)));
 assert(results.every(r=>r.body.message==='DASHBOARD_UNAVAILABLE'&&!r.text.includes('private')));fail=false;
 const recovered=await f.get().expect(200);assert.equal(recovered.body.generatedAt,new Date(f.now).toISOString());
});
test('server/game caches are isolated and a backwards clock invalidates a snapshot',async t=>{
 const a=await fixture(t,({now,game})=>({...snapshot(now),game}));const b=await fixture(t,({now,game})=>({...snapshot(now),game}),a.now,'wx2222222222222222');
 assert.equal((await a.get().expect(200)).body.game,config.appId);assert.equal((await b.get().expect(200)).body.game,'wx2222222222222222');assert.equal(a.calls,1);assert.equal(b.calls,1);
 a.advance(-1);await a.get().expect(200);assert.equal(a.calls,2);
});
test('cache age starts with query generation, not query completion or repeated hits',async t=>{
 let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 const f=await fixture(t,async({now,calls})=>{if(calls===1){started();await gate;}return snapshot(now,calls);});
 const pending=f.get().expect(200).then(r=>r);await entered;f.advance(10000);release();await pending;
 f.advance(19999);await f.get().expect(200);assert.equal(f.calls,1);f.advance(1);await f.get().expect(200);assert.equal(f.calls,2,'load time counts towards 30-second freshness');
});
test('persistent database/server day mismatch fails closed after one retry rather than looping',async t=>{
 const f=await fixture(t,()=>snapshot(Date.parse('2026-10-17T04:00:00Z')));await f.get().expect(503);assert.equal(f.calls,2);
});
