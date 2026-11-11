import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
const settle=()=>new Promise(r=>setImmediate(r));
const item={recordedAt:'2026-10-19T16:30:00Z',openid:'oPlayer_exact-1',nickname:'<img src=x onerror=alert(1)>',placement:'boss_reward'};
const sample={today:'2026-10-20',date:'2026-10-20',timezone:'Asia/Shanghai',generatedAt:'2026-10-19T16:31:00Z',openid:null,total:2,offset:0,limit:50,hasMore:false,items:[item,{...item,recordedAt:'2026-10-19T16:20:00Z',nickname:null,placement:'<script>raw</script>'}]};
async function setup(t,fetch=async()=>({ok:true,json:async()=>sample})){
 const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');
 const source=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8');
 const dom=new JSDOM(html);t.after(()=>dom.window.close());
 class Clock extends Date{constructor(...args){super(...(args.length?args:['2026-10-19T16:31:00Z']));}}
 const app=runInNewContext(source.slice(0,source.indexOf("$('login-form').addEventListener"))+';({switchView,showLogin,renderVideoLogs:typeof renderVideoLogs===\'function\'?renderVideoLogs:null,activate(){loggedIn=true;},isLoggedIn(){return loggedIn;}})',{document:dom.window.document,fetch,Date:Clock});
 return {app,document:dom.window.document,view:dom.window.document.getElementById('view-container')};
}
async function setupFullScript(t,fetch){
 const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');
 const source=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8');
 const dom=new JSDOM(html,{runScripts:'outside-only'});t.after(()=>dom.window.close());
 dom.window.fetch=async(url,options)=>url==='/h5dashboard/api/me'?{ok:true,json:async()=>({})}:fetch(url,options);
 dom.window.eval(source);await settle();
 const document=dom.window.document;
 assert(document.getElementById('dashboard-screen').classList.contains('active'));
 document.querySelector('[data-view="videoLogs"]').click();
 return {document,view:document.getElementById('view-container')};
}
const button=(view,text)=>[...view.querySelectorAll('button')].find(e=>e.textContent===text);
const event=(document,type)=>new document.defaultView.Event(type,{bubbles:true,cancelable:true});
test('video placement input combines filters and persists through pagination, refresh and player clearing',async t=>{
 const calls=[];const {app,document,view}=await setup(t,async(_u,o)=>{const input=JSON.parse(o.body);calls.push(input);return {ok:true,json:async()=>({...sample,...input,total:120,hasMore:input.offset<100})};});
 app.activate();app.switchView('videoLogs');await settle();
 const placement=view.querySelector('#video-log-placement'),openid=view.querySelector('#video-log-openid'),form=view.querySelector('#video-log-filter');
 assert(placement,'placement query control exists');assert.match(view.textContent,/视频广告点位.*精确匹配/);
 placement.value='Main/LevelSkip';placement.dispatchEvent(event(document,'input'));assert.equal(view.querySelector('.video-logs-table'),null);openid.value='oExact';form.dispatchEvent(event(document,'submit'));await settle();
 const body={offset:0,date:'2026-10-20',openid:'oExact',placement:'Main/LevelSkip'};assert.deepEqual(calls.at(-1),body);assert.match(view.textContent,/点位 Main\/LevelSkip/);
 button(view,'下一页').click();await settle();assert.deepEqual(calls.at(-1),{...body,offset:50});button(view,'上一页').click();await settle();assert.deepEqual(calls.at(-1),body);
 button(view,'刷新').click();await settle();assert.deepEqual(calls.at(-1),body);
 button(view,'清除玩家筛选').click();await settle();const noPlayer={offset:0,date:body.date,placement:body.placement};assert.deepEqual(calls.at(-1),noPlayer);
 const date=view.querySelector('#video-log-date');date.value='2026-10-18';date.dispatchEvent(event(document,'change'));await settle();assert.deepEqual(calls.at(-1),{...noPlayer,date:'2026-10-18'});
 button(view,'清除点位筛选').click();await settle();assert.equal(placement.value,'');assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18'});
});
for(const status of [200,401])test(`placement edits invalidate late ${status} results in the complete script`,async t=>{
 const pending=[],calls=[];const {document,view}=await setupFullScript(t,async(_u,o)=>{calls.push(JSON.parse(o.body));return new Promise(r=>pending.push(r));});
 const placement=view.querySelector('#video-log-placement');placement.value='Main/LevelSkip';placement.dispatchEvent(event(document,'input'));
 pending[0](status===200?{ok:true,json:async()=>sample}:{ok:false,status,json:async()=>({message:'DASHBOARD_LOGIN_REQUIRED'})});await settle();
 assert(document.getElementById('dashboard-screen').classList.contains('active'));assert.equal(view.querySelector('.video-logs-table'),null);assert.match(view.textContent,/筛选条件已修改/);assert.equal(calls.length,1);
 view.querySelector('#video-log-filter').dispatchEvent(event(document,'submit'));assert.equal(calls.at(-1).placement,'Main/LevelSkip');pending[1]({ok:true,json:async()=>({...sample,placement:'Main/LevelSkip',items:[],total:0})});await settle();assert.match(view.textContent,/共 0 条.*点位 Main\/LevelSkip/);
});
test('placement validation blocks malformed input and exact markup/Unicode values remain text',async t=>{
 const calls=[];const {app,document,view}=await setup(t,async(_u,o)=>{const body=JSON.parse(o.body);calls.push(body);return {ok:true,json:async()=>({...sample,...body,items:[],total:0})};});
 app.activate();app.switchView('videoLogs');await settle();const input=view.querySelector('#video-log-placement'),form=view.querySelector('#video-log-filter');
 for(const value of [' bad','bad ','a'.repeat(65),'a\u0085b','a\ud800']){input.value=value;input.dispatchEvent(event(document,'input'));form.dispatchEvent(event(document,'submit'));await settle();assert.equal(calls.length,1);assert.match(view.textContent,/完整视频广告点位/);}
 for(const value of ['<img src=x onerror=alert(1)>','😀'.repeat(64)]){input.value=value;form.dispatchEvent(event(document,'submit'));await settle();assert.equal(calls.at(-1).placement,value);assert(view.textContent.includes(value));assert.equal(view.querySelectorAll('img,script').length,0);}
});
test('video-log filters combine exact openid and selected date; pages retain filters and queries reset offset',async t=>{
 const calls=[];const {app,document,view}=await setup(t,async(_url,options)=>{const input=JSON.parse(options.body);calls.push(input);return {ok:true,json:async()=>({...sample,date:input.date,openid:input.openid??null,offset:input.offset,total:120,hasMore:input.offset<100})};});
 app.activate();app.switchView('videoLogs');await settle();
 const date=view.querySelector('#video-log-date'),openid=view.querySelector('#video-log-openid'),form=view.querySelector('#video-log-filter');
 assert(date&&openid&&form,'date/openid query controls exist');assert.equal(date.value,'2026-10-20');assert.equal(openid.maxLength,128);
 openid.value='oPlayer_exact-1';openid.dispatchEvent(event(document,'input'));form.dispatchEvent(event(document,'submit'));await settle();
 assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-20',openid:'oPlayer_exact-1'});
 button(view,'下一页').click();await settle();assert.deepEqual(calls.at(-1),{offset:50,date:'2026-10-20',openid:'oPlayer_exact-1'});
 button(view,'上一页').click();await settle();assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-20',openid:'oPlayer_exact-1'});
 date.value='2026-10-18';date.dispatchEvent(event(document,'change'));await settle();assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18',openid:'oPlayer_exact-1'});
 button(view,'下一页').click();await settle();assert.equal(calls.at(-1).offset,50);
 button(view,'刷新').click();await settle();assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18',openid:'oPlayer_exact-1'});
 button(view,'清除玩家筛选').click();await settle();assert.equal(openid.value,'');assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18'});
 assert.match(view.textContent,/每页 50 条/);assert.match(view.textContent,/共 120 条/);
});
test('invalid openid and empty date never query; editing a filter invalidates a pending response',async t=>{
 const pending=[],calls=[];const {app,document,view}=await setup(t,async(_url,options)=>{calls.push(JSON.parse(options.body));return new Promise(r=>pending.push(r));});
 app.activate();app.switchView('videoLogs');
 const input=view.querySelector('#video-log-openid'),date=view.querySelector('#video-log-date'),form=view.querySelector('#video-log-filter');
 input.value='invalid openid';input.dispatchEvent(event(document,'input'));
 pending[0]({ok:true,json:async()=>sample});await settle();assert.doesNotMatch(view.textContent,/boss_reward/);assert.match(view.textContent,/筛选条件已修改/);
 form.dispatchEvent(event(document,'submit'));await settle();assert.equal(calls.length,1);assert.match(view.textContent,/openid.*格式|完整.*openid/);
 input.value='';input.dispatchEvent(event(document,'input'));date.value='';date.dispatchEvent(event(document,'change'));await settle();assert.equal(calls.length,1);assert.match(view.textContent,/请选择查询日期/);
});
for(const status of [200,401]){
 test(`date input without change discards a late ${status} response in the full dashboard script`,async t=>{
  const pending=[],calls=[];const {document,view}=await setupFullScript(t,async(url,options)=>{
   assert.equal(url,'/h5dashboard/api/video-logs');calls.push(JSON.parse(options.body));return new Promise(r=>pending.push(r));
  });
  const date=view.querySelector('#video-log-date'),selectedDate='2024-02-29';
  date.value=selectedDate;date.dispatchEvent(event(document,'input'));
  assert.equal(calls.length,1,'input editing must not query before change');
  pending[0](status===200?{ok:true,json:async()=>sample}:{ok:false,status,json:async()=>({message:'DASHBOARD_LOGIN_REQUIRED'})});await settle();
  assert(document.getElementById('dashboard-screen').classList.contains('active'),'stale 401 must not log out');
  assert(!document.getElementById('login-screen').classList.contains('active'));
  assert.equal(view.querySelector('.video-logs-table'),null,'stale 200 must not render old-date rows');
  assert.match(view.querySelector('#video-log-results').textContent,/筛选条件已修改/);
  assert.doesNotMatch(view.textContent,/正在加载视频日志|登录已过期|boss_reward/);
  assert.equal(date.value,selectedDate);assert.equal(calls.length,1);
  date.dispatchEvent(event(document,'change'));
  assert.deepEqual(calls.at(-1),{offset:0,date:selectedDate});assert.equal(calls.length,2);
  pending[1]({ok:true,json:async()=>({...sample,date:selectedDate})});await settle();
  assert.match(view.textContent,/2024-02-29.*共 2 条/);assert.match(view.textContent,/boss_reward/);
  date.value='2024-03-01';date.dispatchEvent(event(document,'input'));
  assert.equal(view.querySelector('.video-logs-table'),null,'input must also clear already displayed rows');
  assert.match(view.querySelector('#video-log-results').textContent,/筛选条件已修改/);assert.equal(calls.length,2);
 });
}
test('empty date input clears old errors and discards pending results without querying today',async t=>{
 const pending=[],calls=[];const {document,view}=await setupFullScript(t,async(url,options)=>{
  assert.equal(url,'/h5dashboard/api/video-logs');calls.push(JSON.parse(options.body));return new Promise(r=>pending.push(r));
 });
 pending[0]({ok:false,status:503,json:async()=>({message:'DASHBOARD_UNAVAILABLE'})});await settle();
 assert.match(view.textContent,/服务暂时不可用/);
 const date=view.querySelector('#video-log-date');date.value='';date.dispatchEvent(event(document,'input'));
 assert.match(view.querySelector('#video-log-results').textContent,/请选择查询日期/);assert.doesNotMatch(view.textContent,/服务暂时不可用/);assert.equal(calls.length,1);
 date.value='2024-02-29';date.dispatchEvent(event(document,'change'));
 date.value='';date.dispatchEvent(event(document,'input'));assert.equal(calls.length,2);
 pending[1]({ok:true,json:async()=>sample});await settle();
 assert.match(view.querySelector('#video-log-results').textContent,/请选择查询日期/);assert.equal(view.querySelector('.video-logs-table'),null);assert.equal(calls.length,2);
});
test('empty video-log pages keep four-column colspan, no fake rows and bounded pagination',async t=>{
 const {app,view}=await setup(t);assert.equal(typeof app.renderVideoLogs,'function');
 for(const openid of [null,'missing-player']){
  app.renderVideoLogs({...sample,openid,total:0,items:[]},view);
  assert.match(view.textContent,/暂无.*视频/);const cell=view.querySelector('tbody td');assert.equal(cell.colSpan,4);assert.equal(view.querySelectorAll('tbody tr').length,1);
  assert(button(view,'上一页').disabled&&button(view,'下一页').disabled);assert.doesNotMatch(view.textContent,/NaN|Infinity/);
 }
});
test('video-log tab loads today and renders each stored event with four safe text columns',async t=>{
 const calls=[];const {app,document,view}=await setup(t,async(url,options)=>{calls.push({url,body:JSON.parse(options.body),method:options.method});return {ok:true,json:async()=>sample};});
 const nav=document.querySelector('[data-view="videoLogs"]');assert(nav,'video-log tab must exist');assert.equal(nav.textContent,'视频日志');
 app.activate();app.switchView('videoLogs');await settle();assert.equal(document.getElementById('page-title').textContent,'视频日志');
 assert.deepEqual(calls,[{url:'/h5dashboard/api/video-logs',body:{offset:0,date:'2026-10-20'},method:'POST'}]);
 assert.deepEqual([...view.querySelectorAll('th')].map(e=>e.textContent),['时间（北京时间）','openid','昵称','视频广告点位']);
 const rows=view.querySelectorAll('.video-logs-table tbody tr');assert.equal(rows.length,2);
 assert.deepEqual([...rows[0].children].map(e=>e.textContent),['2026/10/20 00:30:00',item.openid,item.nickname,item.placement]);
 assert.equal(rows[1].children[2].textContent,'—');assert.equal(rows[1].children[3].textContent,'<script>raw</script>');assert.equal(view.querySelectorAll('img,script').length,0);
 assert.match(view.textContent,/服务端.*入库/);assert.match(view.textContent,/不代表.*(广告平台|有效播放)/);assert.match(view.textContent,/共 2 条/);
});

