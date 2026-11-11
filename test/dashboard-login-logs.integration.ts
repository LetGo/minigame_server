import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {Pool} from 'pg';
import {createClient} from 'redis';
import request from 'supertest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {migrate} from '../src/database/migrate.js';

test('daily login log HTTP uses real readonly PG, Beijing day, stable order, bounded pages and app isolation',async t=>{
 const queries=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 assert.equal(typeof queries.loginLogs,'function','loginLogs query must exist');
 const owner=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});await migrate(owner);
 const suffix=randomBytes(5).toString('hex'),appId='loginlogs_'+suffix,foreignApp='foreign_'+suffix,role='log_test_'+suffix,password='isolated-login-log-test-only';
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await owner.query(`GRANT SELECT ON game_users,game_profiles,game_daily_logins,game_login_events TO ${role}`);await owner.query(`ALTER ROLE ${role} SET default_transaction_read_only=on`);
 const pool=new Pool({connectionString:`postgresql://${role}:${password}@127.0.0.1:15439/minigame_test`,max:2,options:'-c jit=off'}),redis=createClient({url:'redis://127.0.0.1:16389/14'});redis.on('error',()=>{});await redis.connect();
 const {createDashboardServer}=await import(pathToFileURL(resolve('dashboard/backend.js')).href);
 const salt='11223344556677889900112233445566',config={username:'logtest',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),appId,origin:'https://dashboard.example.com',basePath:'/h5dashboard/',environment:'production'};
 const server=createDashboardServer({pool,redis,config,queries});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise<void>(r=>server.close(r));await redis.quit();await pool.end();await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])',[[appId,foreignApp]]);await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);await owner.end();});
 const {rows:[clock]}=await owner.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS today, date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS midnight");
 const today=clock.today as string,midnight=new Date(clock.midnight).getTime();
 async function insert(app:string,openid:string,stamp:number,completed=true,nickname:string|null=null,clientVersion:string|null=null){const uid=randomUUID();await owner.query('INSERT INTO game_users(id,app_id,open_id,first_login_completed,last_login_at,last_client_version) VALUES($1,$2,$3,$4,$5,$6)',[uid,app,openid,completed,new Date(stamp+1000),clientVersion]);await owner.query("INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,$3)",[app,uid,new Date(stamp)]);if(nickname!==null)await owner.query('INSERT INTO game_profiles(user_id,nickname,avatar_url) VALUES($1,$2,$3)',[uid,nickname,'https://example.test/avatar.png']);return uid;}
 const first=await insert(appId,'log_midnight',midnight,true,'<b>raw nickname</b>','2.0.7');
 await owner.query('UPDATE game_users SET source_scene=$2,source_scene_reported_at=clock_timestamp(),created_at=$3 WHERE id=$1',[first,1030,new Date(midnight-172800000)]);
 for(let n=1;n<53;n++)await insert(appId,'log_'+n,midnight+(n===52?51:n)*60000,true,n===1?'玩家一':null,n===1?'1.0.0':n===2?'3.14.15-release+candidate':null);
 await insert(appId,'yesterday',midnight-1);await insert(appId,'tomorrow',midnight+86400000);await insert(appId,'incomplete',midnight+60000,false);await insert(foreignApp,'foreign',midnight);
 await owner.query('UPDATE game_users SET last_login_at=$2 WHERE id=$1',[first,new Date(midnight+7200000)]);
 await owner.query("INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,$3::date,$4) ON CONFLICT(app_id,activity_date,user_id) DO NOTHING",[appId,first,today,new Date(midnight+7200000)]);
 const api=request(server);await api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).send({offset:0}).expect(401);
 const login=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:config.username,password}).expect(200);const cookie=String((login.headers['set-cookie'] as unknown as string[])[0]).split(';')[0]!;
 const get=(offset:number,date?:string)=>api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).set('Cookie',cookie).send({offset,...(date===undefined?{}:{date})}).expect(200);
 const page1=(await get(0)).body,page2=(await get(50)).body,beyond=(await get(100)).body;
 assert.equal(page1.today,today);assert.equal(page1.timezone,'Asia/Shanghai');assert.equal(page1.total,53);assert.equal(page1.limit,50);assert.equal(page1.items.length,50);assert.equal(page1.hasMore,true);assert.equal(page2.total,53);assert.equal(page2.items.length,3);assert.equal(page2.hasMore,false);assert.equal(beyond.total,53);assert.deepEqual(beyond.items,[]);assert.equal(beyond.hasMore,false);
 const expected=(await owner.query(`SELECT l.first_login_at AS "loginAt",u.open_id AS openid,p.nickname,u.source_scene AS "sourceScene",NULL::int AS "loginScene",u.created_at AS "registeredAt",u.last_client_version AS "clientVersion" FROM game_daily_logins l JOIN game_users u ON u.app_id=l.app_id AND u.id=l.user_id LEFT JOIN game_profiles p ON p.user_id=u.id WHERE l.app_id=$1 AND l.activity_date=$2::date AND u.first_login_completed ORDER BY l.first_login_at DESC,l.user_id DESC`,[appId,today])).rows;
 const combined=[...page1.items,...page2.items];assert.equal(new Date(combined.find(x=>x.openid==='log_midnight').registeredAt).getTime(),midnight-172800000,'registration is not daily login time');assert.equal(combined.find(x=>x.openid==='log_midnight').sourceScene,1030);assert(combined.some(x=>x.sourceScene===null),'unreported sources remain null');
 assert(combined.every(x=>x.loginScene===null),'without recorded per-login events a compatibility row has no fabricated scene');assert.deepEqual(combined.map((x:any)=>({...x,loginAt:new Date(x.loginAt).toISOString(),registeredAt:new Date(x.registeredAt).toISOString()})),expected.map(x=>({...x,loginAt:x.loginAt.toISOString(),registeredAt:x.registeredAt.toISOString()})));
 assert(combined.every((x:any)=>Object.hasOwn(x,'clientVersion')),'every login row carries clientVersion, null included');
 assert.equal(combined.find(x=>x.openid==='log_midnight').clientVersion,'2.0.7','latest reported successful version is exposed');
 assert.equal(combined.find(x=>x.openid==='log_2').clientVersion,'3.14.15-release+candidate','version string is preserved verbatim');
 assert.equal(combined.find(x=>x.openid==='log_3').clientVersion,null,'never-reported version stays null');
 assert.equal(combined.filter(x=>x.openid==='log_midnight').length,1,'existing day record is kept, not reconstructed from latest login');assert.equal(new Date(combined.find(x=>x.openid==='log_midnight').loginAt).getTime(),midnight,'inclusive Beijing midnight and original first-login time');assert(combined.some(x=>x.nickname===null),'missing profile remains null');assert(!combined.some(x=>['yesterday','tomorrow','foreign','incomplete'].includes(x.openid)));
 const yesterday=new Date(midnight-86400000+8*3600000).toISOString().slice(0,10),tomorrow=new Date(midnight+86400000+8*3600000).toISOString().slice(0,10);
 const versionReportedOnHistoricalLoginDay=null;await owner.query('UPDATE game_users SET last_client_version=$2 WHERE app_id=$1 AND open_id=$3',[appId,'2.0.7','yesterday']);
 const historical=(await get(0,yesterday)).body;assert.equal(historical.date,yesterday);assert.equal(historical.today,today,'today retains actual Beijing date');assert.equal(historical.total,1);assert.equal(historical.items[0].openid,'yesterday');assert.equal(new Date(historical.items[0].loginAt).getTime(),midnight-1,'historical day includes its last millisecond');assert.equal(historical.hasMore,false);assert.equal(historical.items[0].clientVersion,'2.0.7','historical day reflects the latest reported version, not a per-day snapshot');assert.notEqual(historical.items[0].clientVersion,versionReportedOnHistoricalLoginDay,'a version first reported after that day still applies');assert.deepEqual((await get(50,yesterday)).body.items,[]);
 const future=(await get(0,tomorrow)).body;assert.equal(future.date,tomorrow);assert.equal(future.total,1);assert.equal(future.items[0].openid,'tomorrow','next midnight belongs to the next day');assert.equal(future.items[0].clientVersion,null,'unreported version stays null on other days');
 const empty=(await get(0,'2000-01-01')).body;assert.equal(empty.date,'2000-01-01');assert.equal(empty.total,0);assert.deepEqual(empty.items,[]);assert.equal(empty.hasMore,false);assert.equal(page1.date,today,'omitted date defaults to database Beijing today');
 assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');await assert.rejects(()=>pool.query('UPDATE game_users SET last_login_at=clock_timestamp() WHERE id=$1',[first]));
 await api.post('/h5dashboard/api/logout').set('Origin',config.origin).set('Cookie',cookie).send({}).expect(200);await api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).set('Cookie',cookie).send({offset:0}).expect(401);
});

