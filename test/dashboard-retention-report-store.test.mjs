import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,writeFile,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const mod=new URL('../dashboard/retention-report.mjs',import.meta.url);
const APP='wx0123456789abcdef';
export function fixture(date='2026-10-31') {
 const periods=[1,3,5,7,14,20,30];
 const next=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 return {schemaVersion:1,appId:APP,environment:'production',timezone:'Asia/Shanghai',asOfDate:date,
 generatedAt:next+'T00:10:00.000Z',coverageStart:'2026-10-01',trackingStartedAt:'2026-10-01T00:00:00.000Z',historyDays:1,periods,
 cohorts:[{date,newUsers:3,cells:periods.map(day=>({day,observationDate:new Date(Date.parse(date+'T00:00:00Z')+day*86400000).toISOString().slice(0,10),status:'pending',returned:null,cohortSize:3,rate:null}))}],
 summary:periods.map(day=>({day,cohortSize:0,returned:0,rate:null,cohortDays:0}))};
}
test('snapshot validation rejects corrupt, secret-bearing, inconsistent, and foreign-app reports',async t=>{
 const {validateRetentionReport,publishRetentionReport,loadRetentionReport}=await import(mod);
 assert.deepEqual(validateRetentionReport(fixture(),APP),fixture());
 const mutations=[r=>r.summary[0].returned=1,r=>r.cohorts[0].cells[0].cohortSize=4,
 r=>r.cohorts[0].cells[0].observationDate='2026-11-09',r=>r.cohorts[0].cells[0].status='complete',
 r=>r.cohorts[0].newUsers=-1,r=>r.cohorts[0].cells[0].rate=0,r=>r.asOfDate='2026-02-30',
 r=>r.generatedAt='2026-10-31T00:10:00.000Z',r=>r.historyDays=120,r=>r.secret='never stored',
 r=>r.cohorts[0].openid='never stored',r=>r.trackingStartedAt='garbage',r=>r.periods.reverse()];
 for(const mutate of mutations){const bad=fixture();mutate(bad);assert.throws(()=>validateRetentionReport(bad,APP),{code:'RETENTION_REPORT_UNAVAILABLE'});}
 const dir=await sandbox(t);await assert.rejects(loadRetentionReport(dir,APP),{code:'RETENTION_REPORT_UNAVAILABLE'});
 await publishRetentionReport(dir,fixture());
 await assert.rejects(loadRetentionReport(dir,undefined),{code:'RETENTION_REPORT_UNAVAILABLE'});
 await assert.rejects(loadRetentionReport(dir,'wxfffffffffffffffff'),{code:'RETENTION_REPORT_UNAVAILABLE'});
 for(const mutate of mutations){const bad=fixture();mutate(bad);await assert.rejects(publishRetentionReport(dir,bad));assert.deepEqual(await loadRetentionReport(dir,APP),fixture());}
 await writeFile(join(dir,'latest.json'),'{}',{mode:0o600});
 await assert.rejects(loadRetentionReport(dir,APP),{code:'RETENTION_REPORT_UNAVAILABLE'});
});

