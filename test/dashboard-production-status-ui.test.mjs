import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

class Element {
 children=[];className='';id='';value='';colSpan=0;disabled=false;hidden=false;dataset={};events={};
 classList={add(){},remove(){},toggle(){}};
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];this.value='';}
 set textContent(value){this.value=String(value);this.children=[];}
 get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}
 addEventListener(name,fn){this.events[name]=fn;}
 reset(){}
}
const script=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8');
const walk=e=>[e,...e.children.flatMap(walk)];
const byClass=(root,name)=>walk(root).find(e=>String(e.className).split(/\s+/).includes(name));
function load(fetch){
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const app=runInNewContext(script.slice(0,script.indexOf("$('login-form').addEventListener"))+';({renderOverview,renderProductionStatus,renderLoginLogs,switchView,refresh,showLogin,showDashboard,activate(){loggedIn=true;},setTab(value){tab=value;},status(){return lastStatus;},error(){return statusError;}})',{
  document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[],hidden:false},
  fetch:fetch||(async()=>{throw new Error('unexpected fetch');})});
 return {app,view:get('view-container'),elements};
}
const overview={today:'2026-10-20',coverageStart:'2026-10-17',metrics:{dau:4,newUsers:3,invitedNewUsers:2,totalUsers:8,todayRewardedVideos:12,d1:{rate:null,cohortSize:0,returned:0}},history:[]};
const statusData={environment:'production',checkedAt:'2026-10-20T02:00:00.000Z',refreshSeconds:30,
 api:{state:'ok',serviceActive:true,probeOk:true},database:{state:'ok'},redis:{state:'error'},
 subscriptions:{enabled:true,jumpState:'formal',schedule:{enabled:true,active:true,nextRunAt:'2026-10-21T01:00:00.000Z',lastTriggerAt:'2026-10-20T01:00:05.000Z',workerResult:'success',exitCode:0},
  receipts:{available:true,today:{total:12,sent:10,failed:1,unknown:0,sending:1},last:{state:'sent',startedAt:'2026-10-20T01:00:00.000Z',finishedAt:'2026-10-20T01:00:03.000Z',scheduledDate:'2026-10-20',upstreamCode:0}}},
 leaderboards:{stageMinimum:101,bossMinimum:30}};
const item=(panel,label)=>walk(panel).find(e=>String(e.className).split(/\s+/).includes('status-item')&&e.children[0]?.textContent===label);

test('production status panel follows the six metric cards and renders live status as text',async()=>{
 const {app,view}=load();app.renderOverview(overview);app.renderProductionStatus(statusData);
 assert.equal(view.children[0].className,'metrics-grid');assert.equal(view.children[0].children.length,6,'existing six metric cards stay first');
 const host=view.children.find(e=>e.className==='production-status-host');assert(host,'status panel host must be rendered in the overview');
 assert.equal(view.children[1],host,'status panel must be visible immediately after the metric grid');
 const panel=host.children[0];assert.match(panel.textContent,/正式服运行状态/);
 assert.match(item(panel,'接口服务').textContent,/正常/);assert.match(item(panel,'接口服务').textContent,/运行中/);assert.match(item(panel,'接口服务').textContent,/通过/);
 assert.match(item(panel,'数据库').textContent,/正常/);assert.match(item(panel,'数据库').textContent,/看板只读连接/);assert.match(item(panel,'数据库').textContent,/共享实例/);assert.match(item(panel,'数据库').textContent,/不代表全部游戏链路/);
 assert.match(item(panel,'Redis').textContent,/异常/);assert.match(item(panel,'Redis').textContent,/看板只读连接/);
 assert.match(item(panel,'订阅提醒').textContent,/已开启/);assert.match(item(panel,'订阅提醒').textContent,/正式版/);
 assert.match(item(panel,'定时发送').textContent,/已启用/);assert.match(item(panel,'定时发送').textContent,/运行中/);
 assert.match(item(panel,'定时发送').textContent,/2026\/10\/21 09:00:00/,'next run is shown in Beijing time via fmtDate');
 assert.doesNotMatch(item(panel,'定时发送').textContent,/已送达|用户已收到/);
 const receipts=item(panel,'发送回执').textContent;
 assert.match(receipts,/今日尝试 12/);assert.match(receipts,/受理 10/);assert.match(receipts,/失败 1/);assert.match(receipts,/未知 0/);assert.match(receipts,/发送中 1/);
 assert.match(receipts,/北京时间/);assert.match(receipts,/微信已受理/);assert.doesNotMatch(panel.textContent,/已送达|用户已收到/);
 assert.match(item(panel,'排行榜门槛').textContent,/101/);assert.match(item(panel,'排行榜门槛').textContent,/30/);
 assert.match(panel.textContent,/每 30 秒刷新，状态缓存最多 10 秒/);assert.match(panel.textContent,/探测只代表检查时点/);assert.match(panel.textContent,/开关显示配置值/);assert.match(panel.textContent,/微信受理不代表用户已收件/);
 assert.doesNotMatch(panel.textContent,/NaN|Infinity|undefined|null/);
});

