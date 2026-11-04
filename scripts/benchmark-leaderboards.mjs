import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,relative,dirname} from 'node:path';
import os from 'node:os';

// Every connection is checked BEFORE loading application code or opening clients.
// Deliberately ignore DATABASE_URL, REDIS_URL and all .env files.
export function loadBenchmarkConfig(env=process.env){
 const databaseUrl=env.LEADERBOARD_BENCHMARK_DATABASE_URL??'postgresql://minigame_benchmark:disposable_benchmark_only@127.0.0.1:15442/minigame_benchmark';
 const redisUrl=env.LEADERBOARD_BENCHMARK_REDIS_URL??'redis://127.0.0.1:16392/0';
 const db=new URL(databaseUrl),redis=new URL(redisUrl);
 assert.equal(db.protocol,'postgresql:');assert.equal(db.hostname,'127.0.0.1');assert.equal(db.port,'15442');assert.equal(db.pathname,'/minigame_benchmark');assert.equal(db.username,'minigame_benchmark');assert.equal(db.password,'disposable_benchmark_only');assert.equal(db.search,'');assert.equal(db.hash,'');
 assert.equal(redis.protocol,'redis:');assert.equal(redis.hostname,'127.0.0.1');assert.equal(redis.port,'16392');assert.equal(redis.pathname,'/0');assert.equal(redis.username,'');assert.equal(redis.password,'');assert.equal(redis.search,'');assert.equal(redis.hash,'');
 return {databaseUrl,redisUrl};
}

export async function measureWorkload({name,requests,concurrency,operation}){
 assert.ok(Number.isSafeInteger(requests)&&requests>0);assert.ok(Number.isSafeInteger(concurrency)&&concurrency>0);
 const latencies=[];let next=0,errors=0;const started=performance.now();
 await Promise.all(Array.from({length:Math.min(concurrency,requests)},async()=>{
  while(next<requests){const i=next++;const before=performance.now();try{await operation(i);}catch{errors++;}finally{latencies.push(performance.now()-before);}}
 }));
 const durationMs=performance.now()-started;latencies.sort((a,b)=>a-b);
 const percentile=p=>latencies[Math.max(0,Math.ceil(latencies.length*p)-1)];
 return {name,model:'closed-loop',requests,concurrency,successes:requests-errors,errors,durationMs,throughputPerSecond:requests*1000/durationMs,latencyMs:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99),min:latencies[0],max:latencies.at(-1)}};
}

