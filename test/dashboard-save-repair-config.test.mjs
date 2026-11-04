import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadDashboardConfig} from '../dashboard/server.mjs';
const env={HOST:'127.0.0.1',PORT:'18742',DATABASE_URL:'postgresql://minigame_dashboard_app:explicit-test@127.0.0.1:15440/minigame',REDIS_URL:'redis://:explicit-test@127.0.0.1:16390/1',DASHBOARD_USER:'admin',DASHBOARD_PASSWORD_HASH:'0123456789abcdef0123456789abcdef:'+ '00'.repeat(64),DASHBOARD_APP_ID:'wx1111111111111111',DASHBOARD_ORIGIN:'https://dashboard.example.com',DASHBOARD_BASE_PATH:'/h5dashboard/',DASHBOARD_ENVIRONMENT:'production'};
const writeUrl='postgresql://minigame_save_repair_app:explicit-test@127.0.0.1:15440/minigame';
test('save repair is disabled by default and optional writer is dedicated and fixed-target',()=>{
 assert.equal(loadDashboardConfig(env).saveRepairEnabled,false);
 assert.equal(loadDashboardConfig({...env,DASHBOARD_SAVE_REPAIR_ENABLED:'false'}).saveRepairDatabaseUrl,null);
 const c=loadDashboardConfig({...env,DASHBOARD_SAVE_REPAIR_ENABLED:'true',DASHBOARD_SAVE_REPAIR_DATABASE_URL:writeUrl});assert.equal(c.saveRepairEnabled,true);assert.equal(c.saveRepairDatabaseUrl,writeUrl);
 for(const value of ['1','yes','TRUE',''])assert.throws(()=>loadDashboardConfig({...env,DASHBOARD_SAVE_REPAIR_ENABLED:value}),/Invalid dashboard configuration/);
 assert.throws(()=>loadDashboardConfig({...env,DASHBOARD_SAVE_REPAIR_ENABLED:'true'}),/Invalid dashboard configuration/);
 for(const url of [writeUrl.replace('minigame_save_repair_app','minigame_owner'),writeUrl.replace('15440','15441'),writeUrl.replace('127.0.0.1','example.com'),writeUrl.replace('/minigame','/minigame_staging'),writeUrl+'?options=-c%20role%3Dminigame_owner'])assert.throws(()=>loadDashboardConfig({...env,DASHBOARD_SAVE_REPAIR_ENABLED:'true',DASHBOARD_SAVE_REPAIR_DATABASE_URL:url}),/Invalid dashboard configuration/);
});
