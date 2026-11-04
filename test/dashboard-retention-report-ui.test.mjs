import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');
const source=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8');
const periods=[1,3,5,7,14,20,30];
const ok=value=>({ok:true,status:200,json:async()=>value});
const failure=(status,message)=>({ok:false,status,json:async()=>({message})});
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const fixture=()=>({schemaVersion:1,environment:'production',timezone:'Asia/Shanghai',asOfDate:'2026-11-01',generatedAt:'2026-11-01T16:10:00.000Z',coverageStart:'2026-10-01',trackingStartedAt:'2026-10-01T02:00:00.000Z',historyDays:120,periods:[...periods],cohorts:[{date:'2026-10-31',newUsers:10,cells:periods.map(day=>({day,observationDate:day===1?'2026-11-01':'2026-11-03',status:day===1?'complete':'pending',returned:day===1?2:null,cohortSize:10,rate:day===1?.2:null}))}],summary:periods.map(day=>({day,cohortSize:day===1?10:0,returned:day===1?2:0,rate:day===1?.2:null,cohortDays:day===1?1:0}))});
const overview={today:'2026-11-02',coverageStart:'2026-10-01',generatedAt:'2026-11-02T01:00:00Z',metrics:{dau:1,newUsers:1,totalUsers:10,d1:{rate:null,cohortSize:0,returned:0}},history:[]};
async function setup(t,report=async()=>ok(fixture()),other=()=>null){
 const dom=new JSDOM(html,{url:'https://dashboard.test/h5dashboard/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,calls=[],timers=[],errors=[];
 t.after(()=>w.close());
 const RealDate=w.Date;
 w.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-11-02T01:00:00.000Z']));}static now(){return new RealDate('2026-11-02T01:00:00Z').getTime();}};
 w.setInterval=fn=>{timers.push(fn);return timers.length;};w.clearInterval=()=>{};
 w.addEventListener('error',e=>errors.push(e.error));
 w.fetch=async(url,options)=>{calls.push({url,options});const path=url.split('/api/')[1];if(path==='retention-report')return report();const custom=other(path);if(custom)return custom;if(path==='overview')return ok(overview);if(path==='production-status')return ok({api:{state:'ok'}});return ok({});};
 w.eval(source);await flush();
 const nav=()=>{const button=w.document.querySelector('[data-view="retentionReport"]');assert(button,'留存分析导航缺失');button.click();};
 return {w,document:w.document,calls,timers,errors,nav,view:w.document.getElementById('view-container'),reportCalls:()=>calls.filter(c=>c.url.endsWith('/retention-report'))};
}
test('saved retention report has an independent GET navigation, complete matrix, samples and Beijing cutoff metadata',async t=>{
 const h=await setup(t);assert.equal(h.reportCalls().length,0);h.nav();await flush();
 assert.equal(h.document.getElementById('page-title').textContent,'留存分析');
 const request=h.reportCalls()[0];assert.equal(h.reportCalls().length,1);assert.equal(request.options.method,'GET');assert.equal(request.options.body,undefined);assert.equal(request.options.credentials,'same-origin');
 const table=h.view.querySelector('.retention-report-table');assert(table);assert.deepEqual([...table.querySelectorAll('thead th')].map(e=>e.textContent),['注册日期（北京时间）','新增','D1','D3','D5','D7','D14','D20','D30']);
 const cells=table.querySelector('tbody tr').cells;assert.equal(cells[0].textContent,'2026-10-31（周六）');assert.equal(cells[1].textContent,'10');assert.match(cells[2].textContent,/20\.00%/);assert.match(cells[2].textContent,/2 \/ 10/);assert.match(cells[3].textContent,/待统计/);assert(table.querySelector('tbody tr').classList.contains('history-weekend'));
 assert.match(h.view.textContent,/数据截至.*2026-11-01/);assert.match(h.view.textContent,/实际生成时间.*2026\/11\/2.*00:10:00/);assert.match(h.view.textContent,/覆盖起点.*2026-10-01/);assert.match(h.view.textContent,/计划更新.*00:10/);assert.match(h.view.textContent,/120/);
 assert.match(h.view.textContent,/注册后第.*自然日当天登录/);assert.match(h.view.textContent,/非.*累计/);assert.match(h.view.textContent,/成功登录.*去重/);assert.match(h.view.textContent,/长周期.*样本不足.*不代表 0/);
 assert.equal(h.errors.length,0);
});
test('automatic polling and visibility changes never reload retention or overview while retention is active',async t=>{
 const h=await setup(t);h.nav();await flush();const calls=h.calls.length;
 for(const timer of h.timers)await timer();await flush();h.document.dispatchEvent(new h.w.Event('visibilitychange'));await flush();
 assert.equal(h.calls.length,calls,'saved report page must not query DB via overview poll or reload the saved report');
 h.document.getElementById('retention-report-refresh').click();await flush();assert.equal(h.reportCalls().length,2);assert.equal(h.calls.length,calls+1);
});
test('a newer manual refresh wins over a slow initial response, and tab re-entry ignores the previous page response',async t=>{
 const pending=[],h=await setup(t,()=>new Promise(r=>pending.push(r)));h.nav();h.document.getElementById('retention-report-refresh').click();assert.equal(pending.length,2);
 pending[1](ok({...fixture(),asOfDate:'2026-10-30'}));await flush();pending[0](ok(fixture()));await flush();assert.match(h.view.textContent,/数据截至 2026-10-30/);
 h.document.getElementById('retention-report-refresh').click();h.document.querySelector('[data-view="player"]').click();h.nav();assert.equal(pending.length,4);
 pending[3](ok({...fixture(),asOfDate:'2026-10-29'}));await flush();pending[2](ok(fixture()));await flush();assert.match(h.view.textContent,/数据截至 2026-10-29/);
});
test('logout removes private retention data and ignores responses that arrive later',async t=>{
 const pending=[],h=await setup(t,()=>new Promise(r=>pending.push(r)));h.nav();h.document.getElementById('logout-btn').click();await flush();pending[0](ok(fixture()));await flush();assert.equal(h.view.textContent,'');assert(h.document.getElementById('login-screen').classList.contains('active'));
});
test('unavailable reports give friendly guidance, clear figures and retry without leaking server paths',async t=>{
 let n=0;const h=await setup(t,async()=>++n===1?ok(fixture()):n===2?failure(503,'RETENTION_REPORT_UNAVAILABLE'):ok(fixture()));h.nav();await flush();
 h.document.getElementById('retention-report-refresh').click();await flush();assert.match(h.view.textContent,/报表尚未生成或暂不可用/);assert.equal(h.view.querySelector('table'),null);assert.doesNotMatch(h.view.textContent,/RETENTION_REPORT_UNAVAILABLE|\/var\/|NaN/);h.document.getElementById('retention-report-refresh').click();await flush();assert(h.view.querySelector('table'));
});
test('401 on an active retention request returns to login and clears private data',async t=>{
 let n=0;const h=await setup(t,async()=>++n===1?ok(fixture()):failure(401,'DASHBOARD_LOGIN_REQUIRED'));h.nav();await flush();h.document.getElementById('retention-report-refresh').click();await flush();assert.equal(h.view.textContent,'');assert(h.document.getElementById('login-screen').classList.contains('active'));
});
test('stale retention errors including 401 cannot replace a newer page or log out a newer session',async t=>{
 const pending=[],h=await setup(t,()=>new Promise(r=>pending.push(r)));h.nav();h.document.querySelector('[data-view="player"]').click();const player=h.view.textContent;
 pending[0](failure(401,'DASHBOARD_LOGIN_REQUIRED'));await flush();assert.equal(h.view.textContent,player);assert(h.document.getElementById('dashboard-screen').classList.contains('active'));
 h.nav();h.document.getElementById('logout-btn').click();await flush();h.document.getElementById('login-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
 pending[1](failure(401,'DASHBOARD_LOGIN_REQUIRED'));await flush();assert(h.document.getElementById('dashboard-screen').classList.contains('active'));assert.equal(h.document.getElementById('page-title').textContent,'实时概览');
});
test('all pre-existing navigation and overview polling still work after leaving retention',async t=>{
 const h=await setup(t,async()=>ok(fixture()),path=>path==='login-logs'?ok({date:'2026-11-02',items:[],offset:0,total:0,limit:20,hasMore:false}):path==='video-ranking'?ok({date:'2026-11-02',items:[]}):path==='yesterday-analysis'?ok({cohortDate:'2026-11-01',today:'2026-11-02',registrations:{total:0},rewardedVideos:{total:0},returnedUsers:{total:0}}):null);
 h.nav();await flush();
 for(const [tab,title,selector] of [['player','玩家查询','#player-form'],['saveRepair','修改数据','#save-repair-form'],['loginLogs','登录日志','#login-log-results'],['videoRanking','视频排行','#video-ranking-results'],['yesterdayAnalysis','昨日用户分析','#yesterday-analysis-results'],['overview','实时概览','.metrics-grid']]){h.document.querySelector(`[data-view="${tab}"]`).click();await flush();assert.equal(h.document.getElementById('page-title').textContent,title);assert(h.view.querySelector(selector));}
 const count=h.calls.filter(c=>c.url.endsWith('/overview')).length;await h.timers.at(-1)();await flush();assert.equal(h.calls.filter(c=>c.url.endsWith('/overview')).length,count+1);assert.equal(h.errors.length,0);
});
test('malformed reports show a safe unavailable state rather than raw exceptions or fabricated zeros',async t=>{
 let value=null;const h=await setup(t,async()=>ok(value));h.nav();await flush();
 for(const bad of [null,{}, {...fixture(),schemaVersion:2},{...fixture(),environment:'staging'},{...fixture(),timezone:'UTC'},{...fixture(),asOfDate:'not-a-date'},{...fixture(),generatedAt:'bad-date'},{...fixture(),cohorts:{}}]){value=bad;h.document.getElementById('retention-report-refresh').click();await flush();assert.match(h.view.textContent,/报表数据格式异常.*暂不可用/);assert.doesNotMatch(h.view.textContent,/Cannot read|not a function|undefined|Invalid Date|NaN|0\.00%/);assert.equal(h.view.querySelector('table'),null);}
});
test('unknown cell data and injected values remain safe text without reporting invalid complete values as zero',async t=>{
 const data=fixture(),attack='<img src=x onerror="window.retentionXss=1"><script>window.retentionXss=2</script>';
 data.cohorts[0].cells[0]={day:1,status:'complete',cohortSize:10,returned:null,rate:null,observationDate:attack};
 data.cohorts[0].cells[1]={day:3,status:attack,cohortSize:attack,returned:attack,rate:attack,observationDate:attack};
 data.cohorts[0].newUsers=attack;data.summary[0]={day:1,cohortSize:10,returned:attack,rate:attack,cohortDays:attack};
 const h=await setup(t,async()=>ok(data));h.nav();await flush();
 const cells=h.view.querySelector('.retention-report-table tbody tr').cells;assert.equal(cells[1].textContent,'—');assert.equal(cells[2].textContent,'—（未知）');assert.equal(cells[3].textContent,'—（未知）');assert.equal(cells[2].title,`D1 · 观察日期 ${attack}`);assert.equal(h.view.querySelector('img,script,[onerror]'),null);assert.equal(h.w.retentionXss,undefined);assert.equal(h.view.querySelector('.retention-summary [data-day="1"] .metric-value').textContent,'—');assert.doesNotMatch(h.view.textContent,/NaN|Infinity|0\.00%/);
});
test('cohort dates are descending without mutating the report and empty reports show no-sample guidance',async t=>{
 const data=fixture();data.cohorts.unshift({...structuredClone(data.cohorts[0]),date:'2026-10-30'});const h=await setup(t,async()=>ok(data));h.nav();await flush();assert.match(h.view.querySelector('.retention-report-table tbody tr').cells[0].textContent,/2026-10-31/);assert.equal(data.cohorts[0].date,'2026-10-30');data.cohorts=[];h.document.getElementById('retention-report-refresh').click();await flush();assert.match(h.view.textContent,/暂无注册批次/);
});
test('network and invalid JSON failures show safe retry text, never internal paths or exception details',async t=>{
 let n=0;const h=await setup(t,async()=>{if(++n===1)throw new Error('/var/private/report.json unavailable');return {ok:true,json:async()=>{throw new SyntaxError('Unexpected token /secret/report');}};});h.nav();await flush();assert.match(h.view.textContent,/报表.*暂不可用/);assert.doesNotMatch(h.view.textContent,/\/var|private|secret|Unexpected token/);h.document.getElementById('retention-report-refresh').click();await flush();assert.match(h.view.textContent,/报表.*暂不可用/);assert.doesNotMatch(h.view.textContent,/secret|Unexpected token/);
});
test('a superseded 401 in the same retention view cannot clear the newer valid snapshot',async t=>{
 const pending=[],h=await setup(t,()=>new Promise(r=>pending.push(r)));h.nav();h.document.getElementById('retention-report-refresh').click();pending[1](ok(fixture()));await flush();pending[0](failure(401,'DASHBOARD_LOGIN_REQUIRED'));await flush();assert.match(h.view.textContent,/数据截至 2026-11-01/);assert(h.document.getElementById('dashboard-screen').classList.contains('active'));
});
test('all seven complete periods render two-decimal rates with visible counts even when cells are unordered',async t=>{
 const data=fixture();data.cohorts[0].cells=periods.map((day,i)=>({day,status:'complete',returned:i,cohortSize:10,rate:i/10,observationDate:'2026-11-01'})).reverse();const h=await setup(t,async()=>ok(data));h.nav();await flush();const cells=h.view.querySelector('.retention-report-table tbody tr').cells;for(const [i,day]of periods.entries()){assert.equal(cells[i+2].querySelector('strong').textContent,`${(i*10).toFixed(2)}%`);assert.equal(cells[i+2].querySelector('.retention-sample').textContent,`${i} / 10`);assert.match(cells[i+2].title,new RegExp(`D${day} · 观察日期`));}
});
test('history windows accept legal 1..366 day snapshots and reject invalid windows or excessive cohort rows',async t=>{
 let data=fixture();const h=await setup(t,async()=>ok(data));h.nav();await flush();
 for(const days of [1,120,366]){data={...fixture(),historyDays:days};h.document.getElementById('retention-report-refresh').click();await flush();assert(h.view.querySelector('.retention-report-table'),`legal historyDays=${days}`);assert.match(h.view.textContent,new RegExp(`历史窗口 ${days} 天`));}
 for(const days of [0,-1,367,1.5,'120',null]){data={...fixture(),historyDays:days};h.document.getElementById('retention-report-refresh').click();await flush();assert.match(h.view.textContent,/报表数据格式异常/);assert.equal(h.view.querySelector('table'),null);}
 data={...fixture(),historyDays:1,cohorts:[fixture().cohorts[0],{...fixture().cohorts[0],date:'2026-10-30'}]};h.document.getElementById('retention-report-refresh').click();await flush();assert.match(h.view.textContent,/报表数据格式异常/);
});
test('old saved cutoff is prominently expired against Beijing yesterday without inventing current data',async t=>{
 const data=fixture();data.asOfDate='2026-10-31';
 const h=await setup(t,async()=>ok(data));h.nav();await flush();
 const warning=h.view.querySelector('[role="alert"]');assert(warning,'expired snapshot must show alert');assert.match(warning.textContent,/报表已过期/);assert.match(warning.textContent,/2026-10-31/);assert.match(warning.textContent,/2026-11-01/);assert.match(warning.textContent,/未更新/);assert.match(h.view.textContent,/数据截至 2026-10-31/);
 const css=await readFile(new URL('../dashboard/public/style.css',import.meta.url),'utf8');assert.match(css,/\.retention-expired\s*\{[^}]*border/);
});
test('the normal Beijing 00:00 to 00:10 schedule gap is pending, not an overdue failure',async t=>{
 let data={...fixture(),asOfDate:'2026-10-31'};const h=await setup(t,async()=>ok(data));const RealDate=h.w.Date;let moment='2026-11-01T16:05:00Z';h.w.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[moment]));}};h.nav();await flush();
 assert.equal(h.view.querySelector('[role="alert"]'),null);assert.match(h.view.textContent,/待.*00:10.*更新/);
 moment='2026-11-01T16:10:01Z';h.document.getElementById('retention-report-refresh').click();await flush();assert(h.view.querySelector('[role="alert"]'));
 moment='2026-11-01T16:05:00Z';data={...fixture(),asOfDate:'2026-10-30'};h.document.getElementById('retention-report-refresh').click();await flush();assert(h.view.querySelector('[role="alert"]'),'older missing days remain overdue even before 00:10');
});
test('Beijing midnight rollover treats the previous Beijing day as yesterday, independent of browser timezone',async t=>{
 const h=await setup(t);const RealDate=h.w.Date;h.w.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-11-01T16:00:01Z']));}};h.nav();await flush();assert.equal(h.view.querySelector('[role="alert"]'),null);
});
test('weighted summary uses saved mature samples, not pending cohorts or unweighted daily averages; zero and missing states stay distinct',async t=>{
 const data=fixture();data.cohorts[0].cells[0]={day:1,status:'complete',returned:0,cohortSize:10,rate:0,observationDate:'2026-11-01'};
 data.cohorts[0].cells[2].status='uncovered';data.cohorts[0].cells[3].status='empty';
 data.cohorts.push({date:'2026-10-30',newUsers:90,cells:[{day:1,status:'complete',returned:90,cohortSize:90,rate:1,observationDate:'2026-10-31'}]});
 data.cohorts.unshift({date:'2026-11-01',newUsers:1000,cells:periods.map(day=>({day,status:'pending',returned:null,cohortSize:1000,rate:null}))});
 data.summary[0]={day:1,returned:90,cohortSize:100,rate:.9,cohortDays:2};
 const h=await setup(t,async()=>ok(data));h.nav();await flush();
 const summary=h.view.querySelector('.retention-summary');assert(summary,'weighted sample summary visible');
 const d1=summary.querySelector('[data-day="1"]');assert.match(d1.textContent,/90\.00%/);assert.match(d1.textContent,/90 \/ 100/);assert.match(d1.textContent,/2.*批次/);assert.doesNotMatch(d1.textContent,/50\.00%|1100/);
 const d30=summary.querySelector('[data-day="30"]');assert.equal(d30.querySelector('.metric-value').textContent,'—');assert.match(d30.textContent,/样本.*0/);
 const rows=[...h.view.querySelectorAll('.retention-report-table tbody tr')];assert.match(rows[0].cells[0].textContent,/2026-11-01（周日）/);
 const cells=rows[1].cells;assert.match(cells[2].textContent,/0\.00%/);assert.match(cells[2].textContent,/0 \/ 10/);assert.equal(cells[3].textContent,'待统计');assert.equal(cells[4].textContent,'无覆盖');assert.equal(cells[5].textContent,'—（无新增）');
 assert.match(h.view.textContent,/已成熟.*已覆盖.*人数加权/);assert.match(h.view.textContent,/不.*未成熟/);assert.doesNotMatch(h.view.textContent,/NaN|Infinity|undefined/);
 const css=await readFile(new URL('../dashboard/public/style.css',import.meta.url),'utf8');assert.match(css,/\.retention-sample\s*\{[^}]*display:\s*block/);assert.match(css,/\.retention-report-table\s*\{[^}]*min-width/);
});
