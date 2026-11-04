import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('collector rejects invalid bounds and injected clocks before queries',async()=>{
  const {collectRetentionReport}=await import(moduleUrl);
  for(const options of [{historyDays:0},{historyDays:367},{historyDays:1.5},{now:new Date()}]) {
    const pool=poolFor();await assert.rejects(collectRetentionReport(pool,APP,options),/Invalid retention/);assert.equal(pool.calls.length,0);
  }
  const pool=poolFor({days:1});assert.equal((await collectRetentionReport(pool,APP,{historyDays:1})).cohorts.length,1);
  await assert.rejects(collectRetentionReport(pool,'other-app'),/Invalid retention/);
});
test('collector destroys clients when rollback fails',async()=>{
  const {collectRetentionReport}=await import(moduleUrl);
  const pool=poolFor({fail:true,rollbackFail:true});await assert.rejects(collectRetentionReport(pool,APP));
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');assert.equal(pool.released,true);
  const healthy=poolFor({fail:true});await assert.rejects(collectRetentionReport(healthy,APP));assert.equal(healthy.released,false);
});

test('collector verifies read-only mode before aggregating',async()=>{
 const {collectRetentionReport}=await import(moduleUrl);const pool=poolFor();
 const client=await pool.connect();const original=client.query;
 client.query=async function(sql,values){if(sql==='SHOW transaction_read_only')return {rows:[{transaction_read_only:'off'}]};return original.call(this,sql,values);};
 await assert.rejects(collectRetentionReport(pool,APP),/read-only/);
 assert.equal(pool.calls.some(x=>/WITH moment/.test(x.sql)),false);
});

test('CLI enforces exact reader target, bounded readonly pool, and absolute output paths',async()=>{
 const cli=await import('../scripts/build-retention-report.mjs');
 const env={DATABASE_URL:'postgresql://minigame_dashboard_app:offline-password@127.0.0.1:15440/minigame',DASHBOARD_APP_ID:APP,DASHBOARD_ENVIRONMENT:'production'};
 const config=cli.loadRetentionReportConfig(env,[]);
 assert.equal(config.outputDir,'/home/ubuntu/.hermes/workspace/projects/minigame_server/runtime/analytics/retention');
 assert.equal(cli.loadRetentionReportConfig(env,['--output-dir','/tmp/retention-offline']).outputDir,'/tmp/retention-offline');
 for(const args of [['--now','2026-01-01'],['--output-dir','relative'],['--output-dir','/tmp/../etc'],['--output-dir','/tmp/ok/'],['--output-dir']])assert.throws(()=>cli.loadRetentionReportConfig(env,args),/Invalid retention/);
 for(const url of ['postgresql://minigame_dashboard_app:secret@127.0.0.1:15441/minigame','postgresql://minigame_app:secret@127.0.0.1:15440/minigame','postgresql://minigame_dashboard_app:secret@db:15440/minigame',env.DATABASE_URL+'?options=x'])assert.throws(()=>cli.loadRetentionReportConfig({...env,DATABASE_URL:url},[]),/Invalid retention/);
 const pool=cli.createRetentionPool(config);assert.equal(pool.options.max,1);assert.equal(pool.options.connectionTimeoutMillis,3000);assert.equal(pool.options.statement_timeout,60000);assert.match(pool.options.options,/default_transaction_read_only=on/);assert.match(pool.options.options,/jit=off/);await pool.end();
});

test('systemd schedules Beijing 00:10 persistently with fixed shared writable directory',async()=>{
 const service=await readFile(new URL('../ops/minigame-retention-report.service',import.meta.url),'utf8');
 const timer=await readFile(new URL('../ops/minigame-retention-report.timer',import.meta.url),'utf8');
 assert.match(timer,/OnCalendar=\*-\*-\* 00:10:00 Asia\/Shanghai/);assert.match(timer,/Persistent=true/);
 assert.match(service,/Type=oneshot/);assert.match(service,/User=ubuntu/);assert.match(service,/runtime\/dashboard\/current\/scripts\/build-retention-report.mjs/);
 assert.match(service,/EnvironmentFile=.*\.env.dashboard/);assert.match(service,/ProtectSystem=strict/);assert.match(service,/ReadWritePaths=.*runtime\/analytics\/retention/);assert.match(service,/UMask=0077/);
});

const moduleUrl = new URL('../dashboard/retention-report.mjs', import.meta.url);
const APP = 'wx0123456789abcdef';
const periods = [1,3,5,7,14,20,30];
function poolFor({ days=120, fail=false, rollbackFail=false }={}) {
  const calls=[]; let released;
  const client={ async query(sql, values) {
    calls.push({sql,values});
    if(sql==='SHOW transaction_read_only')return {rows:[{transaction_read_only:'on'}]};
    if (/WITH moment/.test(sql)) {
      if(fail) throw new Error('private connection details');
      const rows=[];
      for(let n=0;n<days;n++) for(const day of periods) {
        const date=new Date(Date.UTC(2026,9,31-n)).toISOString().slice(0,10);
        rows.push({cohort_date:date,day,cohort_size:n===1?10:n===2?100:0,
          returned:n===1?5:n===2?10:0, as_of_date:'2026-10-31',
          generated_at:new Date('2026-10-31T16:10:00Z'),coverage_start:'2026-10-30',
          tracking_started_at:new Date('2026-10-30T00:00:00Z')});
      }
      return {rows};
    }
    if(sql==='ROLLBACK'&&rollbackFail)throw new Error('rollback failed');
    return {rows:[]};
  }, release(error){released=error??false;} };
  return { async connect(){return client;},calls,get released(){return released;} };
}

test('collector produces yesterday-only complete history and weighted covered retention',async()=>{
  const {collectRetentionReport}=await import(moduleUrl);
  const pool=poolFor(); const report=await collectRetentionReport(pool,APP);
  assert.equal(report.schemaVersion,1);assert.equal(report.appId,APP);
  assert.equal(report.environment,'production');assert.equal(report.timezone,'Asia/Shanghai');
  assert.equal(report.asOfDate,'2026-10-31');assert.equal(report.generatedAt,'2026-10-31T16:10:00.000Z');
  assert.equal(report.cohorts.length,120);assert.equal(report.cohorts[0].date,'2026-10-31');
  assert.equal(report.cohorts.at(-1).date,'2026-07-04');
  assert.equal(report.cohorts[0].cells[0].status,'pending');
  assert.equal(report.cohorts[1].cells[0].status,'complete');
  assert.equal(report.cohorts[2].cells[0].status,'complete','registration before coverage is eligible');
  assert.equal(report.cohorts[3].cells[0].status,'uncovered');
  assert.equal(report.cohorts[3].cells[1].status,'empty');
  assert.equal(report.cohorts[3].cells[1].rate,null);
  assert.deepEqual(report.summary[0],{day:1,cohortSize:110,returned:15,rate:15/110,cohortDays:2});
  assert.match(pool.calls[0].sql,/BEGIN.*REPEATABLE READ.*READ ONLY/);
  assert.equal(pool.calls.at(-1).sql,'COMMIT');assert.equal(pool.released,false);
  const query=pool.calls.find(x=>/WITH moment/.test(x.sql));
  assert.deepEqual(query.values,[APP,120]);
  assert.match(query.sql,/transaction_timestamp\(\)/);assert.match(query.sql,/first_login_completed/);
  assert.match(query.sql,/l\.app_id\s*=\s*r\.app_id/);assert.doesNotMatch(query.sql,/last_login_at|game_login_events|game_dashboard_save_repairs/);
});
