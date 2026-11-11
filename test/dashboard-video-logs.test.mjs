import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,createHash} from 'node:crypto';
import request from 'supertest';
import {createDashboardServer} from '../dashboard/backend.js';
import * as queries from '../dashboard/queries.mjs';
const config={username:'admin',passwordHash:'00'.repeat(16)+':'+ '00'.repeat(64),appId:'wx1111111111111111',origin:'https://dashboard.example.com',basePath:'/h5dashboard/'};
async function fixture(t,load=async(_pool,_app,offset,date,openid)=>({today:'2026-11-10',date:date??'2026-11-10',timezone:'Asia/Shanghai',generatedAt:'2026-11-10T00:00:00Z',openid,total:0,offset,limit:50,hasMore:false,items:[]})){
 const token=randomBytes(32).toString('base64url'),key='minigame:dashboard:session:'+createHash('sha256').update(token).digest('hex'),sessions=new Map([[key,JSON.stringify({username:config.username})]]);
 const redis={withCommandOptions(){return this;},get:async k=>sessions.get(k)??null,del:async k=>Number(sessions.delete(k))};
 const pool={},server=createDashboardServer({pool,redis,config,queries:{overview:async()=>({}),player:async()=>null,videoLogs:load}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const api=request(server),cookie='__Secure-minigame-dashboard='+token;
 return {api,pool,redis,sessions,cookie,post:body=>api.post('/h5dashboard/api/video-logs').set('Origin',config.origin).set('Cookie',cookie).send(body)};
}
test('video placement is forwarded exactly alongside date and player, without treating SQL metacharacters as syntax',async t=>{
 const calls=[];const f=await fixture(t,async(...args)=>{calls.push(args.slice(1));return {items:[]};});
 for(const placement of ['Main/LevelSkip',"point_%' OR true--",'关卡/跳过','<script>'])await f.post({date:'2024-02-29',openid:'oExact',placement,offset:50}).expect(200);
 assert.deepEqual(calls,['Main/LevelSkip',"point_%' OR true--",'关卡/跳过','<script>'].map(p=>[config.appId,50,'2024-02-29','oExact',p]));
});
test('video logs default date and exact openid options are forwarded to the read-only loader',async t=>{
 const calls=[];const f=await fixture(t,async(pool,appId,offset,date,openid)=>{calls.push([pool,appId,offset,date,openid]);return {offset,date,openid,items:[]};});
 await f.post({}).expect(200).then(r=>assert.equal(r.headers['cache-control'],'no-store'));
 await f.post({offset:50,date:'2024-02-29',openid:'oPlayer_exact-1'}).expect(200);
 assert.deepEqual(calls,[[f.pool,config.appId,0,null,null],[f.pool,config.appId,50,'2024-02-29','oPlayer_exact-1']]);
});
test('video placement rejects malformed filters and forwards omitted filters as null',async t=>{
 const calls=[];const f=await fixture(t,async(...args)=>{calls.push(args);return {items:[]};});
 for(const placement of [null,'',123,[],{},' leading','trailing ','a'.repeat(65),'a\u0000b','a\u0085b','a\ud800'])await f.post({placement}).expect(400).then(r=>assert.equal(r.body.message,'INVALID_PLACEMENT'));
 assert.equal(calls.length,0);await f.post({}).expect(200);assert.equal(calls[0][5],null);
 await f.post({placement:'😀'.repeat(64)}).expect(200);assert.equal(calls.at(-1)[5],'😀'.repeat(64));
});
test('video placement SQL uses a bound case-sensitive equality and shares the filtered total and page',async()=>{
 const calls=[];await queries.videoLogs({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{result:{}}]};}},config.appId,50,'2024-02-29','oExact','Main/LevelSkip');
 assert.deepEqual(calls[0].args,[config.appId,50,'2024-02-29','oExact','Main/LevelSkip']);assert.match(calls[0].sql,/\(\$5::text IS NULL OR e\.placement=\$5::text\)/);assert.match(calls[0].sql,/'placement',\$5::text/);assert(!calls[0].sql.includes('Main/LevelSkip'));
});
test('video log query uses one snapshot and DB clock with exact day/app filtering and UUID tie-breaking',async()=>{
 assert.equal(typeof queries.videoLogs,'function');
 const result={items:[],total:0},calls=[];
 assert.equal(await queries.videoLogs({query:async(sql,args)=>{calls.push({sql,args});return {rows:[{result}]};}},config.appId,50,'2024-02-29','oExact'),result);
 assert.equal(calls.length,1);const {sql,args}=calls[0];assert.deepEqual(args,[config.appId,50,'2024-02-29','oExact',null]);
 assert.match(sql,/WITH moment AS MATERIALIZED/);assert.equal(sql.match(/clock_timestamp\(\)/g)?.length,1);
 assert.match(sql,/game_rewarded_video_events e/);assert.match(sql,/u\.app_id=e\.app_id AND u\.id=e\.user_id/);assert.match(sql,/e\.app_id=\$1/);assert.match(sql,/u\.first_login_completed/);
 assert.match(sql,/LEFT JOIN game_profiles p ON p\.user_id=u\.id/);assert.match(sql,/u\.open_id=\$4::text/);
 assert.match(sql,/e\.recorded_at>=b\.day_start AND e\.recorded_at<b\.day_end/);
 assert.match(sql,/selected_date::timestamp AT TIME ZONE 'Asia\/Shanghai' AS day_start/);assert.match(sql,/\(selected_date\+1\)::timestamp AT TIME ZONE 'Asia\/Shanghai' AS day_end/);
 assert.match(sql,/matching AS MATERIALIZED/);assert.match(sql,/count\(\*\)::float8 AS total FROM matching/);
 assert.equal(sql.match(/ORDER BY recorded_at DESC,event_id DESC,user_id DESC/g)?.length,2);
 assert.match(sql,/LIMIT 50 OFFSET \$2::int/);assert.match(sql,/'hasMore',\(\$2::int\+50\)<t\.total/);
 assert.match(sql,/'recordedAt',recorded_at,'openid',open_id,'nickname',nickname,'placement',placement/);
 assert.doesNotMatch(sql,/\b(?:DISTINCT|INSERT|UPDATE|DELETE)\b|client_info|e\.id\b|token|'eventId'|'userId'/i);
 for(const value of args.filter(x=>typeof x==='string'))assert(!sql.includes(value));
 await assert.rejects(()=>queries.videoLogs({query:async()=>({rows:[]})},config.appId),/Video records unavailable/);
});
test('video logs require session and Origin, POST JSON only, and revoked sessions are rejected',async t=>{
 const f=await fixture(t);
 await f.api.post('/h5dashboard/api/video-logs').set('Origin',config.origin).send({}).expect(401);
 for(const origin of [null,'https://evil.example']){
  let req=f.api.post('/h5dashboard/api/video-logs').set('Cookie',f.cookie);if(origin)req=req.set('Origin',origin);await req.send({}).expect(403);
 }
 for(const path of ['/h5dashboard/api/video-logs?offset=0','/h5dashboard/api/video-logs%23x'])await f.api.post(path).set('Origin',config.origin).set('Cookie',f.cookie).send({}).expect(404);
 await f.api.get('/h5dashboard/api/video-logs').set('Cookie',f.cookie).expect(404);
 const raw=()=>f.api.post('/h5dashboard/api/video-logs').set('Origin',config.origin).set('Cookie',f.cookie);
 await raw().set('Content-Type','text/plain').send('{}').expect(415);
 await raw().set('Content-Type','application/json').set('Content-Encoding','gzip').send('{}').expect(415);
 await raw().set('Content-Type','application/json').send('{').expect(400);
 for(const value of ['null','[]','1','"hello"'])await raw().set('Content-Type','application/json').send(value).expect(400);
 await raw().set('Content-Type','application/json').send('{"openid":"'+'a'.repeat(9000)+'"}').expect(413);
 await raw().set('Content-Type','application/json').send(Buffer.from([123,34,120,34,58,34,255,34,125])).expect(400);
 f.sessions.clear();await f.post({}).expect(401);
});
test('video log validation rejects invalid offset, real-calendar date, openid and unknown fields before querying',async t=>{
 const calls=[];const f=await fixture(t,async(...args)=>{calls.push(args);return {items:[]};});
 for(const body of [{offset:-1},{offset:1.5},{offset:'0'},{offset:null},{offset:10000001},{offset:1e30},{limit:50},{appId:'other'},{sql:'SELECT 1'},{event_id:'x'},{today:'2026-11-10'}])await f.post(body).expect(400).then(r=>assert.equal(r.body.message,'INVALID_REQUEST'));
 for(const date of [null,'','2026-02-29','2026-04-31','2026-13-01','2026-00-01','2026-10-00','2026-1-01','0000-01-01','2026-10-19T00:00:00Z',"2026-10-19' OR true--",20261019,[],{}])await f.post({date}).expect(400).then(r=>assert.equal(r.body.message,'INVALID_REQUEST'));
 for(const openid of ['',null,123,[],{},'a'.repeat(129),' abc','abc ','abc%','abc_\n',"abc' OR true--",'<script>'])await f.post({openid}).expect(400).then(r=>assert.equal(r.body.message,'INVALID_OPENID'));
 assert.equal(calls.length,0);
 for(const body of [{offset:10000000},{date:'0001-01-01'},{date:'9999-12-31'},{openid:'a'.repeat(128)},{date:'2000-02-29'}])await f.post(body).expect(200);
 assert.equal(calls.length,5);
});
test('missing video loader and storage errors fail closed with generic errors, including null snapshots',async t=>{
 const f=await fixture(t,async()=>{throw Error('private password token database');});
 await f.post({}).expect(503).then(r=>assert.deepEqual(r.body,{message:'DASHBOARD_UNAVAILABLE'}));
 f.redis.get=async()=>{throw Error('private redis');};await f.post({}).expect(503).then(r=>assert.deepEqual(r.body,{message:'DASHBOARD_UNAVAILABLE'}));
 const absent=await fixture(t,null);await absent.post({}).expect(503).then(r=>assert.deepEqual(r.body,{message:'DASHBOARD_UNAVAILABLE'}));
 const empty=await fixture(t,async()=>null);await empty.post({}).expect(503).then(r=>assert.deepEqual(r.body,{message:'DASHBOARD_UNAVAILABLE'}));
});