test('switching dates discards a late response and logout never restores rows',async t=>{
 const pending=[];const {app,document,view}=await setup(t,async()=>new Promise(r=>pending.push(r)));
 app.activate();app.switchView('videoLogs');const date=view.querySelector('#video-log-date');date.value='2026-10-18';date.dispatchEvent(event(document,'change'));
 pending[1]({ok:true,json:async()=>({...sample,date:'2026-10-18',items:[{...item,openid:'historical-user'}]})});await settle();
 pending[0]({ok:true,json:async()=>sample});await settle();assert.match(view.textContent,/historical-user/);assert.doesNotMatch(view.textContent,/oPlayer_exact-1/);
 button(view,'刷新').click();app.showLogin();pending[2]({ok:true,json:async()=>sample});await settle();assert.equal(view.textContent,'');
});
test('a stale unauthorized video response cannot log out another tab or overwrite newer results',async t=>{
 const pending=[];const {app,view}=await setup(t,async()=>new Promise(r=>pending.push(r)));
 app.activate();app.switchView('videoLogs');app.switchView('player');const player=view.textContent;
 pending[0]({ok:false,status:401,json:async()=>({message:'DASHBOARD_LOGIN_REQUIRED'})});await settle();assert(app.isLoggedIn());assert.equal(view.textContent,player);
 app.switchView('videoLogs');button(view,'刷新').click();pending[2]({ok:true,json:async()=>sample});await settle();
 pending[1]({ok:false,status:401,json:async()=>({message:'DASHBOARD_LOGIN_REQUIRED'})});await settle();assert(app.isLoggedIn());assert.match(view.textContent,/boss_reward/);
});
test('a current unauthorized response returns to login and storage errors permit manual retry',async t=>{
 let state='storage';const {app,document,view}=await setup(t,async()=>state==='ok'?{ok:true,json:async()=>sample}:state==='auth'?{ok:false,status:401,json:async()=>({message:'DASHBOARD_LOGIN_REQUIRED'})}:{ok:false,status:503,json:async()=>({message:'DASHBOARD_UNAVAILABLE'})});
 app.activate();app.switchView('videoLogs');await settle();assert.match(view.textContent,/服务暂时不可用/);state='ok';button(view,'刷新').click();await settle();assert.match(view.textContent,/boss_reward/);
 state='auth';button(view,'刷新').click();await settle();assert(!app.isLoggedIn());assert(document.getElementById('login-screen').classList.contains('active'));assert.equal(view.textContent,'');
});
test('clearing a date invalidates an in-flight refresh without silently querying today',async t=>{
 const pending=[],calls=[];const {app,document,view}=await setup(t,async(_u,o)=>{calls.push(JSON.parse(o.body));return new Promise(r=>pending.push(r));});
 app.activate();app.switchView('videoLogs');const date=view.querySelector('#video-log-date');date.value='';date.dispatchEvent(event(document,'change'));assert.equal(calls.length,1);assert.match(view.textContent,/请选择查询日期/);
 pending[0]({ok:true,json:async()=>sample});await settle();assert.match(view.textContent,/请选择查询日期/);assert.equal(view.querySelector('.video-logs-table'),null);
});
test('rendering preserves source items and does not apply login new-registration green rows to videos',async t=>{
 const {app,view}=await setup(t);const before=JSON.stringify(sample);app.renderVideoLogs(sample,view);assert.equal(JSON.stringify(sample),before);assert.equal(view.querySelectorAll('.login-log-new-user').length,0);
});