const APP_ID='wxbbbbbbbbbbbbbbbb';
const uid=i=>`b0000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const boardKey=type=>`minigame:leaderboard:${APP_ID}:${type}`;
const uidSql="('b0000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function safeArtifact(path,suffix){
 const absolute=resolve(path),root=resolve('tmp/leaderboards');
 assert.ok(absolute.startsWith(root+'/')&&absolute.endsWith(suffix),'artifact must be inside tmp/leaderboards');return absolute;
}
async function save(path,data){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(path+'.tmp',path);}
async function allKeys(redis,pattern){const found=[];for await(const keys of redis.scanIterator({MATCH:pattern,COUNT:500}))found.push(...keys);return found;}
async function removeKeys(redis,keys){for(let i=0;i<keys.length;i+=500)await redis.del(keys.slice(i,i+500));}

async function cleanFixtures(pool,redis,sessionKeys){
 const foreign=await pool.query('SELECT count(*)::int AS n FROM game_users WHERE app_id<>$1',[APP_ID]);
 assert.equal(foreign.rows[0].n,0,'refuse to truncate foreign fixtures');
 await pool.query('TRUNCATE game_users CASCADE');
 await removeKeys(redis,[...sessionKeys,...await allKeys(redis,`*${APP_ID}*`)]);
 const users=await pool.query('SELECT count(*)::int AS n FROM game_users');
 return {remainingUsers:users.rows[0].n,remainingRedisKeys:await redis.dbSize()};
}

async function seed(pool,players){
 const start=performance.now();
 // Batches bound single-query time, WAL bursts and JS memory; no million-item JS arrays.
 for(let first=1;first<=players;first+=10000){
  const last=Math.min(players,first+9999);
  await pool.query(`INSERT INTO game_users(id,app_id,open_id) SELECT ${uidSql},$1,'lb:'||i FROM generate_series($2::int,$3::int) i`,[APP_ID,first,last]);
  await pool.query(`INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value,dirty) SELECT $1,'stage',${uidSql},(500 + floor(i/2.0))::int,false FROM generate_series($2::int,$3::int) i`,[APP_ID,first,last]);
 }
 // Only the top30+self need uploaded profile fixtures; everyone else exercises fallback.
 await pool.query(`INSERT INTO game_profiles(user_id,nickname,avatar_url) SELECT id,'bench-'||right(id::text,6),'https://example.invalid/benchmark.png' FROM game_users WHERE app_id=$1 AND (id=$2::uuid OR id>=$3::uuid)`,[APP_ID,uid(1),uid(players-29)]);
 await pool.query('ANALYZE game_users');await pool.query('ANALYZE game_leaderboard_scores');
 return performance.now()-start;
}

async function tokensFor(redis,players,sessionKeys){
 const tokens=[];const batch=redis.multi();
 for(let i=1;i<=Math.min(players,1000);i++){
  const token=randomBytes(32).toString('base64url');const key='minigame:session:'+createHash('sha256').update(token).digest('hex');
  sessionKeys.push(key);tokens.push(token);batch.set(key,JSON.stringify({appId:APP_ID,userId:uid(i),isNewUser:false}),{EX:3600});
 }
 await batch.exec();return tokens;
}

async function runScale({players,smoke,pool,redis,post,probeList,sessionKeys,tokens,state}){
 const record={players,verified:false,assertions:{},workloads:[]};state.scales.push(record);
 state.phase=`seed:${players}`;record.seedMs=await seed(pool,players);
 state.phase=`rebuild:${players}`;
 const rebuildStart=performance.now();const first=await post('list',{type:'stage'},tokens[0],120000);
 record.rebuildMs=performance.now()-rebuildStart;
 assert.equal(first.entries.length,30);assert.equal(first.self.userId,uid(1));assert.equal(first.self.rank,players);assert.equal(first.self.value,500);
 assert.ok(!first.entries.some(e=>e.userId===uid(1)));record.assertions.selfOutsideTop30=true;
 // Exact pairs verify integer score descending, then canonical UUID descending.
 const expected=Array.from({length:30},(_,i)=>({userId:uid(players-i),rank:i+1,value:500 + Math.floor((players-i)/2)}));
 assert.deepEqual(first.entries.map(({userId,rank,value})=>({userId,rank,value})),expected);record.assertions.uidDescendingTies=true;
 assert.equal(first.entries[0].nickname,`bench-${uid(players).slice(-6)}`);
 assert.equal(await redis.zCard(boardKey('stage')),players+1);assert.equal(await redis.zScore(boardKey('stage'),'__ready__'),-1);
 record.assertions.authenticatedHttp=true;
 record.listQueryProbe=await probeList(tokens[0]);
 assert.equal(record.listQueryProbe.profileQueries,1);assert.ok(record.listQueryProbe.maxProfileIds<=31);assert.equal(record.listQueryProbe.globalRankingSql,0);
 const same=await post('report',{type:'stage',value:500},tokens[0]);assert.equal(same.value,500);assert.equal(same.improved,false);
 const maximum=players+600;const raised=await post('report',{type:'stage',value:maximum},tokens[0]);assert.equal(raised.value,maximum);assert.equal(raised.improved,true);assert.equal(raised.rank,1);
 const lower=await post('report',{type:'stage',value:1},tokens[0]);assert.equal(lower.value,maximum);assert.equal(lower.improved,false);
 const below=await post('report',{type:'boss',value:29},tokens[0],120000);assert.equal(below.value,29);assert.equal(below.rank,null);assert.equal(await redis.zScore(boardKey('boss'),uid(1)),null);
 const belowList=await post('list',{type:'boss'},tokens[0]);assert.deepEqual(belowList.entries,[]);assert.equal(belowList.self.value,29);assert.equal(belowList.self.rank,null);
 const boss=await post('report',{type:'boss',value:30},tokens[0]);assert.equal(boss.value,30);assert.equal(boss.rank,1);record.assertions.entryThresholds=true;
 const bossList=await post('list',{type:'boss'},tokens[0]);assert.equal(bossList.entries.length,1);assert.equal(bossList.self.value,30);assert.equal(bossList.self.rank,1);
 const stageList=await post('list',{type:'stage'},tokens[0]);assert.equal(stageList.entries.length,30);assert.equal(stageList.self.value,maximum);
 const db=await pool.query('SELECT board_type,value FROM game_leaderboard_scores WHERE app_id=$1 AND user_id=$2 ORDER BY board_type',[APP_ID,uid(1)]);
 assert.deepEqual(db.rows,[{board_type:'boss',value:30},{board_type:'stage',value:maximum}]);
 record.assertions.historicalMaximum=true;record.assertions.stageBossIsolation=true;record.assertions.databasePersistence=true;
 record.contractExamples={report:raised,list:{type:first.type,firstEntry:first.entries[0],self:first.self}};
 record.rows={stage:Number((await pool.query("SELECT count(*) AS n FROM game_leaderboard_scores WHERE app_id=$1 AND board_type='stage'",[APP_ID])).rows[0].n),boss:1};
 record.redis={indexKey:boardKey('stage'),indexBytes:Number(await redis.sendCommand(['MEMORY','USAGE',boardKey('stage')])),members:await redis.zCard(boardKey('stage'))};
 const table=await pool.query("SELECT pg_total_relation_size('game_users')::text AS users_bytes,pg_total_relation_size('game_leaderboard_scores')::text AS scores_bytes,pg_database_size(current_database())::text AS database_bytes");
 record.postgres={usersTableAndIndexesBytes:Number(table.rows[0].users_bytes),scoresTableAndIndexesBytes:Number(table.rows[0].scores_bytes),databaseBytes:Number(table.rows[0].database_bytes)};

 state.phase=`steady:${players}`;
 const requests=smoke?20:1000;const rawUsers=Math.min(players,1000);
 const originals=(await pool.query("SELECT user_id::text,value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type='stage' ORDER BY user_id LIMIT $2",[APP_ID,rawUsers])).rows;
 for(const concurrency of [1,smoke?5:20]){
  for(const action of ['update','rank','top30']){
   const operation=action==='update'?i=>redis.zAdd(boardKey('stage'),[{score:3000000+concurrency*1000+i,value:uid(i%rawUsers+1)}],{GT:true}):
    action==='rank'?i=>redis.zRevRank(boardKey('stage'),uid(i%rawUsers+1)):()=>redis.zRangeWithScores(boardKey('stage'),0,29,{REV:true});
   record.workloads.push(await measureWorkload({name:`redis-${action}`,requests,concurrency,operation}));
  }
 }
 // Raw Redis updates really changed index scores. Restore SQL-authoritative values
 // before measuring HTTP; the measured production path never uses mocked storage.
 const restore=redis.multi();for(const row of originals)restore.zAdd(boardKey('stage'),[{score:row.value,value:row.user_id}]);await restore.exec();
 for(const concurrency of [1,smoke?5:20]){
  record.workloads.push(await measureWorkload({name:'http-list',requests,concurrency,operation:i=>post('list',{type:'stage'},tokens[i%tokens.length])}));
  record.workloads.push(await measureWorkload({name:'http-report-new-max',requests,concurrency,operation:async i=>{
   const value=4000000+concurrency*10000+i;const result=await post('report',{type:'stage',value},tokens[i%tokens.length]);assert.equal(result.value,value);assert.equal(result.improved,true);
  }}));
 }
 assert.equal(record.workloads.reduce((n,x)=>n+x.errors,0),0,'steady-state workload errors');
 const durable=await pool.query("SELECT value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type='stage' AND user_id=$2",[APP_ID,uid(1)]);
 assert.ok(durable.rows[0].value>=4000000);
 const measuredUsers=Math.min(requests,tokens.length),finalBase=4000000+(smoke?5:20)*10000;
 const persisted=await pool.query("SELECT count(*)::int AS n FROM game_leaderboard_scores WHERE app_id=$1 AND board_type='stage' AND user_id<=$2::uuid AND value=$3::int+right(user_id::text,12)::bigint-1",[APP_ID,uid(measuredUsers),finalBase]);
 record.durableMeasuredReportRows=persisted.rows[0].n;assert.equal(record.durableMeasuredReportRows,measuredUsers);
 const projected=await redis.zmScore(boardKey('stage'),Array.from({length:measuredUsers},(_,i)=>uid(i+1)));
 record.projectedMeasuredReportRows=projected.filter((value,i)=>value===finalBase+i).length;assert.equal(record.projectedMeasuredReportRows,measuredUsers);
 record.nodeMemory=process.memoryUsage();record.verified=true;return record;
}

export async function main(){
 const config=loadBenchmarkConfig();
 if(process.argv.includes('--validate-only')){console.log(JSON.stringify({safe:true,database:'127.0.0.1:15442/minigame_benchmark',redis:'127.0.0.1:16392/0'}));return;}
 const smoke=process.argv.includes('--smoke'),full=process.argv.includes('--run');
 if(!smoke&&!full){console.log('Usage: node scripts/benchmark-leaderboards.mjs --validate-only | --smoke | --run [--output tmp/leaderboards/benchmark-results.json] [--dist tmp/leaderboards/benchmark-dist]');return;}
 assert.ok(!(smoke&&full),'choose smoke or full');
 const arg=(name,fallback)=>{const index=process.argv.indexOf(name);return index<0?fallback:process.argv[index+1];};
 const output=safeArtifact(arg('--output',smoke?'tmp/leaderboards/benchmark-smoke-results.json':'tmp/leaderboards/benchmark-results.json'),'.json');
 const dist=safeArtifact(arg('--dist','tmp/leaderboards/benchmark-dist'),'');
 const state={schemaVersion:1,mode:smoke?'smoke':'full',complete:false,startedAt:new Date().toISOString(),phase:'loading',scales:[],limits:{postgres:{memoryMiB:768,cpus:1,sharedBuffersMiB:32,maxWalMiB:64,jit:false,tmpfs:true},redis:{memoryMiB:384,cpus:1,maxmemoryMiB:256,policy:'noeviction',persistence:false},node:{memoryLimit:'not capped separately',sharesHostWithOtherServices:true}},environment:{node:process.version,platform:os.platform(),arch:os.arch(),hostCpus:os.cpus().length,hostMemoryBytes:os.totalmem()},methodology:{model:'closed-loop',network:'same-host loopback HTTP',authentication:'fresh synthetic opaque sessions in isolated Redis; no external WeChat requests',scores:'SQL deterministic stage seed>=500 (all qualify at stage>=101); boss boundary29/30; real application projection rebuild, real PostgreSQL historical-max writes',rawRedis:'existing production-format index; actual GT updates then SQL-authoritative restoration before HTTP',productionCapacityClaim:false,seedAndRebuildExcludedFromSteadyState:true,thresholds:{stage:101,boss:30},allQualified:true}};
 const digestFile=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
 state.provenance={candidateDirectory:relative(process.cwd(),dist),candidateFiles:{},migration007Sha256:await digestFile('migrations/007_leaderboards.sql'),composeSha256:await digestFile('compose.leaderboard-benchmark.yaml'),harnessSha256:await digestFile('scripts/benchmark-leaderboards.mjs')};
 for(const file of ['application.js','infrastructure.js','leaderboards/leaderboards.service.js','leaderboards/leaderboards.controller.js'])state.provenance.candidateFiles[file]=await digestFile(resolve(dist,file));
 state.methodology.seedDirty=false;state.methodology.seedDirtyExplanation='Previously-synced durable scores with lost Redis cache; automatic core rebuild measured separately. No pending-outbox backlog during steady-state.';
 await save(output,state);
 const [{Pool},{createClient},{createApplication},{loadConfig},{migrate},{Infrastructure}]=await Promise.all([import('pg'),import('redis'),import(pathToFileURL(resolve(dist,'application.js')).href),import(pathToFileURL(resolve(dist,'config.js')).href),import(pathToFileURL(resolve(dist,'database/migrate.js')).href),import(pathToFileURL(resolve(dist,'infrastructure.js')).href)]);
 const pool=new Pool({connectionString:config.databaseUrl,max:2,connectionTimeoutMillis:3000,statement_timeout:120000,query_timeout:125000,application_name:'isolated-leaderboard-benchmark'});
 const redis=createClient({url:config.redisUrl,disableOfflineQueue:true,socket:{reconnectStrategy:false,connectTimeout:3000}});redis.on('error',()=>{});
 const sessionKeys=[];let app;let cleanAllowed=false;
 try{
  state.phase='migrate';await redis.connect();assert.equal(await redis.dbSize(),0,'benchmark Redis must start empty');
  await migrate(pool);assert.equal(Number((await pool.query('SELECT count(*) AS n FROM game_users')).rows[0].n),0,'benchmark database must start empty');cleanAllowed=true;
  const settings=await pool.query("SELECT version() AS version,current_setting('shared_buffers') AS shared_buffers,current_setting('jit') AS jit,current_setting('max_wal_size') AS max_wal_size");state.environment.postgres=settings.rows[0];
  const redisInfo=await redis.info('server');state.environment.redisVersion=/redis_version:([^\r\n]+)/.exec(redisInfo)?.[1];state.environment.redisConfig=await redis.configGet(['maxmemory','maxmemory-policy']);
  const appConfig=loadConfig({WECHAT_APP_ID:APP_ID,WECHAT_APP_SECRET:'benchmark-only-no-upstream',DATABASE_URL:config.databaseUrl,REDIS_URL:config.redisUrl,HOST:'127.0.0.1',PORT:'18749'});
  app=await createApplication(appConfig);await app.listen(0,'127.0.0.1');const address=app.getHttpServer().address();assert.equal(address.address,'127.0.0.1');
  state.environment.http='127.0.0.1:'+address.port;
  async function post(action,body,token,timeout=15000){
   const response=await fetch(`http://127.0.0.1:${address.port}/h5login/api/leaderboards/${action}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
   assert.equal(response.status,200,`HTTP ${action} status ${response.status}`);assert.equal(response.headers.get('cache-control'),'no-store');return response.json();
  }
  async function probeList(token){
   const apiPool=app.get(Infrastructure).pool,original=apiPool.query,queries=[];
   apiPool.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'';const values=Array.isArray(args[1])?args[1]:args[0]?.values??[];queries.push({sql,arraySizes:values.filter(Array.isArray).map(x=>x.length)});return original.apply(this,args);};
   try{await post('list',{type:'stage'},token);}finally{apiPool.query=original;}
   const profiles=queries.filter(q=>/game_profiles/i.test(q.sql));
   return {totalQueries:queries.length,profileQueries:profiles.length,maxProfileIds:Math.max(0,...profiles.flatMap(q=>q.arraySizes)),globalRankingSql:queries.filter(q=>/game_leaderboard_scores/i.test(q.sql)&&/row_number|dense_rank|rank\s*\(|order\s+by\s+(?:[a-z]+\.)?value/i.test(q.sql)).length,sqlTemplates:queries.map(q=>q.sql)};
  }
  const anonymous=await fetch(`http://127.0.0.1:${address.port}/h5login/api/leaderboards/list`,{method:'POST',headers:{'content-type':'application/json'},body:'{"type":"stage"}',signal:AbortSignal.timeout(5000)});assert.equal(anonymous.status,401);
  for(const players of smoke?[40]:[10000,100000,1000000]){
   const tokens=await tokensFor(redis,players,sessionKeys);
   await runScale({players,smoke,pool,redis,post,probeList,sessionKeys,tokens,state});await save(output,state);
   state.phase=`cleanup:${players}`;state.cleanup=await cleanFixtures(pool,redis,sessionKeys);sessionKeys.length=0;
   assert.equal(state.cleanup.remainingUsers,0);assert.equal(state.cleanup.remainingRedisKeys,0);
   await save(output,state);console.log(JSON.stringify({players,verified:true,output:relative(process.cwd(),output)}));
   // Give bounded cgroups a scheduling break; never change service rate limits.
   await sleep(100);
  }
  state.complete=true;
 }catch(error){state.failure={phase:state.phase,name:error.name,code:error.code??null};if(error.code==='ERR_ASSERTION')state.failure.assertion={actual:error.actual,expected:error.expected};throw error;}
 finally{
  try{if(app)await app.close();}finally{
   if(cleanAllowed&&redis.isOpen){try{state.cleanup=await cleanFixtures(pool,redis,sessionKeys);}catch{state.cleanup={failed:true};state.complete=false;}}
   if(redis.isOpen)await redis.quit();await pool.end();state.finishedAt=new Date().toISOString();await save(output,state);
  }
 }
 assert.equal(state.complete,true);assert.equal(state.cleanup.remainingUsers,0);assert.equal(state.cleanup.remainingRedisKeys,0);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('LEADERBOARD_BENCHMARK_FAILED');process.exitCode=1;});