// Per-login events: every successful login is its own row with the scene reported by that login.
// game_daily_logins remains historical coverage, but only when no event carries that exact
// first_login_at, so a new daily first is not listed twice and history gains no invented scene.
test('per-login events keep their own scene, legacy rows fill only unrecorded firsts and pages stay stable',async t=>{
 const queries=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 const owner=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});await migrate(owner);
 const suffix=randomBytes(5).toString('hex'),appId='loginevent_'+suffix,foreignApp='foreigevt_'+suffix,role='logevt_'+suffix,password='isolated-login-event-test-only';
 await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);await owner.query(`GRANT SELECT ON game_users,game_profiles,game_daily_logins,game_login_events TO ${role}`);await owner.query(`ALTER ROLE ${role} SET default_transaction_read_only=on`);
 const pool=new Pool({connectionString:`postgresql://${role}:${password}@127.0.0.1:15439/minigame_test`,max:2,options:'-c jit=off'}),redis=createClient({url:'redis://127.0.0.1:16389/14'});redis.on('error',()=>{});await redis.connect();
 const {createDashboardServer}=await import(pathToFileURL(resolve('dashboard/backend.js')).href);
 const salt='11223344556677889900112233445566',config={username:'logevent',passwordHash:salt+':'+scryptSync(password,salt,64).toString('hex'),appId,origin:'https://dashboard.example.com',basePath:'/h5dashboard/',environment:'production'};
 const server=createDashboardServer({pool,redis,config,queries});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise<void>(r=>server.close(r));await redis.quit();await pool.end();await owner.query('DELETE FROM game_login_events WHERE app_id=ANY($1::varchar[])',[[appId,foreignApp]]);await owner.query('DELETE FROM game_daily_logins WHERE app_id=ANY($1::varchar[])',[[appId,foreignApp]]);await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])',[[appId,foreignApp]]);await owner.query(`DROP OWNED BY ${role}`);await owner.query(`DROP ROLE ${role}`);await owner.end();});
 const {rows:[clock]}=await owner.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS today, date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS midnight");
 const today=clock.today as string,midnight=new Date(clock.midnight).getTime(),minute=60000,day=86400000;
 async function addUser(app:string,openid:string,opts:{completed?:boolean;created?:number;sourceScene?:number|null;clientVersion?:string|null}={}){
  const uid=randomUUID();
  await owner.query('INSERT INTO game_users(id,app_id,open_id,first_login_completed,last_login_at,last_client_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid,app,openid,opts.completed??true,new Date(midnight+minute),opts.clientVersion??null,new Date(opts.created??(midnight-day))]);
  if(opts.sourceScene!=null)await owner.query('UPDATE game_users SET source_scene=$2,source_scene_reported_at=clock_timestamp() WHERE id=$1',[uid,opts.sourceScene]);
  return uid;
 }
 async function addEvent(app:string,uid:string,at:number,scene:number|null){const {rows:[row]}=await owner.query('INSERT INTO game_login_events(app_id,user_id,login_at,scene) VALUES($1,$2,$3,$4) RETURNING id',[app,uid,new Date(at),scene]);return String(row.id);}
 async function addDaily(app:string,uid:string,at:number){await owner.query("INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,$3)",[app,uid,new Date(at)]);}
 // Repeated same-day logins for one user: three events, one of them without a scene.
 const multi=await addUser(appId,'multi',{sourceScene:1030,created:midnight-2*day,clientVersion:'2.0.7'});
 await addEvent(appId,multi,midnight+minute,1030);await addEvent(appId,multi,midnight+2*minute,1001);await addEvent(appId,multi,midnight+3*minute,null);
 await addDaily(appId,multi,midnight+minute); // new daily first is the exact first event, not an extra row
 // Pure historical coverage: a daily row with no per-login event keeps its old representation.
 const legacy=await addUser(appId,'legacy');
 await addDaily(appId,legacy,midnight+4*minute);
 // A daily row that exactly matches a recorded event must be dropped, even if the event came later.
 const dupe=await addUser(appId,'dupe');
 await addEvent(appId,dupe,midnight+5*minute,1001);await addDaily(appId,dupe,midnight+5*minute);
 // Beijing day boundaries: exact midnight in, 1ms before and next midnight out.
 const bounds=await addUser(appId,'bounds');
 await addEvent(appId,bounds,midnight,1001);await addEvent(appId,bounds,midnight-1,1002);await addEvent(appId,bounds,midnight+day,1003);
 await addDaily(appId,bounds,midnight);
 // Foreign app and an incomplete registration never enter this app's log.
 const foreign=await addUser(foreignApp,'foreign');await addEvent(foreignApp,foreign,midnight+minute,1001);
 const incomplete=await addUser(appId,'incomplete',{completed:false});await addEvent(appId,incomplete,midnight+7*minute,1001);
 // Same-time ties across users, and two events for one user at the same instant.
 const tieA=await addUser(appId,'tie-a'),tieB=await addUser(appId,'tie-b');
 await addEvent(appId,tieA,midnight+8*minute,1001);await addEvent(appId,tieB,midnight+8*minute,1002);
 const twice=await addUser(appId,'twice');
 await addEvent(appId,twice,midnight+9*minute,2001);await addEvent(appId,twice,midnight+9*minute,2002);
 // 55 more logins at one identical timestamp so the page boundary falls inside a wide tie group.
 const fillers:string[]=[];for(let n=0;n<55;n++){const uid=await addUser(appId,'filler-'+String(n).padStart(2,'0'));await addEvent(appId,uid,midnight+10*minute,1001);fillers.push(uid);}
 const api=request(server);await api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).send({offset:0}).expect(401);
 const login=await api.post('/h5dashboard/api/login').set('Origin',config.origin).send({username:config.username,password}).expect(200);const cookie=String((login.headers['set-cookie'] as unknown as string[])[0]).split(';')[0]!;
 const get=(offset:number,date?:string)=>api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).set('Cookie',cookie).send({offset,...(date===undefined?{}:{date})}).expect(200);
 const page1=(await get(0)).body,page2=(await get(50)).body,total=65;
 assert.equal(page1.date,today);assert.equal(page1.today,today);assert.equal(page1.total,total);assert.equal(page1.items.length,50);assert.equal(page1.hasMore,true);
 assert.equal(page2.total,total);assert.equal(page2.items.length,total-50);assert.equal(page2.hasMore,false);const repeatedPage=(await get(50)).body;const {generatedAt:page2GeneratedAt,...stablePage2}=page2;const {generatedAt:repeatedGeneratedAt,...stableRepeatedPage}=repeatedPage;assert.ok(page2GeneratedAt&&repeatedGeneratedAt,'each request retains its database query timestamp');assert.deepEqual(stableRepeatedPage,stablePage2,'the same offset returns the same rows and pagination, not the same query timestamp');
 const combined=[...page1.items,...page2.items];assert.equal(combined.length,total);
 const key=(x:any)=>`${new Date(x.loginAt).toISOString()}|${x.openid}|${x.loginScene}`;assert.equal(new Set(combined.map(key)).size,total,'pages neither duplicate nor drop rows across a tie');
 assert(combined.every((x:any)=>!Object.hasOwn(x,'eventId')&&!Object.hasOwn(x,'id')),'internal bigint event ids are not leaked');
 const expected=(await owner.query(`
   SELECT e.login_at AS "loginAt",e.user_id AS "userId",e.id AS "eventId",e.scene AS "loginScene",u.open_id AS openid,p.nickname,u.source_scene AS "sourceScene",u.created_at AS "registeredAt",u.last_client_version AS "clientVersion"
   FROM game_login_events e JOIN game_users u ON u.app_id=e.app_id AND u.id=e.user_id LEFT JOIN game_profiles p ON p.user_id=u.id
   WHERE e.app_id=$1 AND e.login_at>=$2 AND e.login_at<$3 AND u.first_login_completed
   UNION ALL
   SELECT l.first_login_at,l.user_id,NULL::bigint,NULL::int,u.open_id,p.nickname,u.source_scene,u.created_at,u.last_client_version
   FROM game_daily_logins l JOIN game_users u ON u.app_id=l.app_id AND u.id=l.user_id LEFT JOIN game_profiles p ON p.user_id=u.id
   WHERE l.app_id=$1 AND l.activity_date=$4::date AND u.first_login_completed
     AND NOT EXISTS (SELECT 1 FROM game_login_events e WHERE e.app_id=l.app_id AND e.user_id=l.user_id AND e.login_at=l.first_login_at)
   ORDER BY 1 DESC,2 DESC,3 DESC NULLS LAST`,[appId,new Date(midnight),new Date(midnight+day),today])).rows;
 const strip=(x:any)=>({loginAt:new Date(x.loginAt).toISOString(),openid:x.openid,nickname:x.nickname,sourceScene:x.sourceScene,loginScene:x.loginScene,registeredAt:new Date(x.registeredAt).toISOString(),clientVersion:x.clientVersion});
 assert.deepEqual(combined.map(strip),expected.map(strip),'union, deduplication and order match an independent statement');
 const rowsFor=(openid:string)=>combined.filter((x:any)=>x.openid===openid);
 const repeated=rowsFor('multi');assert.equal(repeated.length,3,'each successful login is its own row');assert.deepEqual(repeated.map((x:any)=>x.loginScene),[null,1001,1030],'newest first, own scene each');assert(repeated.every((x:any)=>x.sourceScene===1030),'first registration source stays separate and unchanged');
 assert.equal(rowsFor('legacy').length,1);assert.equal(rowsFor('legacy')[0].loginScene,null,'historical compatibility row carries no invented scene');assert.equal(rowsFor('legacy')[0].sourceScene,null);
 assert.equal(rowsFor('dupe').length,1,'daily row exactly matched by an event is not duplicated');assert.equal(rowsFor('dupe')[0].loginScene,1001);
 assert.equal(rowsFor('bounds').length,1,'only the inclusive Beijing midnight event belongs to today');assert.equal(new Date(rowsFor('bounds')[0].loginAt).getTime(),midnight);
 assert.equal(rowsFor('foreign').length,0);assert.equal(rowsFor('incomplete').length,0);
 assert.equal(rowsFor('tie-a').length+rowsFor('tie-b').length,2);assert.equal(combined.findIndex(x=>x.openid==='tie-a')<combined.findIndex(x=>x.openid==='tie-b'),String(tieA)>String(tieB),'same-time rows order by uid DESC');
 assert.deepEqual(rowsFor('twice').map((x:any)=>x.loginScene),[2002,2001],'same user and instant order by event id DESC');
 const yesterday=new Date(midnight-day+8*3600000).toISOString().slice(0,10);
 const historical=(await get(0,yesterday)).body;assert.equal(historical.date,yesterday);assert.equal(historical.today,today);assert.equal(historical.total,1);assert.equal(historical.items[0].openid,'bounds');assert.equal(historical.items[0].loginScene,1002);assert.equal(new Date(historical.items[0].loginAt).getTime(),midnight-1,'1ms before Beijing midnight belongs to the previous day');assert.equal(historical.hasMore,false);
 const tomorrow=new Date(midnight+day+8*3600000).toISOString().slice(0,10);
 const next=(await get(0,tomorrow)).body;assert.equal(next.date,tomorrow);assert.equal(next.total,1);assert.equal(next.items[0].openid,'bounds');assert.equal(next.items[0].loginScene,1003,'next midnight belongs to the next day');
 assert.equal((await get(0,'2000-01-01')).body.total,0);
 assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
 await assert.rejects(()=>pool.query("INSERT INTO game_login_events(app_id,user_id,login_at,scene) VALUES($1,$2,clock_timestamp(),1001)",[appId,multi]),'the dashboard role cannot write login events');
 const filtered=(openid:string,offset=0,date=today)=>api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).set('Cookie',cookie).send({openid,offset,date}).expect(200);
 for(const openid of ['multi','legacy','dupe','bounds','absent','incomplete','foreign','MULTI']){
  const result=(await filtered(openid)).body;
  assert.equal(result.openid,openid);assert.equal(result.total,rowsFor(openid).length);
  assert.deepEqual(result.items.map(strip),rowsFor(openid).map(strip));assert.equal(result.hasMore,false);
 }
 assert.equal((await filtered('bounds',0,yesterday)).body.items[0].loginScene,1002);
 const foreignMulti=await addUser(foreignApp,'multi');await addEvent(foreignApp,foreignMulti,midnight+11*minute,1001);
 const prefix=await addUser(appId,'multi-extra');await addEvent(appId,prefix,midnight+11*minute,1001);
 for(let n=0;n<55;n++)await addEvent(appId,multi,midnight+(12+n)*minute,1001);
 const filteredFirst=(await filtered('multi')).body,filteredNext=(await filtered('multi',50)).body;
 assert.equal(filteredFirst.total,58);assert.equal(filteredFirst.items.length,50);assert.equal(filteredFirst.hasMore,true);
 assert.equal(filteredNext.total,58);assert.equal(filteredNext.items.length,8);assert.equal(filteredNext.hasMore,false);
 assert([...filteredFirst.items,...filteredNext.items].every((x:any)=>x.openid==='multi'),'openid equality excludes prefixes and foreign apps');
 assert.deepEqual((await filtered('multi',100)).body.items,[]);
 await api.post('/h5dashboard/api/logout').set('Origin',config.origin).set('Cookie',cookie).send({}).expect(200);await api.post('/h5dashboard/api/login-logs').set('Origin',config.origin).set('Cookie',cookie).send({offset:0}).expect(401);
});