test('leaderboard thresholds come from the response instead of being hardcoded',async()=>{
 const {app,view}=load();app.renderOverview(overview);app.renderProductionStatus({...statusData,leaderboards:{stageMinimum:150,bossMinimum:60}});
 const panel=view.children.find(e=>e.className==='production-status-host').children[0],text=item(panel,'排行榜门槛').textContent;
 assert.match(text,/150/);assert.match(text,/60/);assert.doesNotMatch(text,/101|30/);
});

test('unknown and unavailable status values are labelled honestly instead of zero or healthy',async()=>{
 const {app,view}=load();app.renderOverview(overview);app.renderProductionStatus({environment:null,checkedAt:null,refreshSeconds:null,
  api:{state:'unknown',serviceActive:null,probeOk:null},database:{state:'unknown'},redis:{state:'unknown'},
  subscriptions:{enabled:null,jumpState:'unknown',schedule:{enabled:null,active:null,nextRunAt:null,lastTriggerAt:null,workerResult:null,exitCode:null},
   receipts:{available:false,today:null,last:null}},leaderboards:{stageMinimum:null,bossMinimum:null}});
 const panel=view.children.find(e=>e.className==='production-status-host').children[0];
 assert.match(item(panel,'接口服务').textContent,/未知/);assert.match(item(panel,'接口服务').textContent,/未执行/);
 assert.match(item(panel,'数据库').textContent,/未知/);assert.match(item(panel,'Redis').textContent,/未知/);
 assert.match(item(panel,'订阅提醒').textContent,/未知/);
 assert.match(item(panel,'定时发送').textContent,/触发情况未知/);assert.doesNotMatch(item(panel,'定时发送').textContent,/尚未定时触发|已定时触发/,'a failed timer read is never reported as never-triggered');
 const receipts=item(panel,'发送回执').textContent;
 assert.match(receipts,/回执数据不可用/);assert.match(receipts,/最近一次：未知/);assert.doesNotMatch(receipts,/今日尝试 0|受理 0|失败 0|尚无发送记录/);
 assert.match(item(panel,'排行榜门槛').textContent,/—/);assert.doesNotMatch(panel.textContent,/NaN|Infinity|undefined|null/);
});

test('a completed worker run never implies delivery and a real receipt stays "微信已受理"',async()=>{
 const {app,view}=load();app.renderOverview(overview);app.renderProductionStatus(statusData);
 const panel=view.children.find(e=>e.className==='production-status-host').children[0];
 const schedule=item(panel,'定时发送').textContent;
 assert.match(schedule,/执行成功仅代表任务跑完/);assert.doesNotMatch(schedule,/消息已送达|用户已收到/);
 const receipts=item(panel,'发送回执').textContent;
 assert.match(receipts,/微信已受理/);assert.doesNotMatch(receipts,/已送达|用户已收到/);
 assert.match(receipts,/开始/);assert.match(receipts,/返回码 0/);
});

test('pending first receipt and empty daily counts are stated without fake zeros',async()=>{
 const {app,view}=load();app.renderOverview(overview);
 app.renderProductionStatus({...statusData,subscriptions:{...statusData.subscriptions,receipts:{available:true,today:{total:0,sent:0,failed:0,unknown:0,sending:0},last:null}}});
 const panel=view.children.find(e=>e.className==='production-status-host').children[0];
 const receipts=item(panel,'发送回执').textContent;
 assert.match(receipts,/今日尝试 0/);assert.match(receipts,/尚无发送记录/);assert.match(receipts,/首个真实回执待产生/);
});

