import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import {loadConfig} from '../src/config.js';
import {migrate} from '../src/database/migrate.js';

const DATABASE='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';

// Production stage leaderboard is inclusive at 101 while boss keeps its 30 threshold.
test('stage leaderboard qualifies from 101 and rebuilds a 300-policy index from clean 101..299 history',async t=>{
 const owner=new Pool({connectionString:DATABASE});
 const redis=createClient({url:'redis://127.0.0.1:16389/15'});redis.on('error',()=>{});
 const appId='wx'+randomBytes(8).toString('hex');
 const build=resolve(process.env.MINIGAME_TEST_DIST_DIR??'dist');
 let app:any;
 t.after(async()=>{await app?.close();if(redis.isOpen){await redis.flushDb();await redis.quit();}await owner.query('DELETE FROM game_users WHERE app_id=$1',[appId]);await owner.end();});
 await migrate(owner);await redis.connect();await redis.flushDb();
 const ids=(await owner.query("INSERT INTO game_users(app_id,open_id) SELECT $1,'stage101_'||n FROM generate_series(1,6) n RETURNING id",[appId])).rows.map(r=>r.id as string);
 const [a,b,c,d,low,tiny]=ids as [string,string,string,string,string,string];
 const config=loadConfig({WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'explicit-leaderboard-stub',DATABASE_URL:DATABASE,REDIS_URL:'redis://127.0.0.1:16389/15'});
 const {createApplication}=await import(pathToFileURL(resolve(build,'application.js')).href);
 app=await createApplication(config);await app.listen(0,'127.0.0.1');
 const board=(type='stage')=>`minigame:leaderboard:${appId}:${type}`;
 async function session(userId:string){const token=randomBytes(32).toString('base64url');await redis.set('minigame:session:'+createHash('sha256').update(token).digest('hex'),JSON.stringify({appId,userId}),{EX:300});return token;}
 const token=await session(a),lowToken=await session(low);
 async function call(path:string,body:unknown,access:string,status=200){
  const result=await fetch(`http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/leaderboards/`+path,{method:'POST',headers:{'content-type':'application/json',...(access?{authorization:'Bearer '+access}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const json=await result.json() as any;assert.equal(result.status,status,`${path}: ${JSON.stringify(json)}`);return json;
 }
 const report=async(value:number,type='stage',access=token)=>await call('report',{type,value},access);
 const list=async(type='stage',access=token)=>await call('list',{type},access);
 const runId=()=>/^run_id:([^\r\n]+)/m.exec(String(redisServer))![1]!;
 let redisServer='';
 t.beforeEach(async()=>{
  await owner.query('DELETE FROM game_leaderboard_scores WHERE app_id=$1',[appId]);
  await redis.del([board(),board('boss')]);
  redisServer=await redis.info('server');
 });
 await t.test('stage 101 qualifies inclusively, 100 stays durably unranked and boss still starts at 30',async()=>{
  assert.deepEqual(await list(),{type:'stage',entries:[],self:{userId:a,rank:null,value:null,nickname:'游客',avatarUrl:''}});
  assert.deepEqual(await report(100),{type:'stage',value:100,rank:null,improved:true});
  assert.equal(await redis.zScore(board(),a),null);assert.equal((await list()).self.value,100);
  assert.deepEqual(await report(101),{type:'stage',value:101,rank:1,improved:true});
  assert.deepEqual(await report(100),{type:'stage',value:101,rank:1,improved:false});
  assert.equal(await redis.zScore(board(),a),101);assert.equal((await list()).self.rank,1);
  assert.deepEqual(await report(29,'boss'),{type:'boss',value:29,rank:null,improved:true});
  assert.equal(await redis.zScore(board('boss'),a),null);
  assert.deepEqual(await report(30,'boss'),{type:'boss',value:30,rank:1,improved:true});
  assert.equal(await redis.zScore(board('boss'),a),30);
 });
 await t.test('a ready index published under the old 300 policy is rebuilt from clean 101..299 history',async()=>{
  const runIdValue=runId();
  await owner.query('INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value,dirty) VALUES($1,\'stage\',$2,299,false),($1,\'stage\',$3,260,false),($1,\'stage\',$4,101,false),($1,\'stage\',$5,100,false),($1,\'stage\',$6,99,false)',[appId,b,c,d,low,tiny]);
  await redis.zAdd(board(),[{score:-1,value:'__ready__'},{score:299,value:b}]);
  await redis.set(board()+':epoch',runIdValue+':min=300');
  const result=await list('stage',lowToken);
  assert.deepEqual(result.entries.map((r:any)=>[r.userId,r.value,r.rank]),[[b,299,1],[c,260,2],[d,101,3]]);
  assert.equal(result.self.rank,null);assert.equal(result.self.value,100);
  assert.equal(await redis.get(board()+':epoch'),runIdValue+':min=101');
  assert.equal(await redis.zScore(board(),low),null);assert.equal(await redis.zScore(board(),tiny),null);
  assert.equal(await redis.zCard(board()),4);
  assert.deepEqual((await owner.query("SELECT user_id,value,dirty FROM game_leaderboard_scores WHERE app_id=$1 AND board_type='stage' ORDER BY value DESC",[appId])).rows.map((r:any)=>[r.user_id,r.value,r.dirty]),[[b,299,false],[c,260,false],[d,101,false],[low,100,false],[tiny,99,false]]);
  await redis.unlink(board());
  const rebuilt=await list('stage',lowToken);
  assert.deepEqual(rebuilt.entries,result.entries);
  assert.equal(await redis.get(board()+':epoch'),runIdValue+':min=101');
  assert.equal(await redis.zCard(board()),4);
 });
 await t.test('the boss board threshold and its old 50-policy index are unaffected by the stage change',async()=>{
  const runIdValue=runId();
  await owner.query("INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value,dirty) VALUES($1,'boss',$2,50,false),($1,'boss',$3,30,false),($1,'boss',$4,29,false)",[appId,b,c,d]);
  await redis.zAdd(board('boss'),[{score:-1,value:'__ready__'},{score:50,value:b}]);
  await redis.set(board('boss')+':epoch',runIdValue+':min=50');
  const result=await list('boss');
  assert.deepEqual(result.entries.map((r:any)=>[r.userId,r.value]),[[b,50],[c,30]]);
  assert.equal(await redis.get(board('boss')+':epoch'),runIdValue+':min=30');
  assert.equal(await redis.zScore(board('boss'),d),null);
 });
});
