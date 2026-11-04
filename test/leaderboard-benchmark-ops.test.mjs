import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {readFile,rm} from 'node:fs/promises';


test('closed-loop workload measures every real operation and records failures without inventing samples',async()=>{
 const {measureWorkload}=await import('../scripts/benchmark-leaderboards.mjs');assert.equal(typeof measureWorkload,'function','benchmark must implement measured closed-loop operations');
 let active=0,max=0,calls=0;
 const result=await measureWorkload({name:'test',requests:12,concurrency:3,operation:async i=>{
  active++;max=Math.max(max,active);calls++;await new Promise(r=>setTimeout(r,2));active--;if(i===4)throw new Error('safe-test-error');
 }});
 assert.equal(calls,12);assert.equal(max,3);assert.equal(result.requests,12);assert.equal(result.successes,11);assert.equal(result.errors,1);
 assert.ok(result.durationMs>0);assert.ok(result.latencyMs.p50>0);assert.ok(result.latencyMs.p99>=result.latencyMs.p95);assert.ok(result.latencyMs.p95>=result.latencyMs.p50);
 assert.ok(result.throughputPerSecond>0);assert.equal(result.model,'closed-loop');
});

test('opt-in isolated real smoke verifies HTTP, PostgreSQL, Redis, max/ties/self/isolation and cleanup',{skip:process.env.LEADERBOARD_BENCHMARK_TEST_REAL!=='1',timeout:180000},async()=>{
 const output='tmp/leaderboards/benchmark-smoke-test-results.json';await rm(output,{force:true});
 const r=spawnSync(process.execPath,['scripts/benchmark-leaderboards.mjs','--smoke','--output',output],{encoding:'utf8',timeout:170000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
 assert.equal(r.status,0,r.stderr);const data=JSON.parse(await readFile(output,'utf8'));
 assert.equal(data.complete,true);assert.equal(data.mode,'smoke');assert.deepEqual(data.scales.map(x=>x.players),[40]);
 assert.equal(data.cleanup.remainingUsers,0);assert.equal(data.cleanup.remainingRedisKeys,0);
 assert.deepEqual(data.methodology.thresholds,{stage:101,boss:30});assert.equal(data.methodology.allQualified,true);
 assert.equal(data.scales[0].redis.members,41);assert.equal(data.scales[0].contractExamples.list.self.value,500);
 const scale=data.scales[0];assert.equal(scale.verified,true);assert.equal(scale.rows.stage,40);assert.equal(scale.rows.boss,1);
 for(const key of ['historicalMaximum','uidDescendingTies','selfOutsideTop30','stageBossIsolation','databasePersistence','authenticatedHttp','entryThresholds'])assert.equal(scale.assertions[key],true,key);
 for(const workload of scale.workloads){assert.equal(workload.errors,0,workload.name);assert.ok(workload.requests>0);assert.ok(workload.latencyMs.p99>0);}
 assert.ok(scale.redis.indexBytes>0);assert.ok(scale.postgres.databaseBytes>0);assert.ok(scale.rebuildMs>=0);
 assert.equal(scale.listQueryProbe.profileQueries,1);assert.ok(scale.listQueryProbe.maxProfileIds<=31);assert.equal(scale.listQueryProbe.globalRankingSql,0);
 assert.equal(scale.durableMeasuredReportRows,20);assert.equal(scale.projectedMeasuredReportRows,20);
 assert.match(data.provenance.candidateFiles['leaderboards/leaderboards.service.js'],/^[a-f0-9]{64}$/);
});
const script='scripts/benchmark-leaderboards.mjs';
test('benchmark report metadata uses the current stage101/boss30 policy',async()=>{
 const source=await readFile(script,'utf8');
 assert.match(source,/thresholds:\{stage:101,boss:30\}/);
 assert.doesNotMatch(source,/all qualify at stage>=300/);
});
test('benchmark has no destructive default: explicit --run or --smoke is required',()=>{
 const r=spawnSync(process.execPath,[script],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/--run/);assert.match(r.stdout,/--smoke/);
});
function run(env={}){return spawnSync(process.execPath,[script,'--validate-only'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,...env}});}
test('leaderboard benchmark explicitly validates only its disposable loopback endpoints',()=>{
 const r=run();assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{safe:true,database:'127.0.0.1:15442/minigame_benchmark',redis:'127.0.0.1:16392/0'});
});
test('benchmark ignores inherited production URLs and refuses unsafe overrides before a full run',()=>{
 const inherited=run({DATABASE_URL:'postgresql://private-secret@production.example:5432/live',REDIS_URL:'redis://production.example:6379/0'});
 assert.equal(inherited.status,0,inherited.stderr);assert.equal(JSON.parse(inherited.stdout).safe,true);
 for(const suffix of ['?host=production.example','#fragment']){
  const r=spawnSync(process.execPath,[script,'--run'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,LEADERBOARD_BENCHMARK_DATABASE_URL:'postgresql://minigame_benchmark:disposable_benchmark_only@127.0.0.1:15442/minigame_benchmark'+suffix}});
  assert.equal(r.status,1);assert.equal(r.stderr.trim(),'LEADERBOARD_BENCHMARK_FAILED');assert.doesNotMatch(r.stdout+r.stderr,/production|private-secret|postgresql:/);
 }
});

test('leaderboard benchmark refuses production, staging, integration, public hosts and borrowed credentials',()=>{
 const bad=[{LEADERBOARD_BENCHMARK_DATABASE_URL:'postgresql://minigame_benchmark:private-secret@127.0.0.1:15440/minigame'}, {LEADERBOARD_BENCHMARK_DATABASE_URL:'postgresql://minigame_benchmark:private-secret@127.0.0.1:15441/minigame_staging'}, {LEADERBOARD_BENCHMARK_DATABASE_URL:'postgresql://minigame_benchmark:private-secret@127.0.0.1:15439/minigame_test'}, {LEADERBOARD_BENCHMARK_DATABASE_URL:'postgresql://minigame_benchmark:private-secret@db.example.com:15442/minigame_benchmark'}, {LEADERBOARD_BENCHMARK_DATABASE_URL:'postgresql://postgres:private-secret@127.0.0.1:15442/minigame_benchmark'}, {LEADERBOARD_BENCHMARK_REDIS_URL:'redis://127.0.0.1:16390/0'}, {LEADERBOARD_BENCHMARK_REDIS_URL:'redis://127.0.0.1:16391/0'}, {LEADERBOARD_BENCHMARK_REDIS_URL:'redis://127.0.0.1:16389/15'}, {LEADERBOARD_BENCHMARK_REDIS_URL:'redis://remote.example.com:16392/0'}, {LEADERBOARD_BENCHMARK_REDIS_URL:'redis://user:private-secret@127.0.0.1:16392/0'}];
 for(const env of bad){const r=run(env);assert.equal(r.status,1,JSON.stringify(env));assert.equal(r.stderr.trim(),'LEADERBOARD_BENCHMARK_FAILED');assert.doesNotMatch(r.stdout+r.stderr,/private-secret|postgresql:|db.example.com/);}
});