test('same-day publication fails closed when immutable history is missing or inconsistent',async t=>{
 const {publishRetentionReport,validateRetentionReport}=await import(mod);
 const cases=[
  ['missing',async path=>rm(path)],
  ['invalid JSON',async path=>writeFile(path,'{')],
  ['invalid schema',async path=>writeFile(path,JSON.stringify({...fixture(),schemaVersion:2}))],
  ['foreign app',async path=>{const report={...fixture(),appId:'wxfedcba9876543210'};validateRetentionReport(report);await writeFile(path,JSON.stringify(report));}],
  ['wrong date',async path=>{const report=fixture('2026-10-30');validateRetentionReport(report);await writeFile(path,JSON.stringify(report));}],
  ['different generatedAt',async path=>{const report={...fixture(),generatedAt:'2026-11-01T01:00:00.000Z'};validateRetentionReport(report);await writeFile(path,JSON.stringify(report));}],
  ['different nested content',async path=>{const report=fixture();report.cohorts[0].newUsers=7;for(const cell of report.cohorts[0].cells)cell.cohortSize=7;validateRetentionReport(report);await writeFile(path,JSON.stringify(report));}]
 ];
 for(const [name,corrupt] of cases)await t.test(name,async t=>{
  const dir=await sandbox(t);const report=fixture();await publishRetentionReport(dir,report);
  const paths=[join(dir,'latest.json'),join(dir,'history',report.asOfDate+'.json')];await corrupt(paths[1]);
  const snapshot=async path=>{try{return {bytes:await readFile(path),inode:(await stat(path)).ino};}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const before=await Promise.all(paths.map(snapshot));
  const fresh={...report,generatedAt:'2026-11-01T02:00:00.000Z'};
  try {await assert.rejects(publishRetentionReport(dir,fresh));}
  finally {assert.deepEqual(await Promise.all(paths.map(snapshot)),before,'failed publication must not rewrite or recreate either snapshot');}
 });
});

test('dates never roll back and orphan immutable history is reused after an interrupted publish',async t=>{
 const {publishRetentionReport,loadRetentionReport}=await import(mod);const dir=await sandbox(t);
 await publishRetentionReport(dir,fixture());
 await assert.rejects(publishRetentionReport(dir,fixture('2026-10-30')));
 assert.equal((await loadRetentionReport(dir,APP)).asOfDate,'2026-10-31');
 const orphan=fixture('2026-11-01');await writeFile(join(dir,'history','2026-11-01.json'),JSON.stringify(orphan),{mode:0o600});
 const changed=fixture('2026-11-01');changed.generatedAt='2026-11-02T01:00:00.000Z';
 await publishRetentionReport(dir,changed);assert.deepEqual(await loadRetentionReport(dir,APP),orphan);
});

test('store rejects symlink components and concurrent publication stays consistent',async t=>{
 const {publishRetentionReport,loadRetentionReport}=await import(mod);const dir=await sandbox(t);
 await mkdir(dir,{mode:0o700});const external=await sandbox(t);await mkdir(external,{mode:0o700});
 await symlink(external,join(dir,'history'));
 await assert.rejects(publishRetentionReport(dir,fixture()));await rm(join(dir,'history'));
 await symlink(external,join(dir,'alias'));
 await assert.rejects(publishRetentionReport(join(dir,'alias','child'),fixture()));
 await assert.rejects(publishRetentionReport(dir+'/../traversal',fixture()));
 await publishRetentionReport(dir,fixture());
 await rm(join(dir,'latest.json'));await symlink(join(dir,'history','2026-10-31.json'),join(dir,'latest.json'));
 await assert.rejects(loadRetentionReport(dir,APP),{code:'RETENTION_REPORT_UNAVAILABLE'});
 await rm(join(dir,'latest.json'));await publishRetentionReport(dir,fixture());
 const results=await Promise.allSettled(Array.from({length:8},()=>publishRetentionReport(dir,fixture('2026-11-01'))));
 assert(results.some(r=>r.status==='rejected'),'overlapping publishers fail closed under nonblocking lock');
 assert.equal((await loadRetentionReport(dir,APP)).asOfDate,'2026-11-01');
 assert.deepEqual(JSON.parse(await readFile(join(dir,'history','2026-11-01.json'),'utf8')),await loadRetentionReport(dir,APP));
});

test('valid ISO timestamps may have explicit offsets or omit fractional seconds',async()=>{
 const {validateRetentionReport}=await import(mod);const report=fixture();
 report.generatedAt='2026-11-01T00:10:00+08:00';report.trackingStartedAt='2026-10-01T00:00:00Z';
 assert.equal(validateRetentionReport(report,APP),report);
});

test('history filename must agree with snapshot date before promotion',async t=>{
 const {publishRetentionReport,loadRetentionReport}=await import(mod);const dir=await sandbox(t);
 await publishRetentionReport(dir,fixture());
 await writeFile(join(dir,'history','2026-11-01.json'),JSON.stringify(fixture()),{mode:0o600});
 await assert.rejects(publishRetentionReport(dir,fixture('2026-11-01')));
 assert.equal((await loadRetentionReport(dir,APP)).asOfDate,'2026-10-31');
});

test('directory fsync failure after latest rename restores previous latest',async t=>{
 const {publishRetentionReport,loadRetentionReport}=await import(mod);const dir=await sandbox(t);await publishRetentionReport(dir,fixture());
 const {open}=await import('node:fs/promises');const probe=await open(join(dir,'latest.json'),'r');const prototype=Object.getPrototypeOf(probe);const original=prototype.sync;await probe.close();
 let count=0;prototype.sync=async function(){if(++count===4)throw new Error('injected fsync failure');return original.call(this);};
 try {await assert.rejects(publishRetentionReport(dir,fixture('2026-11-01')));}finally{prototype.sync=original;}
 assert.deepEqual(await loadRetentionReport(dir,APP),fixture());
 await publishRetentionReport(dir,fixture('2026-11-01'));assert.equal((await loadRetentionReport(dir,APP)).asOfDate,'2026-11-01');
});

async function sandbox(t){const dir=await mkdtemp(join(tmpdir(),'retention-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'report');}

test('publishes private atomic history and loads exact aggregate snapshot',async t=>{
 const {publishRetentionReport,loadRetentionReport}=await import(mod);const dir=await sandbox(t);const report=fixture();
 await publishRetentionReport(dir,report);
 assert.deepEqual(await loadRetentionReport(dir,APP),report);
 assert.deepEqual(JSON.parse(await readFile(join(dir,'history',report.asOfDate+'.json'),'utf8')),report);
 assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(join(dir,'history'))).mode&0o777,0o700);
 assert.equal((await stat(join(dir,'latest.json'))).mode&0o777,0o600);
 assert.equal((await stat(join(dir,'history',report.asOfDate+'.json'))).mode&0o777,0o600);
 const paths=[join(dir,'latest.json'),join(dir,'history',report.asOfDate+'.json')];
 const before=await Promise.all(paths.map(async path=>({bytes:await readFile(path),inode:(await stat(path)).ino})));
 const changed=structuredClone(report);changed.generatedAt='2026-11-01T02:00:00.000Z';changed.cohorts[0].newUsers=7;for(const cell of changed.cohorts[0].cells)cell.cohortSize=7;
 assert.deepEqual(await publishRetentionReport(dir,changed),report,'compare history to stored latest, not the fresh report');
 assert.deepEqual(await loadRetentionReport(dir,APP),report,'same date is immutable');
 assert.deepEqual(await Promise.all(paths.map(async path=>({bytes:await readFile(path),inode:(await stat(path)).ino}))),before,'same-day leaves both snapshots bytes and inodes unchanged');
});