test('status strings are rendered as text so injected markup stays inert',async()=>{
 const evil={...statusData,subscriptions:{...statusData.subscriptions,schedule:{...statusData.subscriptions.schedule,workerResult:'<img src=x onerror=alert(1)>'}},leaderboards:{stageMinimum:'<svg onload=alert(1)>',bossMinimum:30}};
 const {app,view}=load();app.renderOverview(overview);app.renderProductionStatus(evil);
 const panel=view.children.find(e=>e.className==='production-status-host').children[0];
 const schedule=item(panel,'定时发送');
 assert.equal(schedule.children.length,3,'only the fixed label/value/detail nodes are created');
 assert.equal(schedule.children[2].children.length,0,'server strings never become elements');
 assert.match(panel.textContent,/<img src=x onerror=alert\(1\)>/);assert.doesNotMatch(panel.textContent,/alert\(1\)><\/p>/);
 assert.match(item(panel,'排行榜门槛').textContent,/<svg onload=alert\(1\)>/);
 assert.doesNotMatch(panel.textContent,/undefined/);
});

test('an overview re-render keeps the status slot without inventing a healthy state',async()=>{
 const {app,view}=load();app.renderOverview(overview);app.renderProductionStatus(statusData);
 app.renderOverview({...overview,metrics:{...overview.metrics,dau:9}});
 const host=view.children.find(e=>e.className==='production-status-host');assert(host,'re-render keeps the status panel slot');
 assert.match(host.children[0].textContent,/正式服运行状态/);assert.match(host.children[0].textContent,/正在读取/);
 assert.equal(view.children[1],host);
 assert.equal(view.children[0].children.find(e=>e.children[0].textContent==='今日活跃用户').children[1].textContent,'9');
});

const tick=()=>new Promise(r=>setImmediate(r));
function routed(){
 const calls=[];let statusMode='ok';
 return {calls,setStatus(mode){statusMode=mode;},fetch:async url=>{calls.push(url);
  if(url.endsWith('/overview'))return {ok:true,json:async()=>overview};
  if(url.endsWith('/production-status')){if(statusMode==='fail')return {ok:false,status:503,json:async()=>({message:'DASHBOARD_UNAVAILABLE'})};if(statusMode==='pending')return new Promise(()=>{});return {ok:true,json:async()=>statusData};}
  throw new Error('unexpected '+url);}};
}

test('refresh loads metrics and production status independently and a status 503 keeps the six cards',async()=>{
 const r=routed(),{app,view}=load(r.fetch);app.activate();app.setTab('overview');
 await app.refresh();
 assert.deepEqual(r.calls,['/h5dashboard/api/overview','/h5dashboard/api/production-status'],'both endpoints load on one refresh');
 let host=view.children.find(e=>e.className==='production-status-host');
 assert.match(item(host.children[0],'接口服务').textContent,/正常/);
 r.setStatus('fail');await app.refresh();
 assert.equal(r.calls.length,4);
 assert.equal(view.children[0].className,'metrics-grid');assert.equal(view.children[0].children.length,6,'status failure must not erase the six business cards');
 assert.equal(view.children[0].children.find(e=>e.children[0].textContent==='今日活跃用户').children[1].textContent,'4');
 host=view.children.find(e=>e.className==='production-status-host');
 const panelText=host.children[0].textContent;
 assert.match(panelText,/读取失败/);assert.match(panelText,/未知/);
 const badge=walk(host.children[0]).find(e=>String(e.className).includes('status-badge'));
 assert.equal(badge.textContent,'未知','a failed probe is shown as unknown, never as fresh healthy');
 assert.equal(walk(host.children[0]).some(e=>String(e.className).includes('status-item')),false,'no stale per-service health rows survive a failed request');
 assert.equal(app.status(),null,'failed status is not cached');
});

test('switching back to the overview renders cached status and does not stack a second status request',async()=>{
 const r=routed(),{app,view}=load(r.fetch);app.activate();await app.refresh();
 assert.equal(r.calls.length,2);
 app.switchView('overview');
 const host=view.children.find(e=>e.className==='production-status-host');
 assert.match(item(host.children[0],'接口服务').textContent,/正常/,'cached status is visible immediately on view switch');
 await tick();assert.equal(r.calls.length,3,'view switch triggers one status refresh');
 r.setStatus('pending');app.switchView('overview');app.switchView('overview');await tick();
 assert.equal(r.calls.filter(u=>u.endsWith('/production-status')).length,3,'an in-flight status request is not duplicated');
});

