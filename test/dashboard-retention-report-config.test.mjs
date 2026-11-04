import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as dashboard from '../dashboard/server.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {loadDashboardConfig}=dashboard;
const env={HOST:'127.0.0.1',PORT:'18742',DATABASE_URL:'postgresql://minigame_dashboard_app:local-test@127.0.0.1:15440/minigame',REDIS_URL:'redis://:local-test@127.0.0.1:16390/1',DASHBOARD_USER:'admin',DASHBOARD_PASSWORD_HASH:'0123456789abcdef0123456789abcdef:'+'00'.repeat(64),DASHBOARD_APP_ID:'wx1111111111111111',DASHBOARD_ORIGIN:'https://dashboard.example.com',DASHBOARD_BASE_PATH:'/h5dashboard/',DASHBOARD_ENVIRONMENT:'production'};
test('report storage is shared across releases and cannot default into snapshot working directory',()=>{
 assert.equal(loadDashboardConfig(env).retentionReportDir,'/home/ubuntu/.hermes/workspace/projects/minigame_server/runtime/analytics/retention');
 assert.equal(loadDashboardConfig({...env,DASHBOARD_RETENTION_REPORT_DIR:'/tmp/isolated-retention'}).retentionReportDir,'/tmp/isolated-retention');
});
test('invalid report paths fail closed without changing credentials or requiring a writer',()=>{
 for(const value of ['', 'relative/reports','../reports','/tmp/../etc','/tmp/reports\0secret','/tmp//reports','/tmp/reports/'])assert.throws(()=>loadDashboardConfig({...env,DASHBOARD_RETENTION_REPORT_DIR:value}),/Invalid dashboard configuration/);
 const result=loadDashboardConfig(env);assert.equal(result.databaseUrl,env.DATABASE_URL);assert.equal(result.saveRepairEnabled,false);
});
test('server report loader reads the configured shared storage and rejects another app',async()=>{
 assert.equal(typeof dashboard.createStoredRetentionLoader,'function');
 const {publishRetentionReport}=await import('../dashboard/retention-report.mjs');const directory=await mkdtemp(join(tmpdir(),'retention-server-'));
 try{const periods=[1,3,5,7,14,20,30],date='2026-11-01';const cells=periods.map(day=>({day,observationDate:new Date(Date.UTC(2026,10,1+day)).toISOString().slice(0,10),status:'pending',returned:null,cohortSize:1,rate:null}));
 const report={schemaVersion:1,appId:env.DASHBOARD_APP_ID,environment:'production',timezone:'Asia/Shanghai',asOfDate:date,generatedAt:'2026-11-01T16:10:00.000Z',coverageStart:'2026-10-17',trackingStartedAt:'2026-10-17T15:58:42.000Z',historyDays:1,periods,cohorts:[{date,newUsers:1,cells}],summary:periods.map(day=>({day,cohortSize:0,returned:0,rate:null,cohortDays:0}))};
 await publishRetentionReport(directory,report);const config=loadDashboardConfig({...env,DASHBOARD_RETENTION_REPORT_DIR:directory});assert.deepEqual(await dashboard.createStoredRetentionLoader(config)(),report);
 await assert.rejects(()=>dashboard.createStoredRetentionLoader({...config,appId:'wx9999999999999999'})(),error=>error.code==='RETENTION_REPORT_UNAVAILABLE');
 }finally{await rm(directory,{recursive:true,force:true});}
});
