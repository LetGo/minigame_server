import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import request from 'supertest';
import {scryptSync} from 'node:crypto';
import {migrate} from '../src/database/migrate.js';

// Test-only PostgreSQL 15439 / Redis 16389 (compose.test.yaml). Never production/staging.
const OWNER='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
const ISO=`to_char(%s AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

test('dashboard player aggregate reads app/UID-scoped rewarded-video completions with one Beijing-day snapshot',async t=>{
 const pool=new Pool({connectionString:OWNER});
 const appId='wx'+randomBytes(8).toString('hex'),foreignApp='wx'+randomBytes(8).toString('hex');
 t.after(async()=>{await pool.query('DELETE FROM game_users WHERE app_id=ANY($1::text[])',[[appId,foreignApp]]);await pool.end();});
 await migrate(pool);
 const {player}=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 assert.equal(typeof player,'function','dashboard player query must be exported');

 const users=(await pool.query(`INSERT INTO game_users(app_id,open_id) VALUES($1,'pv_a'),($1,'pv_b'),($1,'pv_empty'),($2,'pv_foreign') RETURNING id,app_id,open_id`,[appId,foreignApp])).rows;
 const a=users.find(x=>x.open_id==='pv_a')!,b=users.find(x=>x.open_id==='pv_b')!,empty=users.find(x=>x.open_id==='pv_empty')!,foreign=users.find(x=>x.open_id==='pv_foreign')!;

 await t.test('UID lookup returns the same full player detail and never crosses app boundaries',async()=>{
  const byOpenid=await player(pool,appId,'pv_a');
  assert.deepEqual(await player(pool,appId,a.id,'uid'),byOpenid);
  assert.equal(await player(pool,foreignApp,a.id,'uid'),null);
  assert.equal(await player(pool,appId,randomUUID(),'uid'),null);
  const calls:any[]=[];
  const spy={query:async(sql:string,args:any[])=>{calls.push({sql,args});return pool.query(sql,args);}};
  await player(spy,appId,a.id,'uid');
  assert.equal(calls.length,1);assert.match(calls[0].sql,/u\.id=\$2::uuid/);assert.deepEqual(calls[0].args,[appId,a.id]);
 });

 await t.test('authenticated HTTP UID and openid queries read identical real database player details',async t=>{
  const {createDashboardServer}=await import(pathToFileURL(resolve('dashboard/backend.js')).href);
  const values=new Map<string,string>(),redis={withCommandOptions(){return this;},async eval(){return 1;},async set(k:string,v:string){values.set(k,v);return 'OK';},async get(k:string){return values.get(k);}};
  const password='isolated-player-uid-test',salt='0123456789abcdef0123456789abcdef';
  const config={username:'admin',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),appId,origin:'https://dashboard.example.com'};
  const server=createDashboardServer({pool,redis,config,queries:{overview:async()=>({}),player}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const api=request(server),login=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:'admin',password}).expect(200);
  const cookie=String(login.headers['set-cookie']![0]).split(';')[0]!;
  const post=()=>api.post('/h5dashboard/api/player').set('Origin',config.origin).set('Cookie',cookie);
  const original=await post().send({openid:'pv_a'}).expect(200);
  assert.deepEqual((await post().send({uid:a.id})).body,original.body);
  assert.deepEqual((await post().send({uid:a.id.toUpperCase()}).expect(200)).body,original.body);
  await post().send({uid:foreign.id}).expect(404);
  await post().send({uid:randomUUID()}).expect(404);
 });

 await t.test('zero events yields zeros, nulls and no placements while existing player fields stay intact',async()=>{
  const raw='{ "big":9007199254740993123123, "text":"<img onerror=alert(1)>" }\n';
  await pool.query('INSERT INTO game_saves(user_id,data,version) VALUES($1,$2,7)',[empty.id,raw]);
  const record=await player(pool,appId,'pv_empty');
  assert.deepEqual(record.rewardedVideos,{total:0,today:0,firstRecordedAt:null,lastRecordedAt:null,placements:[]});
  assert.equal(record.user.id,empty.id);
  assert.equal(record.user.openid,'pv_empty');
  assert.equal(record.save.exists,true);
  assert.equal(record.save.data,raw,'original save text must not be re-encoded');
  assert.equal(record.save.version,7);
  assert.equal(record.inviter,null);
  assert.equal(record.invitations.summary.total,0);
  assert.deepEqual(record.invitations.items,[]);
  assert.deepEqual(record.dailyLogins,[]);
  assert.equal(await player(pool,appId,'missing_player'),null,'unknown player stays null');
  assert.equal(await player(pool,appId,"' OR 1=1--"),null);
  assert.equal(await player(pool,foreignApp,'pv_a'),null,'player is app-scoped');
 });

 await t.test('totals, first/last and placements are aggregated per placement without leaking other users or apps',async()=>{
  const inserted=(await pool.query(`WITH clocks AS (
     SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS midnight
   ) INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,client_info,recorded_at)
   SELECT $1,$2,gen_random_uuid(),v.placement,'{"x":1}',v.at FROM (VALUES
     ('ancient'::text,((SELECT midnight FROM clocks)-interval '45 days')),
     ('b',(SELECT midnight FROM clocks)-interval '1 microsecond'),
     ('a',(SELECT midnight FROM clocks)),
     ('a',clock_timestamp())
   ) v(placement,at)
   RETURNING placement,${ISO.replace('%s','recorded_at')} AS iso,recorded_at,event_id`,[appId,a.id])).rows;
  const isoOf=(at:Date)=>inserted.find((x:any)=>x.recorded_at.getTime()===at.getTime())!.iso;
  const ancient=inserted.find((x:any)=>x.placement==='ancient')!,midnight=inserted.find((x:any)=>x.placement==='b')!;
  const newest=inserted.reduce((max:any,x:any)=>x.recorded_at>max.recorded_at?x:max,inserted[0]);
  const todayMidnightString=midnight.iso;

  // Same app, different player and a foreign app holding one of the same event ids.
  const otherEvents=(await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement)
    VALUES($1,$2,$3,'a'),($1,$2,gen_random_uuid(),'a'),($4,$5,$3,'a') RETURNING app_id,user_id,event_id`,
    [appId,b.id,midnight.event_id,foreignApp,foreign.id])).rows;
  assert.equal(otherEvents.length,3);
  await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) VALUES($1,$2,$3,'duplicate')
    ON CONFLICT (app_id,user_id,event_id) DO NOTHING`,[appId,a.id,midnight.event_id]);

  const seen:string[]=[];
  const spy={query:async(sql:string,params:any[])=>{seen.push(sql);return pool.query(sql,params);}} as any;
  const record=await player(spy,appId,'pv_a');
  assert.equal(seen.length,1,'player detail remains a single parameterized query');
  const sql=seen[0]!;
  assert.equal((sql.match(/clock_timestamp\(\)/g)??[]).length,1,'Beijing day must come from one DB clock snapshot');
  assert.match(sql,/Asia\/Shanghai/);
  assert.match(sql,/game_rewarded_video_events/);
  assert.match(sql,/count\(\*\)/i,'aggregation must happen in SQL');
  assert.doesNotMatch(sql,/client_info/i,'event payload rows must not be loaded');
  assert.equal(sql.includes(appId),false,'app id must be parameterized');
  assert.equal(sql.includes('pv_a'),false,'openid must be parameterized');

  assert.deepEqual(record.rewardedVideos,{
   total:4,today:2,firstRecordedAt:ancient.iso,lastRecordedAt:newest.iso,
   placements:[{placement:'a',total:2,today:2},{placement:'ancient',total:1,today:0},{placement:'b',total:1,today:0}]
  });
  assert.ok(record.rewardedVideos.lastRecordedAt>todayMidnightString,'latest completion is today');
  assert.equal(record.user.id,a.id,'existing player fields untouched');
  assert.equal(record.save.exists,false);
  assert.equal(record.invitations.summary.total,0);
  assert.deepEqual(record.dailyLogins,[]);
 });

 await t.test('today excludes the microsecond before midnight and the next midnight, and includes exact midnight',async()=>{
  const edge=(await pool.query("INSERT INTO game_users(app_id,open_id) VALUES($1,'pv_edge') RETURNING id",[appId])).rows[0];
  const seeded=(await pool.query(`WITH clocks AS (
     SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS midnight
   ) INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at)
   SELECT $1,$2,gen_random_uuid(),v.placement,v.at FROM (VALUES
     ('before'::text,(SELECT midnight FROM clocks)-interval '1 microsecond'),
     ('in',(SELECT midnight FROM clocks)),
     ('after',((SELECT midnight FROM clocks)+interval '1 day'))
   ) v(placement,at)
   RETURNING placement,${ISO.replace('%s','recorded_at')} AS iso`,[appId,edge.id])).rows;
  try{
   const isoOf=(name:string)=>seeded.find((x:any)=>x.placement===name)!.iso;
   const record=await player(pool,appId,'pv_edge');
   assert.equal(record.rewardedVideos.today,1,'only [Beijing midnight, next midnight) counts as today');
   assert.equal(record.rewardedVideos.total,3);
   assert.equal(record.rewardedVideos.firstRecordedAt,isoOf('before'));
   assert.equal(record.rewardedVideos.lastRecordedAt,isoOf('after'));
   assert.deepEqual(record.rewardedVideos.placements,[
    {placement:'after',total:1,today:0},
    {placement:'before',total:1,today:0},
    {placement:'in',total:1,today:1}
   ]);
   assert.match(record.rewardedVideos.firstRecordedAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,'timestamps are ISO-8601 UTC');
   assert.equal(await player(pool,appId,'pv_a').then((r:any)=>r.rewardedVideos.today),2,'another player midnight edges do not shift pv_a');
  }finally{await pool.query('DELETE FROM game_users WHERE id=$1',[edge.id]);}
 });

 await t.test('duplicate event ids are already deduplicated by the schema and never inflate the aggregate',async()=>{
  const before=await player(pool,appId,'pv_a');
  const eventId=randomUUID();
  await pool.query("INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) VALUES($1,$2,$3,'a')",[appId,a.id,eventId]);
  await pool.query("INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) VALUES($1,$2,$3,'a') ON CONFLICT DO NOTHING",[appId,a.id,eventId]);
  const after=await player(pool,appId,'pv_a');
  assert.equal(after.rewardedVideos.total,before.rewardedVideos.total+1);
  assert.equal(after.rewardedVideos.today,before.rewardedVideos.today+1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[appId,a.id,eventId])).rows[0].n,1);
 });
});