test('a late status reply cannot cross a view switch',async()=>{
 const pending=[],{app,view}=load(url=>new Promise(resolve=>pending.push({url,resolve})));
 app.activate();app.setTab('overview');const refreshing=app.refresh();
 assert.equal(pending.length,2);
 app.switchView('player');
 const statusReq=pending.find(p=>p.url.endsWith('/production-status'));
 statusReq.resolve({ok:true,json:async()=>statusData});await tick();
 pending.find(p=>p.url.endsWith('/overview')).resolve({ok:true,json:async()=>overview});
 assert.equal(app.status(),null,'a reply from another view generation is discarded');
 assert.equal(view.textContent.includes('正式服运行状态'),false,'no status panel leaks into the player view');
 await refreshing;
});

test('a late status reply cannot cross logout or a fresh login',async()=>{
 const pending=[],{app,view}=load(url=>new Promise(resolve=>pending.push({url,resolve})));
 app.activate();app.setTab('overview');const refreshing=app.refresh();
 const first=pending.find(p=>p.url.endsWith('/production-status'));
 app.showLogin();
 first.resolve({ok:true,json:async()=>statusData});pending.find(p=>p.url.endsWith('/overview')).resolve({ok:true,json:async()=>overview});await tick();
 assert.equal(view.textContent,'','logout clears the view and ignores the late reply');
 assert.equal(app.status(),null);
 app.activate();app.switchView('overview');
 const panelNow=view.children.find(e=>e.className==='production-status-host').children[0];
 assert.match(panelNow.textContent,/正在读取/);assert.doesNotMatch(panelNow.textContent,/微信已受理/,'a new login never inherits the previous session status');
 const before=pending.length,again=app.refresh(),fresh=pending.slice(before);
 assert.equal(fresh.length,2,'a fresh session reloads metrics and status');
 fresh.find(p=>p.url.endsWith('/production-status')).resolve({ok:true,json:async()=>statusData});
 fresh.find(p=>p.url.endsWith('/overview')).resolve({ok:true,json:async()=>overview});
 await again;await tick();
 assert.match(view.children.find(e=>e.className==='production-status-host').children[0].textContent,/正式服运行状态/);
 await refreshing;
});

test('player and login log views never request production status',async()=>{
 const calls=[],{app}=load(async url=>{calls.push(url);if(url.endsWith('/login-logs'))return {ok:true,json:async()=>({today:'2026-10-20',total:0,offset:0,limit:50,hasMore:false,items:[]})};return {ok:true,json:async()=>overview};});
 app.activate();app.switchView('player');app.switchView('loginLogs');await tick();
 assert.equal(calls.some(u=>u.includes('production-status')),false,'status polling stays on the overview only');
});

test('an API probe is only healthy when service and probe are both explicitly true',async()=>{
 for(const [apiBlock,expected] of [
  [{state:'ok',serviceActive:null,probeOk:true},'未知'],
  [{state:'ok',serviceActive:true,probeOk:null},'未知'],
  [{state:'ok',serviceActive:null,probeOk:null},'未知'],
  [{state:'ok',serviceActive:true,probeOk:false},'异常'],
  [{state:'unknown',serviceActive:true,probeOk:true},'未知']]){
  const {app,view}=load();app.renderOverview(overview);app.renderProductionStatus({...statusData,api:apiBlock});
  const panel=view.children.find(e=>e.className==='production-status-host').children[0];
  const value=item(panel,'接口服务').children[1].textContent;
  assert.equal(value,expected,`api=${JSON.stringify(apiBlock)}`);
  const badge=walk(panel).find(e=>String(e.className).includes('status-badge'));
  assert.notEqual(badge.textContent,'正常','an unknown or inconsistent payload is never shown green');
 }
});

test('a zero-count day with an earlier receipt does not claim a first pending receipt',async()=>{
 const {app,view}=load();app.renderOverview(overview);
 app.renderProductionStatus({...statusData,subscriptions:{...statusData.subscriptions,receipts:{available:true,today:{total:0,sent:0,failed:0,unknown:0,sending:0},last:statusData.subscriptions.receipts.last}}});
 const receipts=item(view.children.find(e=>e.className==='production-status-host').children[0],'发送回执').textContent;
 assert.match(receipts,/今日尚无发送尝试/);assert.doesNotMatch(receipts,/首个真实回执待产生/);assert.match(receipts,/微信已受理/);
});
