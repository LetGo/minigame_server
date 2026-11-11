import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID,scryptSync,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import request from 'supertest';

// Reuse the existing isolated fixture connection privately; reject every non-test target BEFORE SQL.
const fixtureText=readFileSync(resolve('test/dashboard-video-ranking.integration.ts'),'utf8');
const ownerUrl=new URL(fixtureText.match(/const OWNER = '(postgres[^']+)'/)![1]!);
assert.equal(ownerUrl.hostname,'127.0.0.1');assert.equal(ownerUrl.port,'15439');assert.equal(ownerUrl.pathname,'/minigame_test');

type Event={eventId:string;uid:string;app:string;recordedAt:string;openid:string;nickname:string|null;completed:boolean;placement:string};
const normalize=(value:string)=>value.replace(/\+00:00$/,'Z').replace(/(?:\.(\d+))?Z$/,(_m,frac)=>'.'+(frac??'').padEnd(6,'0')+'Z');

test('video logs HTTP/SQL on isolated PG15439 and Redis16389: exact day/player, stable event pages and SELECT-only ACL',async t=>{
 const owner=new Pool({connectionString:ownerUrl.href});
 const suffix=randomBytes(6).toString('hex'),appId='vlog_'+suffix,foreignApp='vlogf_'+suffix,emptyApp='vloge_'+suffix,role='vlog_reader_'+suffix,password=randomBytes(24).toString('hex');
 const apps=[appId,foreignApp,emptyApp],servers:any[]=[],sessionKeys:string[]=[];
 let pool:Pool|undefined,redis:ReturnType<typeof createClient>|undefined,roleCreated=false;
 t.after(async()=>{
  for(const server of servers)await new Promise<void>(r=>server.close(r));
  if(redis?.isOpen){if(sessionKeys.length)await redis.del(sessionKeys);await redis.quit();}
  await pool?.end();
  await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])',[apps]);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_users WHERE app_id=ANY($1::varchar[])',[apps])).rows[0].n,0);
  if(roleCreated){await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);assert.equal((await owner.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1',[role])).rows[0].n,0);}
  await owner.end();
 });
 // Discover real schema; never migrate shared test services or guess a numeric event id.
 const columns=(await owner.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_name='game_rewarded_video_events'")).rows;
 assert.equal(columns.find(x=>x.column_name==='event_id')?.data_type,'uuid');assert.equal(columns.some(x=>x.column_name==='id'),false);
 assert.equal(columns.find(x=>x.column_name==='recorded_at')?.data_type,'timestamp with time zone');
 const constraints=(await owner.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='game_rewarded_video_events'::regclass")).rows;
 assert(constraints.some(x=>x.def==='PRIMARY KEY (app_id, user_id, event_id)'));
 assert(constraints.some(x=>x.def.includes('FOREIGN KEY (app_id, user_id) REFERENCES game_users(app_id, id)')));
 const indexes=(await owner.query("SELECT indexdef FROM pg_indexes WHERE tablename='game_rewarded_video_events'")).rows;
 assert(indexes.some(x=>x.indexdef.includes('(app_id, recorded_at DESC)')));
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);roleCreated=true;
 await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
 await owner.query(`GRANT SELECT ON game_users,game_profiles,game_rewarded_video_events TO ${role}`);
 const readerUrl=new URL(ownerUrl.href);readerUrl.username=role;readerUrl.password=password;
 pool=new Pool({connectionString:readerUrl.href,options:'-c timezone=UTC -c jit=off'});
 const acl=(await pool.query("SELECT t,has_table_privilege(current_user,t,'SELECT') AS r,has_table_privilege(current_user,t,'INSERT') AS i,has_table_privilege(current_user,t,'UPDATE') AS u,has_table_privilege(current_user,t,'DELETE') AS d FROM unnest(ARRAY['game_users','game_profiles','game_rewarded_video_events']) t")).rows;
 assert(acl.every(x=>x.r&&!x.i&&!x.u&&!x.d));
 assert.equal((await pool.query("SELECT has_table_privilege(current_user,'game_saves','SELECT') AS allowed")).rows[0].allowed,false);
 const queries=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 const {createDashboardServer}=await import(pathToFileURL(resolve('dashboard/backend.js')).href);
 redis=createClient({url:'redis://127.0.0.1:16389/12'});redis.on('error',()=>{});await redis.connect();
 const salt=randomBytes(16).toString('hex'),config={username:'vlog_'+suffix,passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),appId,origin:'https://dashboard.example.com',basePath:'/h5dashboard/'};
 let sqlCalls=0;
 const spy={query:async(sql:string,args:any[])=>{sqlCalls++;return pool!.query(sql,args);}};
 const start=async(q:any)=>{const server=createDashboardServer({pool:spy,redis,config,queries:q});servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return request(server);};
 const api=await start(queries);
 const clock=(await owner.query("WITH m AS MATERIALIZED (SELECT clock_timestamp() AS at) SELECT (at AT TIME ZONE 'Asia/Shanghai')::date::text AS today,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS stamp FROM m")).rows[0];
 const day='2024-02-29',dayStart='2024-02-28T16:00:00.000000Z',dayEnd='2024-02-29T16:00:00.000000Z',events:Event[]=[];
 async function user(app:string,openid:string,completed=true,nickname:string|null=null){const uid=randomUUID();await owner.query('INSERT INTO game_users(id,app_id,open_id,first_login_completed) VALUES($1,$2,$3,$4)',[uid,app,openid,completed]);if(nickname!==null)await owner.query('INSERT INTO game_profiles(user_id,nickname) VALUES($1,$2)',[uid,nickname]);return {uid,app,openid,completed,nickname};}
 const exact=await user(appId,'video_exact',true,'<b>当前昵称</b>'),missing=await user(appId,'no_profile'),prefix=await user(appId,'video_exact_extra'),foreign=await user(foreignApp,'video_exact'),incomplete=await user(appId,'incomplete',false);
 async function add(p:typeof exact,recordedAt:string,placement:string,eventId=randomUUID()){
  const inserted=await owner.query('INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id',[p.app,p.uid,eventId,placement,recordedAt]);
  if(inserted.rowCount)events.push({...p,recordedAt,eventId,placement});return eventId;
 }
 // A single player's many events deliberately straddle a page boundary at one timestamp.
 for(let n=0;n<57;n++)await add(exact,'2024-02-29T04:00:00.000000Z','point_'+n,`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`);
 const shared='ffffffff-ffff-4fff-8fff-ffffffffffff';
 await add(exact,'2024-02-29T04:00:00.000000Z','shared_exact',shared);await add(missing,'2024-02-29T04:00:00.000000Z','shared_missing',shared);
 await add(exact,dayStart,'at_midnight');await add(exact,'2024-02-28T15:59:59.999999Z','microsecond_before');await add(exact,dayEnd,'next_midnight');
 await add(prefix,'2024-02-29T05:00:00.000000Z','prefix');await add(foreign,'2024-02-29T06:00:00.000000Z','foreign');await add(incomplete,'2024-02-29T07:00:00.000000Z','incomplete');await add(exact,clock.stamp,'today');
 const dedupId=await add(exact,'2024-02-29T04:00:00.000000Z','deduplicated');await add(exact,'2024-02-29T04:00:00.000000Z','ignored_retry',dedupId);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[appId,exact.uid,dedupId])).rows[0].n,1);
 const compare=(a:Event,b:Event)=>b.recordedAt.localeCompare(a.recordedAt)||b.eventId.localeCompare(a.eventId)||b.uid.localeCompare(a.uid);
 const oracle=(openid:string|null=null,start=dayStart,end=dayEnd)=>events.filter(e=>e.app===appId&&e.completed&&e.recordedAt>=start&&e.recordedAt<end&&(openid===null||e.openid===openid)).sort(compare).map(({recordedAt,openid,nickname,placement})=>({recordedAt,openid,nickname,placement}));
 const post=(body:any,cookie:string)=>api.post('/h5dashboard/api/video-logs').set('Origin',config.origin).set('Cookie',cookie).send(body);
 await api.post('/h5dashboard/api/video-logs').set('Origin',config.origin).send({}).expect(401);
 const login=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:config.username,password}).expect(200);
 const cookie=String((login.headers['set-cookie'] as unknown as string[])[0]).split(';')[0]!,token=cookie.split('=')[1]!;
 const sessionKey='minigame:dashboard:session:'+createHash('sha256').update(token).digest('hex');sessionKeys.push(sessionKey);assert(await redis.get(sessionKey));
 await t.test('single snapshot total, four public fields and identical-time page boundary have no loss or repeats',async()=>{
  const before=sqlCalls,p1=(await post({date:day},cookie).expect(200)).body,p2=(await post({date:day,offset:50},cookie).expect(200)).body;
  assert.equal(sqlCalls-before,2,'one SQL statement per HTTP query');
  const expected=oracle(),actual=[...p1.items,...p2.items];
  assert.equal(p1.total,expected.length);assert.equal(p2.total,expected.length);assert.equal(p1.items.length,50);assert.equal(p2.items.length,expected.length-50);assert.equal(p1.limit,50);assert.equal(p1.hasMore,true);assert.equal(p2.hasMore,false);
  assert.equal(p1.openid,null);assert.equal(p1.date,day);assert.equal(p1.today,clock.today);assert.equal(p1.timezone,'Asia/Shanghai');assert(Number.isFinite(Date.parse(p1.generatedAt)));
  assert.deepEqual(Object.keys(p1).sort(),['today','date','timezone','generatedAt','openid','placement','total','offset','limit','hasMore','items'].sort());
  assert.deepEqual(actual.map((e:any)=>({...e,recordedAt:normalize(e.recordedAt)})),expected);
  assert.equal(new Set(actual.map((e:any)=>e.placement)).size,expected.length);
  assert(actual.every((e:any)=>Object.keys(e).sort().join(',')==='nickname,openid,placement,recordedAt'));
  assert(actual.some((e:any)=>e.nickname===null));assert.equal(actual.filter((e:any)=>e.placement==='deduplicated').length,1);
  const again=(await post({date:day,offset:50},cookie).expect(200)).body;assert.deepEqual(again.items,p2.items);
  const beyond=(await post({date:day,offset:100},cookie).expect(200)).body;assert.equal(beyond.total,expected.length);assert.deepEqual(beyond.items,[]);assert.equal(beyond.hasMore,false);
 });
 await t.test('openid equality retains selected date and excludes same-name foreign apps, prefixes and incomplete users',async()=>{
  for(const openid of ['video_exact','video_exact_extra','no_profile','incomplete','VIDEO_EXACT','absent']){
   const first=(await post({date:day,openid},cookie).expect(200)).body,next=(await post({date:day,openid,offset:50},cookie).expect(200)).body,expected=oracle(openid);
   assert.equal(first.openid,openid);assert.equal(first.total,expected.length);assert.equal(first.hasMore,expected.length>50);assert.equal(next.hasMore,false);
   assert.deepEqual([...first.items,...next.items].map((e:any)=>({...e,recordedAt:normalize(e.recordedAt)})),expected);
  }
  const defaults=(await post({openid:'video_exact'},cookie).expect(200)).body;assert.equal(defaults.date,clock.today);assert.equal(defaults.total,1);assert.equal(defaults.items[0].placement,'today');
  await owner.query('UPDATE game_profiles SET nickname=$2 WHERE user_id=$1',[exact.uid,'最新昵称']);
  assert((await post({date:day,openid:'video_exact'},cookie).expect(200)).body.items.every((e:any)=>e.nickname==='最新昵称'),'profile is current, not an event-time snapshot');
 });
 await t.test('placement equality combines date/player and retains filtered totals across pages without wildcards or cross-app leakage',async()=>{
  for(let n=0;n<55;n++)await add(exact,'2024-02-29T08:00:00.000000Z','Main/LevelSkip');
  for(let n=0;n<2;n++)await add(missing,'2024-02-29T08:00:00.000000Z','Main/LevelSkip');
  await add(exact,'2024-02-29T08:00:00.000000Z','Main/LevelSkip_extra');await add(exact,'2024-02-29T08:00:00.000000Z','main/levelskip');
  await add(foreign,'2024-02-29T08:00:00.000000Z','Main/LevelSkip');await add(incomplete,'2024-02-29T08:00:00.000000Z','Main/LevelSkip');
  await add(prefix,'2024-03-01T08:00:00.000000Z','Main/LevelSkip');
  for(const placement of ['Main/LevelSkip','Main/LevelSkip_extra','main/levelskip',"point_%' OR true--",'关卡/跳过','😀'.repeat(64)]){
   if(!placement.toLowerCase().startsWith('main/'))await add(exact,'2024-02-29T08:00:00.000000Z',placement);
   for(const openid of [null,'video_exact','no_profile','absent']){
    const filter={date:day,placement,...(openid===null?{}:{openid})};
    const p1=(await post(filter,cookie).expect(200)).body,p2=(await post({...filter,offset:50},cookie).expect(200)).body;
    const expected=events.filter(e=>e.app===appId&&e.completed&&e.recordedAt>=dayStart&&e.recordedAt<dayEnd&&e.placement===placement&&(openid===null||e.openid===openid));
    assert.equal(p1.placement,placement);assert.equal(p1.total,expected.length);assert.equal(p2.total,expected.length);assert.equal(p1.hasMore,expected.length>50);assert.equal(p2.hasMore,false);
    assert.equal(p1.items.length+p2.items.length,expected.length);assert([...p1.items,...p2.items].every((e:any)=>e.placement===placement&&(openid===null||e.openid===openid)));
   }
  }
  const missingPoint=(await post({date:day,placement:'never-reported'},cookie).expect(200)).body;assert.equal(missingPoint.total,0);assert.deepEqual(missingPoint.items,[]);
 });
 await t.test('microsecond Beijing boundaries and empty/extreme dates are exact',async()=>{
  const before=(await post({date:'2024-02-28',openid:'video_exact'},cookie).expect(200)).body;assert.equal(before.total,1);assert.equal(normalize(before.items[0].recordedAt),'2024-02-28T15:59:59.999999Z');
  const next=(await post({date:'2024-03-01',openid:'video_exact'},cookie).expect(200)).body;assert.equal(next.total,1);assert.equal(next.items[0].placement,'next_midnight');
  for(const date of ['2000-01-01','0001-01-01','9999-12-31']){const empty=(await post({date},cookie).expect(200)).body;assert.equal(empty.date,date);assert.equal(empty.total,0);assert.deepEqual(empty.items,[]);assert.equal(empty.hasMore,false);}
  const emptyAppResult=await queries.videoLogs(pool,emptyApp);assert.equal(emptyAppResult.total,0);assert.deepEqual(emptyAppResult.items,[]);
 });
 await t.test('all writes fail by ACL even with transaction_read_only OFF, not just a session setting',async()=>{
  const client=await pool!.connect();try{
   await client.query('SET default_transaction_read_only=off');assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'off');
   for(const sql of ['UPDATE game_users SET last_login_at=clock_timestamp() WHERE id=$1','DELETE FROM game_rewarded_video_events WHERE user_id=$1',"INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) SELECT app_id,id,gen_random_uuid(),'forbidden' FROM game_users WHERE id=$1"]){await assert.rejects(()=>client.query(sql,[exact.uid]),(err:any)=>err.code==='42501');}
  }finally{client.release();}
 });
 await t.test('invalid JSON/filter/Origin inputs never reach SQL and real database errors remain generic',async()=>{
  const before=sqlCalls;
  for(const body of [{offset:-1},{offset:1.5},{offset:'0'},{offset:null},{offset:10000001},{date:null},{date:'2026-02-29'},{date:'2024-04-31'},{date:'0000-01-01'},{openid:null},{openid:'video%'},{openid:' video_exact'},{openid:'a'.repeat(129)},{limit:51},{appId:foreignApp}])await post(body,cookie).expect(400);
  await api.post('/h5dashboard/api/video-logs').set('Cookie',cookie).send({}).expect(403);
  await api.post('/h5dashboard/api/video-logs').set('Cookie',cookie).set('Origin',config.origin).set('Content-Type','text/plain').send('{}').expect(415);
  await api.post('/h5dashboard/api/video-logs').set('Cookie',cookie).set('Origin',config.origin).set('Content-Type','application/json').send('{').expect(400);
  assert.equal(sqlCalls,before);
  const faulty=await start({...queries,videoLogs:async()=>pool!.query('SELECT * FROM game_saves LIMIT 1')});
  await faulty.post('/h5dashboard/api/video-logs').set('Cookie',cookie).set('Origin',config.origin).send({}).expect(503).then(r=>assert.deepEqual(r.body,{message:'DASHBOARD_UNAVAILABLE'}));
  const absent=await start({...queries,videoLogs:undefined});await absent.post('/h5dashboard/api/video-logs').set('Cookie',cookie).set('Origin',config.origin).send({}).expect(503);
 });
 await api.post('/h5dashboard/api/logout').set('Origin',config.origin).set('Cookie',cookie).send({}).expect(200);assert.equal(await redis.get(sessionKey),null);await post({date:day},cookie).expect(401);
});
