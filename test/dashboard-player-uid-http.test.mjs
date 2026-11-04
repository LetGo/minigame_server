import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scryptSync} from 'node:crypto';
import request from 'supertest';
import {createDashboardServer} from '../dashboard/backend.js';
const uid='11111111-1111-4111-8111-111111111111';
const password='isolated-test-only',salt='0123456789abcdef0123456789abcdef';
const config={username:'admin',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),appId:'wx1111111111111111',origin:'https://dashboard.example.com',basePath:'/h5dashboard/'};
async function start(t){
 const map=new Map(),redis={withCommandOptions(){return this;},async eval(){return 1;},async set(k,v){map.set(k,v);return 'OK';},async get(k){return map.get(k);}};
 const calls=[],pool={},record={user:{id:uid,openid:'test_openid'},save:{exists:false}};
 const server=createDashboardServer({pool,redis,config,queries:{overview:async()=>({}),player:async(...args)=>{calls.push(args);return args[2]==='missing'?null:record;}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const api=request(server),login=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:'admin',password}).expect(200),cookie=login.headers['set-cookie'][0].split(';')[0];
 const post=()=>api.post('/h5dashboard/api/player').set('Origin',config.origin).set('Cookie',cookie);
 return {api,post,cookie,calls,pool,record};
}
test('player accepts an exact UID or legacy openid and forwards app-scoped lookup mode',async t=>{
 const {post,calls,pool,record}=await start(t);
 assert.deepEqual((await post().send({uid}).expect(200)).body,record);
 await post().send({openid:'test_openid'}).expect(200);
 assert.deepEqual(calls[0],[pool,config.appId,uid,'uid']);
 assert.deepEqual(calls[1],[pool,config.appId,'test_openid']);
 await post().send({openid:'missing'}).expect(404);
});
test('UID lookup rejects malformed, ambiguous and extra-field input before any query',async t=>{
 const {post,calls}=await start(t);
 for(const body of [{uid:''},{uid:' '+uid},{uid:uid+' '},{uid:uid.replaceAll('-','')},{uid:'not-a-uuid'},{uid:null},{uid:123},{uid:[uid]},{uid:uid.slice(0,-1)+'g'}])assert.equal((await post().send(body).expect(400)).body.message,'INVALID_UID');
 for(const body of [{uid,openid:'test_openid'},{uid,appId:'other'},{uid,mode:'openid'},{}])await post().send(body).expect(400);
 assert.equal(calls.length,0);
});
test('UID lookup preserves authentication, origin checks, POST-only access and no-store',async t=>{
 const {api,post,cookie,calls}=await start(t);
 await api.post('/h5dashboard/api/player').set('Origin',config.origin).send({uid}).expect(401);
 await api.post('/h5dashboard/api/player').set('Origin','https://evil.example.com').set('Cookie',cookie).send({uid}).expect(403);
 await api.get('/h5dashboard/api/player').set('Cookie',cookie).expect(404);
 assert.equal(calls.length,0);
 assert.equal((await post().send({uid}).expect(200)).headers['cache-control'],'no-store');
});
