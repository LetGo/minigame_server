import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {readFile as realReadFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import request from 'supertest';
import {createDashboardServer} from '../dashboard/backend.js';
import {createProductionStatus,parseSystemdTime,SYSTEMD_ENV} from '../dashboard/production-status.mjs';

const APP='wx1234123412341234';
const START=1792485967; // 2026-10-20T08:46:07Z
const PROBE_TEXT=JSON.stringify({message:['code must match /^\\S+$/ regular expression','code must be longer than or equal to 1 characters','code must be a string'],error:'Bad Request',statusCode:400});

async function rootDir(env=''){
  const root=await mkdtemp(join(tmpdir(),'production-status-'));
  await mkdir(join(root,'dist/leaderboards'),{recursive:true});
  await writeFile(join(root,'.env'),[
    'SUBSCRIBE_MESSAGES_ENABLED=true',
    'PRODUCTION_DAILY_CHECKIN_ENABLED=true',
    'SUBSCRIBE_MINIPROGRAM_STATE=formal',
    'DATABASE_URL=postgresql://private-user:private-pass@127.0.0.1:15440/minigame',
    env,
  ].join('\n'));
  await writeFile(join(root,'dist/leaderboards/leaderboards.service.js'),'const MINIMUM = { stage: 101, boss: 30 };\n');
  return root;
}

function okSystemctl(seen){
  return async args=>{
    seen?.push(args);
    const key=args[1];
    if(key==='minigame-login.service')return {exitCode:0,stdout:'ActiveState=active\nSubState=running\n'};
    if(key==='minigame-production-checkin.timer'){
      return {exitCode:0,stdout:'ActiveState=active\nSubState=waiting\nUnitFileState=enabled\nNextElapseUSecRealtime=Wed 2026-10-21 01:00:00 UTC\nLastTriggerUSec=Tue 2026-10-20 09:26:07 UTC\n'};
    }
    if(key==='minigame-production-checkin.service')return {exitCode:0,stdout:`ActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nExecMainStartTimestamp=@${START}\nExecMainExitTimestamp=@${START+3}\n`};
    return {exitCode:1,stdout:''};
  };
}

function okFetch(seen){
  return async(url,init)=>{
    seen?.push({url,init});
    return {status:400,headers:{get:()=> 'application/json; charset=utf-8'},text:async()=>PROBE_TEXT};
  };
}

const receiptRow={today:{total:4,sent:2,failed:1,unknown:0,sending:1},
  last:{state:'sent',startedAt:'2026-10-20T09:00:00+08:00',finishedAt:'2026-10-20T09:00:01+08:00',scheduledDate:'2026-10-20',upstreamCode:0}};

function okPool(seen){
  return {async query(sql,params){
    seen?.push({sql,params});
    if(/^\s*SELECT 1/i.test(sql))return {rows:[{ok:1}]};
    return {rows:[{result:receiptRow}]};
  }};
}

function okRedis(){return {withCommandOptions(){return this;},async ping(){return 'PONG';}};}

async function collector(overrides={}){
  const root=overrides.root??await rootDir();
  const deps={root,files:{readFile:realReadFile},systemctl:okSystemctl(),fetch:okFetch(),pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z'),...overrides};
  return {root,status:createProductionStatus(deps)};
}

test('returns the exact production status contract from fixed local-only sources',async()=>{
  const systemctlSeen=[],fetchSeen=[],poolSeen=[],fileSeen=[];
  const root=await rootDir();
  const status=createProductionStatus({
    root,
    files:{readFile:async(path,encoding)=>{fileSeen.push(path);return realReadFile(path,encoding);}},
    systemctl:okSystemctl(systemctlSeen),fetch:okFetch(fetchSeen),pool:okPool(poolSeen),redis:okRedis(),appId:APP,
    now:()=>Date.parse('2026-10-20T09:26:07Z'),
  });
  const value=await status();
  assert.deepEqual(value,{
    environment:'production',
    checkedAt:'2026-10-20T09:26:07.000Z',
    refreshSeconds:30,
    api:{state:'ok',serviceActive:true,probeOk:true},
    database:{state:'ok'},
    redis:{state:'ok'},
    subscriptions:{enabled:true,jumpState:'formal',
      schedule:{enabled:true,active:true,nextRunAt:'2026-10-21T01:00:00.000Z',lastTriggerAt:'2026-10-20T09:26:07.000Z',workerResult:'success',exitCode:0},
      receipts:{available:true,today:{total:4,sent:2,failed:1,unknown:0,sending:1},
        last:{state:'sent',startedAt:'2026-10-20T01:00:00.000Z',finishedAt:'2026-10-20T01:00:01.000Z',scheduledDate:'2026-10-20',upstreamCode:0}}},
    leaderboards:{stageMinimum:101,bossMinimum:30},
  });
  assert.deepEqual(fileSeen.sort(),[join(root,'.env'),join(root,'dist/leaderboards/leaderboards.service.js')].sort());
  assert.equal(systemctlSeen.length,3);
  for(const args of systemctlSeen){
    assert.equal(args[0],'show');
    assert(['minigame-login.service','minigame-production-checkin.timer','minigame-production-checkin.service'].includes(args[1]));
  }
  assert.equal(fetchSeen.length,1);
  assert.equal(fetchSeen[0].url,'http://127.0.0.1:18740/h5login/api/auth/wechat-login');
  assert.equal(fetchSeen[0].init.method,'POST');
  assert.equal(fetchSeen[0].init.body,'{}');
  assert.deepEqual(poolSeen.map(q=>q.params).filter(Boolean),[[APP,'2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4']]);
  const text=JSON.stringify(value);
  for(const secret of ['private-pass','private-user','DATABASE_URL','code must be','/home/ubuntu','ActiveState='])assert(!text.includes(secret),`must not leak ${secret}`);
});

test('systemd timestamps are read as explicit UTC at Beijing 09:00 and never guessed from CST',async()=>{
  assert.deepEqual(SYSTEMD_ENV,{TZ:'UTC',LC_ALL:'C'});
  assert.equal(parseSystemdTime('Wed 2026-10-21 01:00:00 UTC'),'2026-10-21T01:00:00.000Z');
  const beijingHour=new Date(Date.parse('2026-10-21T01:00:00.000Z')+8*3600000).getUTCHours();
  assert.equal(beijingHour,9,'09:00 Asia/Shanghai is 01:00 UTC');
  assert.equal(parseSystemdTime('Wed 2026-10-21 09:00:00 CST'),null,'ambiguous CST must not be reinterpreted');
  assert.equal(parseSystemdTime('Wed 2026-10-21 01:00:00'),null);
  assert.equal(parseSystemdTime('Wed 2026-02-31 01:00:00 UTC'),null);
  assert.equal(parseSystemdTime('@1792485967'),'2026-10-20T08:46:07.000Z');
  const root=await rootDir();
  const timer=(next,last)=>createProductionStatus({root,systemctl:async args=>{
    if(args[1]==='minigame-production-checkin.timer')return {exitCode:0,stdout:`ActiveState=active\nSubState=waiting\nUnitFileState=enabled\nNextElapseUSecRealtime=${next}\nLastTriggerUSec=${last}\n`};
    if(args[1]==='minigame-login.service')return {exitCode:0,stdout:'ActiveState=active\n'};
    return {exitCode:0,stdout:'ActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nExecMainStartTimestamp=\nExecMainExitTimestamp=\n'};
  },fetch:okFetch(),pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const unknown=(await timer('Wed 2026-10-21 09:00:00 CST','Tue 2026-10-20 09:26:07 CST')()).subscriptions.schedule;
  assert.deepEqual(unknown,{enabled:null,active:null,nextRunAt:null,lastTriggerAt:null,workerResult:null,exitCode:null},
    'an ambiguous timestamp is unreadable schedule state, not a never-triggered timer');
  const garbage=(await timer('not-a-timestamp','')()).subscriptions.schedule;
  assert.equal(garbage.enabled,null,'a malformed timestamp must not leave schedule booleans looking healthy');
  assert.equal(garbage.nextRunAt,null);
  const never=(await timer('','')()).subscriptions.schedule;
  assert.deepEqual(never,{enabled:true,active:true,nextRunAt:null,lastTriggerAt:null,workerResult:null,exitCode:null},
    'an empty timestamp is a genuinely never-triggered or never-started unit');
});

test('the login probe requires the real missing-code validation rejection and never exposes its text',async()=>{
  const root=await rootDir();
  const build=response=>createProductionStatus({root,systemctl:okSystemctl(),fetch:async()=>response,pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const json=body=>text=>JSON.stringify(body);
  const cases=[
    [{status:400,headers:{get:()=> 'application/json'},text:json({message:['code must be a string'],statusCode:400})},true],
    [{status:400,headers:{get:()=> 'application/json'},text:json({message:['Invalid request'],statusCode:400})},false],
    [{status:400,headers:{get:()=> 'text/html'},text:async()=>'<html>blocked</html>'},false],
    [{status:200,headers:{get:()=> 'application/json'},text:json({token:'x'})},false],
    [{status:400,headers:{get:()=> 'application/json'},text:json({message:['code must be a string'],statusCode:422})},false],
  ];
  for(const [response,expected] of cases){
    const value=await build(response)();
    assert.equal(value.api.probeOk,expected,`status ${response.status} body ${await response.text.call(null)}`);
    assert.equal(value.api.state,expected?'ok':'error');
    const body=JSON.stringify(value);
    assert(!body.includes('code must be')&&!body.includes('blocked')&&!body.includes('Invalid request'));
  }
  const unreachable=await createProductionStatus({root,systemctl:okSystemctl(),fetch:async()=>{throw new Error('connect ECONNREFUSED 127.0.0.1:18740');},pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')})();
  assert.equal(unreachable.api.probeOk,null);
  assert.equal(unreachable.api.state,'unknown');
  assert.equal(unreachable.api.serviceActive,true);
  assert(!JSON.stringify(unreachable).includes('ECONNREFUSED'));
});

test('subscription flags require both exact true values and never invent a delivered state',async()=>{
  const cases=[
    [['true','true'],true,'formal'],
    [['true','false'],false,'formal'],
    [['false','true'],false,'trial'],
    [['false','false'],false,'trial'],
    [['true',null],null,'formal'],
    [[null,'true'],null,'formal'],
    [[null,null],null,'unknown'],
    [['yes','true'],null,'formal'],
    [['true','1'],null,'formal'],
    [['true','true'],true,'weird'],
  ];
  for(const [[send,checkin],enabled,jump] of cases){
    const lines=['SUBSCRIBE_MESSAGES_ENABLED='+(send??''),'PRODUCTION_DAILY_CHECKIN_ENABLED='+(checkin??''),'SUBSCRIBE_MINIPROGRAM_STATE='+jump].filter(line=>!line.endsWith('='));
    const root=await rootDir();
    await writeFile(join(root,'.env'),lines.join('\n'));
    const value=await createProductionStatus({root,systemctl:okSystemctl(),fetch:okFetch(),pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')})();
    assert.equal(value.subscriptions.enabled,enabled,`send=${send} checkin=${checkin}`);
    assert.equal(value.subscriptions.jumpState,['formal','trial'].includes(jump)?jump:'unknown');
  }
  const root=await rootDir();
  const status=createProductionStatus({root:join(root,'missing'),files:{readFile:async()=>{throw new Error('ENOENT private path');}},systemctl:okSystemctl(),fetch:okFetch(),pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const value=await status();
  assert.equal(value.subscriptions.enabled,null);
  assert.equal(value.subscriptions.jumpState,'unknown');
  assert.equal(value.leaderboards.stageMinimum,null);
  assert.equal(value.api.state,'ok','unreadable local files must not fake an API outage');
  assert(!JSON.stringify(value).includes('ENOENT'));
});

test('missing rights, failed units and broken probes stay isolated unknown instead of fake healthy or zero',async()=>{
  const root=await rootDir();
  const throwingSystemctl=async()=>{throw new Error('Failed to connect to bus: private socket');};
  const value=await createProductionStatus({root,systemctl:throwingSystemctl,fetch:okFetch(),pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')})();
  assert.deepEqual(value.api,{state:'unknown',serviceActive:null,probeOk:true});
  assert.deepEqual(value.subscriptions.schedule,{enabled:null,active:null,nextRunAt:null,lastTriggerAt:null,workerResult:null,exitCode:null});
  assert.equal(value.database.state,'ok','systemctl failures must not affect database health');
  assert.equal(value.redis.state,'ok');
  assert(!JSON.stringify(value).includes('bus'));

  const failingUnits=createProductionStatus({root,systemctl:async args=>args[1]==='minigame-login.service'?{exitCode:3,stdout:'private unit output'}:{exitCode:1,stdout:'private unit output'},
    fetch:okFetch(),pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const failed=await failingUnits();
  assert.deepEqual(failed.api,{state:'unknown',serviceActive:null,probeOk:true});
  assert.equal(failed.subscriptions.schedule.enabled,null);
  assert.equal(failed.subscriptions.schedule.nextRunAt,null);
  assert(!JSON.stringify(failed).includes('private unit output'));

  const inactiveTimer=createProductionStatus({root,systemctl:async args=>{
    if(args[1]==='minigame-login.service')return {exitCode:0,stdout:'ActiveState=inactive\nSubState=dead\n'};
    if(args[1]==='minigame-production-checkin.timer')return {exitCode:0,stdout:'ActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n'};
    return {exitCode:0,stdout:'ActiveState=inactive\nSubState=dead\nResult=failed\nExecMainStatus=1\nExecMainStartTimestamp=@1792485967\nExecMainExitTimestamp=@1792485968\n'};
  },fetch:async()=>({status:400,headers:{get:()=> 'application/json'},text:async()=>PROBE_TEXT}),pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const down=await inactiveTimer();
  assert.deepEqual(down.api,{state:'error',serviceActive:false,probeOk:true});
  assert.equal(down.subscriptions.schedule.enabled,false);
  assert.equal(down.subscriptions.schedule.active,false);
  assert.equal(down.subscriptions.schedule.workerResult,'failed');
  assert.equal(down.subscriptions.schedule.exitCode,1);
  assert.equal(down.subscriptions.schedule.lastTriggerAt,null,'only the timer LastTriggerUSec may report the last scheduled trigger');

  const badDatabase=createProductionStatus({root,systemctl:okSystemctl(),fetch:okFetch(),pool:{async query(sql){if(/^\s*SELECT 1/i.test(sql))return {rows:[{ok:0}]};return {rows:[{result:receiptRow}]};}},redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  assert.equal((await badDatabase()).database.state,'error','a completed negative probe is an error, not unknown');

  const deniedDatabase=createProductionStatus({root,systemctl:okSystemctl(),fetch:okFetch(),pool:{async query(){throw new Error('permission denied for table game_subscription_sends (secret-host)');}},redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const denied=await deniedDatabase();
  assert.equal(denied.database.state,'unknown');
  assert.equal(denied.subscriptions.receipts.available,false);
  assert.equal(denied.subscriptions.receipts.today,null,'missing SELECT rights must never be reported as zero receipts');
  assert.equal(denied.subscriptions.receipts.last,null);
  assert(!JSON.stringify(denied).includes('secret-host')&&!JSON.stringify(denied).includes('permission denied'));

  const redisDown=createProductionStatus({root,systemctl:okSystemctl(),fetch:okFetch(),pool:okPool(),redis:{withCommandOptions(){return this;},async ping(){throw new Error('NOAUTH private redis');}},appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const noRedis=await redisDown();
  assert.equal(noRedis.redis.state,'unknown');
  assert.equal(noRedis.database.state,'ok');
  assert(!JSON.stringify(noRedis).includes('NOAUTH'));

  const redisOdd=createProductionStatus({root,systemctl:okSystemctl(),fetch:okFetch(),pool:okPool(),redis:{withCommandOptions(){return this;},async ping(){return 'LOADING';}},appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  assert.equal((await redisOdd()).redis.state,'error');
});

test('a healthy snapshot is served for ten seconds, shared by concurrent callers, and never kept after a fresh failure',async()=>{
  const root=await rootDir();
  let now=Date.parse('2026-10-20T09:26:07Z'),collections=0,broken=false;
  const systemctl=async args=>{if(args[1]==='minigame-login.service')collections++;return okSystemctl()(args);};
  const status=createProductionStatus({root,systemctl,fetch:okFetch(),pool:okPool(),redis:okRedis(),appId:APP,now:()=>{if(broken)throw new Error('clock unavailable');return now;}});
  const first=await Promise.all(Array.from({length:25},()=>status()));
  assert.equal(collections,1,'concurrent cold callers share exactly one systemctl collection');
  assert(first.every(value=>value.checkedAt===first[0].checkedAt),'one collection timestamp is shared');
  assert.equal(new Set(first.map(value=>JSON.stringify(value))).size,1);
  now+=9999;
  assert.deepEqual(await status(),first[0]);
  assert.equal(collections,1,'cached hits must not re-run systemctl');
  now+=1;
  const refreshed=await status();
  assert.notEqual(refreshed.checkedAt,first[0].checkedAt);
  assert.equal(collections,2);
  now+=10000;broken=true;
  await assert.rejects(()=>status(),/PRODUCTION_STATUS_UNAVAILABLE/);
  broken=false;
  const recovered=await status();
  assert.equal(recovered.checkedAt,new Date(now).toISOString());
  assert.notEqual(recovered.checkedAt,refreshed.checkedAt);
});

const config={username:'admin',passwordHash:'00'.repeat(16)+':'+'00'.repeat(64),appId:APP,origin:'https://dashboard.example.com',basePath:'/h5dashboard/',environment:'production'};
async function dashboard(t,productionStatus){
  const token=randomBytes(32).toString('base64url');
  const sessions=new Map([['minigame:dashboard:session:'+createHash('sha256').update(token).digest('hex'),JSON.stringify({username:config.username})]]);
  const redis={withCommandOptions(){return this;},async get(key){return sessions.get(key)??null;},async del(key){sessions.delete(key);return 1;}};
  const queries={overview:async()=>({}),player:async()=>null};
  const server=createDashboardServer({pool:{},redis,config,queries,productionStatus});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  return {api:request(server),cookie:'__Secure-minigame-dashboard='+token,config};
}

test('GET production-status authenticates before loading and fails closed without a loader',async t=>{
  let calls=0;
  const snapshot={environment:'production',checkedAt:'2026-10-20T09:26:07.000Z',refreshSeconds:30,
    api:{state:'ok',serviceActive:true,probeOk:true},database:{state:'ok'},redis:{state:'unknown'},
    subscriptions:{enabled:true,jumpState:'formal',schedule:{enabled:true,active:true,nextRunAt:null,lastTriggerAt:null,workerResult:null,exitCode:null},receipts:{available:false,today:null,last:null}},
    leaderboards:{stageMinimum:101,bossMinimum:30}};
  const f=await dashboard(t,async()=>{calls++;return snapshot;});
  const unauth=await f.api.get('/h5dashboard/api/production-status').expect(401);
  assert.equal(unauth.body.message,'DASHBOARD_LOGIN_REQUIRED');
  assert.equal(calls,0,'authentication must happen before any production probe');
  const ok=await f.api.get('/h5dashboard/api/production-status').set('Cookie',f.cookie).expect(200);
  assert.deepEqual(ok.body,snapshot);
  assert.equal(ok.headers['cache-control'],'no-store');
  assert.equal(calls,1);
  await f.api.get('/h5dashboard/api/production-status?probe=1').set('Cookie',f.cookie).expect(404);
  await f.api.post('/h5dashboard/api/production-status').set('Origin',f.config.origin).set('Cookie',f.cookie).send({}).expect(404);
  assert.equal(calls,1,'only the authenticated GET reaches the collector');
  await f.api.post('/h5dashboard/api/logout').set('Origin',f.config.origin).set('Cookie',f.cookie).send({}).expect(200);
  await f.api.get('/h5dashboard/api/production-status').set('Cookie',f.cookie).expect(401);
  assert.equal(calls,1);
});

test('a missing or failing production collector returns a sanitized 503',async t=>{
  const absent=await dashboard(t,undefined);
  const missing=await absent.api.get('/h5dashboard/api/production-status').set('Cookie',absent.cookie).expect(503);
  assert.deepEqual(missing.body,{message:'PRODUCTION_STATUS_UNAVAILABLE'});

  const failing=await dashboard(t,async()=>{throw new Error('PRODUCTION_STATUS_UNAVAILABLE: permission denied for relation private_table');});
  const failed=await failing.api.get('/h5dashboard/api/production-status').set('Cookie',failing.cookie).expect(503);
  assert.deepEqual(failed.body,{message:'PRODUCTION_STATUS_UNAVAILABLE'});
  assert(!failed.text.includes('private_table'),'upstream error detail must never be exposed');
});

test('a manually started worker never becomes the timer last trigger',async()=>{
  const root=await rootDir();
  const status=createProductionStatus({root,systemctl:async args=>{
    if(args[1]==='minigame-login.service')return {exitCode:0,stdout:'ActiveState=active\n'};
    if(args[1]==='minigame-production-checkin.timer')return {exitCode:0,stdout:'ActiveState=active\nSubState=waiting\nUnitFileState=enabled\nNextElapseUSecRealtime=Wed 2026-10-21 01:00:00 UTC\nLastTriggerUSec=\n'};
    return {exitCode:0,stdout:'ActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nExecMainStartTimestamp=@1792485967\nExecMainExitTimestamp=@1792485968\n'};
  },fetch:okFetch(),pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const {schedule}= (await status()).subscriptions;
  assert.equal(schedule.lastTriggerAt,null,'an out-of-window manual start is not an automatic timer trigger');
  assert.equal(schedule.nextRunAt,'2026-10-21T01:00:00.000Z');
  assert.equal(schedule.workerResult,'success','the process result is a process result, not a message result');
  assert.equal(schedule.exitCode,0);
});

test('probes that ignore abort signals are still bounded and report unknown',{timeout:9000},async()=>{
  const root=await rootDir();
  const hangingText={status:400,headers:{get:()=> 'application/json'},text:()=>new Promise(()=>{})};
  const started=Date.now();
  const fetchHang=await createProductionStatus({root,systemctl:okSystemctl(),fetch:async()=>hangingText,pool:okPool(),redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')})();
  assert.equal(fetchHang.api.probeOk,null);
  assert.equal(fetchHang.api.state,'unknown');
  const pingHang=await createProductionStatus({root,systemctl:okSystemctl(),fetch:okFetch(),pool:okPool(),redis:{withCommandOptions(){return this;},ping:()=>new Promise(()=>{})},appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')})();
  assert.equal(pingHang.redis.state,'unknown');
  assert.equal(pingHang.database.state,'ok');
  assert(Date.now()-started<6000,'both hangs must be bounded by the two-second command budget');
});

test('malformed receipt aggregates are reported unknown, never invented as zeros',async()=>{
  const root=await rootDir();
  const build=today=>createProductionStatus({root,systemctl:okSystemctl(),fetch:okFetch(),
    pool:{async query(sql){if(/^\s*SELECT 1/i.test(sql))return {rows:[{ok:1}]};return {rows:[{result:{today,last:null}}]};}},
    redis:okRedis(),appId:APP,now:()=>Date.parse('2026-10-20T09:26:07Z')});
  const malformed=[
    {total:4,sent:2,failed:1,unknown:0},
    {total:4,sent:2,failed:1,unknown:0,sending:2},
    {total:4,sent:-1,failed:3,unknown:1,sending:1},
    {total:4,sent:'2',failed:1,unknown:0,sending:1},
    {total:4,sent:2,failed:1.5,unknown:0,sending:0},
    null,
  ];
  for(const today of malformed){
    const receipts=(await build(today)()).subscriptions.receipts;
    assert.deepEqual(receipts,{available:false,today:null,last:null},`malformed aggregate ${JSON.stringify(today)} must not fake zeros`);
  }
  const zeros=(await build({total:0,sent:0,failed:0,unknown:0,sending:0})()).subscriptions.receipts;
  assert.deepEqual(zeros,{available:true,today:{total:0,sent:0,failed:0,unknown:0,sending:0},last:null},'real zeros remain available');
});
