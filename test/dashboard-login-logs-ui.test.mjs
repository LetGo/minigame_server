import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element {
 children=[];value='';events={};disabled=false;className='';dataset={};
 classList={add(){},remove(){},toggle(){}};
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];this.value='';}
 set textContent(value){this.value=String(value);this.children=[];}
 get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}
 addEventListener(name,fn){this.events[name]=fn;}
 click(){return this.events.click?.();}
 reset(){}
}
async function setup(fetch=async()=>{throw Error('unexpected fetch');},now='2026-10-19T16:31:00Z'){
 const js=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),elements=new Map();
 const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}}
 const app=runInNewContext(js.slice(0,js.indexOf("$('login-form').addEventListener"))+';({renderLoginLogs,formatScene,switchView,showLogin,activate(){loggedIn=true;},setTab(value){tab=value;}})',{document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]},fetch,Date:Clock});
 return {app,view:get('view-container'),elements};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function setupFullScript(t){
 const {JSDOM}=await import('jsdom');
 const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');
 const source=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8');
 const dom=new JSDOM(html,{runScripts:'outside-only'});t.after(()=>dom.window.close());
 class Clock extends Date{constructor(...args){super(...(args.length?args:['2026-10-19T16:31:00Z']));}}
 const calls=[],pending=[];
 dom.window.Date=Clock;
 dom.window.fetch=async(url,options)=>{
  if(url==='/h5dashboard/api/me')return {ok:true,json:async()=>({})};
  assert.equal(url,'/h5dashboard/api/login-logs','all requests stay in the offline fetch stub');
  assert.equal(options.method,'POST');calls.push(JSON.parse(options.body));
  return new Promise(resolve=>pending.push(resolve));
 };
 dom.window.eval(source);await settle();
 const document=dom.window.document;
 assert(document.getElementById('dashboard-screen').classList.contains('active'));
 document.querySelector('[data-view="loginLogs"]').click();
 assert.deepEqual(calls,[{offset:0,date:'2026-10-20'}]);
 return {document,view:document.getElementById('view-container'),calls,pending};
}
const domEvent=(document,type)=>new document.defaultView.Event(type,{bubbles:true,cancelable:true});
const loginLogResponse=(status,result=data)=>status===200?{ok:true,json:async()=>result}:{ok:false,status,json:async()=>({message:'DASHBOARD_LOGIN_REQUIRED'})};
function assertDashboardActive(document){
 assert(document.getElementById('dashboard-screen').classList.contains('active'),'stale response must not log out the current dashboard');
 assert(!document.getElementById('login-screen').classList.contains('active'));
}
for(const status of [200,401]){
 test(`openid edits discard late ${status} login logs in the complete script`,async t=>{
  const {document,view,calls,pending}=await setupFullScript(t);
  const input=view.querySelector('#login-log-openid');input.value='oNewPlayer';input.dispatchEvent(domEvent(document,'input'));
  const edited=view.textContent;
  assert.match(edited,/筛选条件已修改/);assert.equal(calls.length,1,'editing alone must not query');
  pending[0](loginLogResponse(status));await settle();
  assertDashboardActive(document);assert.equal(view.textContent,edited);assert.equal(input.value,'oNewPlayer');
  assert.equal(view.querySelector('.login-logs-table'),null);assert.doesNotMatch(view.textContent,/same-openid|登录已过期/);
  view.querySelector('form').dispatchEvent(domEvent(document,'submit'));
  assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-20',openid:'oNewPlayer'});assert.equal(calls.length,2);
  pending[1](loginLogResponse(200,{...data,openid:'oNewPlayer',items:[{...record,openid:'oNewPlayer'}],total:1}));await settle();
  assertDashboardActive(document);assert.match(view.textContent,/共 1 条.*玩家 oNewPlayer/);assert(view.querySelector('.login-logs-table'));
 });
 test(`a newer login-log query survives a late ${status} response in the complete script`,async t=>{
  const {document,view,calls,pending}=await setupFullScript(t);
  const input=view.querySelector('#login-log-openid');input.value='oNewest';input.dispatchEvent(domEvent(document,'input'));
  view.querySelector('form').dispatchEvent(domEvent(document,'submit'));assert.equal(calls.length,2);
  pending[1](loginLogResponse(200,{...data,openid:'oNewest',items:[{...record,openid:'oNewest'}],total:1}));await settle();
  assert.match(view.textContent,/共 1 条.*玩家 oNewest/);const newest=view.textContent;
  pending[0](loginLogResponse(status));await settle();
  assertDashboardActive(document);assert.equal(view.textContent,newest);assert.equal(view.querySelectorAll('.login-logs-table tbody tr').length,1);
 });
 test(`switching tabs discards late ${status} login logs in the complete script`,async t=>{
  const {document,view,calls,pending}=await setupFullScript(t);
  document.querySelector('[data-view="player"]').click();const player=view.textContent;assert(view.querySelector('#player-form'));
  pending[0](loginLogResponse(status));await settle();
  assertDashboardActive(document);assert.equal(view.textContent,player);assert(view.querySelector('#player-form'));assert.equal(calls.length,1);
 });
}
test('a current login-log 401 returns to login in the complete script',async t=>{
 const {document,view,pending}=await setupFullScript(t);
 pending[0](loginLogResponse(401));await settle();
 assert(document.getElementById('login-screen').classList.contains('active'));
 assert(!document.getElementById('dashboard-screen').classList.contains('active'));assert.equal(view.textContent,'');
});
const record={registeredAt:'2026-10-17T16:01:02Z',sourceScene:1030,loginScene:1001,clientVersion:'2.0.7',loginAt:'2026-10-19T16:30:00Z',openid:'same-openid',nickname:'<img src=x onerror=alert(1)>'};
const data={today:'2026-10-20',timezone:'Asia/Shanghai',generatedAt:'2026-10-19T16:31:00Z',total:2,offset:0,limit:50,hasMore:false,items:[record,{...record,loginAt:'2026-10-19T16:20:00Z',nickname:null,sourceScene:null,loginScene:null,clientVersion:null,registeredAt:null}]};
const walk=e=>[e,...e.children.flatMap(walk)];
test('login logs show one row per successful login with its own scene and the separate first-source scene',async()=>{
 const {app,view}=await setup();app.renderLoginLogs(data,view);
 const table=walk(view).find(e=>e.className.includes('login-logs-table'));assert(table);
 assert.deepEqual(table.children[0].children[0].children.map(e=>e.textContent),['登录时间（北京时间）','openid','昵称','客户端版本','本次登录场景','首次来源场景','注册时间（北京时间）']);
 const rows=table.children[1].children;assert.equal(rows.length,2,'two returned login records render as two rows');assert.equal(rows[0].children.length,7);

 assert.equal(rows[0].children[0].textContent,new Date(record.loginAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));assert.equal(rows[0].children[1].textContent,record.openid);assert.equal(rows[0].children[2].textContent,record.nickname);assert.equal(rows[0].children[2].children.length,0,'nickname rendered only as text');assert.equal(rows[1].children[2].textContent,'—');assert.equal(rows[0].children[3].textContent,'2.0.7');assert.equal(rows[1].children[3].textContent,'—');
 assert.equal(rows[0].children[4].textContent,'1001','per-login scene displays only its raw ID');assert.equal(rows[0].children[4].title,app.formatScene(1001),'official full description appears only in tooltip');
 assert.equal(rows[1].children[4].textContent,'—','a null or legacy login scene renders a dash, not a fabricated value');
 assert.equal(rows[0].children[5].textContent,'1030');assert.equal(rows[0].children[5].title,'1030 · 自动化测试下打开小程序');assert.equal(rows[1].children[5].textContent,'未上报','first-source column keeps its existing unreported wording');
 assert.equal(rows[0].children[6].textContent,'2026/10/18 00:01:02');assert.equal(rows[1].children[6].textContent,'—');assert.match(view.textContent,/2026-10-20/);assert.match(view.textContent,/共 2 条/);
});
test('today registrants are green across the entire row using the server Beijing day, not query or browser date',async()=>{
 const {app,view}=await setup(undefined,'2026-10-21T12:00:00Z');
 const items=[{...record,registeredAt:'2026-10-19T16:00:00Z'},{...record,registeredAt:'2026-10-19T15:59:59.999Z'}];
 const response={...data,date:'2026-10-18',items},before=JSON.stringify(response);
 app.renderLoginLogs(response,view);
 const rows=walk(view).find(e=>e.className.includes('login-logs-table')).children[1].children;
 assert.equal(rows[0].className,'login-log-new-user','today registration marks its entire table row');
 assert.equal(rows[1].className,'','yesterday registration remains normal even if login occurred today');
 assert.equal(rows[0].children.length,7);assert.equal(JSON.stringify(response),before,'source records are unchanged');
});
test('new-user highlighting respects both Beijing midnight edges, missing dates and day rollover',async()=>{
 const {app,view}=await setup();
 const timestamps=['2026-10-19T16:00:00+00:00','2026-10-20T23:59:59.999+08:00','2026-10-19T15:59:59.999999Z','2026-10-20T16:00:00Z',null,undefined,'','not-a-date'];
 const items=timestamps.map(registeredAt=>({...record,registeredAt}));
 const rows=()=>walk(view).find(e=>e.className.includes('login-logs-table')).children[1].children;
 app.renderLoginLogs({...data,items},view);
 assert.deepEqual(rows().map(row=>row.className),['login-log-new-user','login-log-new-user','','','','','','']);
 app.renderLoginLogs({...data,today:'2026-10-21',items},view);
 assert.deepEqual(rows().map(row=>row.className),['','','','login-log-new-user','','','',''],'refresh after midnight recalculates highlighting');
 app.renderLoginLogs({...data,today:undefined,items},view);
 assert(rows().every(row=>row.className===''),'missing server today never guesses from login date');
});
test('login logs explain that green means registered today in Beijing',async()=>{
 const {app,view}=await setup(async()=>({ok:true,json:async()=>data}));app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));
 assert.match(view.textContent,/北京时间今天注册的玩家.*整行绿色/);
});
test('login logs render empty results with disabled pagination',async()=>{
 const {app,view}=await setup();app.renderLoginLogs({...data,total:0,items:[]},view);assert.match(view.textContent,/暂无.*登录记录/);assert.equal(walk(view).find(e=>e.colSpan).colSpan,7);const buttons=walk(view).filter(e=>e.events.click);assert.equal(buttons.length,2);assert(buttons.every(e=>e.disabled));assert.doesNotMatch(view.textContent,/NaN|Infinity/);
});
test('both login scene columns show only raw IDs and retain full safe descriptions in tooltips',async()=>{
 const {app,view}=await setup();
 for(const [sourceScene,loginScene] of [[1001,1030],[1030,1001],[null,null],[0,0],[1001,9999],[null,'not-a-number'],[1001,'a'.repeat(40)],[1001,'😀'.repeat(40)],[1001,'<img src=x onerror=alert(1)>']]){
  const item={...record,sourceScene,loginScene,clientVersion:'<img src=x onerror=alert(1)>'},before=JSON.stringify(item);
  app.renderLoginLogs({...data,items:[item],total:1},view);
  const row=walk(view).find(e=>e.className.includes('login-logs-table')).children[1].children[0];
  for(const [index,value]of [[4,loginScene],[5,sourceScene]]){
   const cell=row.children[index],fallback=index===4?'—':'未上报',full=value==null?fallback:app.formatScene(value);
   assert.equal(cell.textContent,value==null?fallback:String(value),'display preserves the raw ID without appending description or truncating it');
   assert.equal(cell.title,full);assert.equal(cell.children.length,0,'scene text only');
  }
  if(loginScene!=null&&String(loginScene).includes('<img'))assert.equal(row.children[4].textContent.startsWith('<img'),true,'markup-looking login scene stays inert text');
  if(sourceScene!=null&&String(sourceScene).includes('<img'))assert.equal(row.children[5].textContent.startsWith('<img'),true,'markup-looking source scene stays inert text');
  assert.equal(row.children[3].textContent,item.clientVersion);assert.equal(row.children[3].children.length,0,'version text only');assert.equal(JSON.stringify(item),before,'no source mutation');
 }
});
test('login logs explain per-login success rows, retained historical coverage and unchanged DAU',async()=>{
 const {app,view}=await setup(async()=>({ok:true,json:async()=>data}));app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));
 assert.match(view.textContent,/每次成功登录/);assert.match(view.textContent,/历史/);assert.match(view.textContent,/本次登录场景/);assert.match(view.textContent,/首次来源场景/);assert.match(view.textContent,/不影响.*(活跃|DAU)/);assert.doesNotMatch(view.textContent,/仅保留每个用户每天首次成功登录/);
 assert.match(view.textContent,/均仅显示场景 ID，悬停可查看完整描述/);assert.doesNotMatch(view.textContent,/最多显示 30 个字符/);
});
test('new-user row styles color every cell green in light and dark themes without coloring old users',async()=>{
 const {JSDOM}=await import('jsdom');
 const css=await readFile(new URL('../dashboard/public/style.css',import.meta.url),'utf8');
 const dom=new JSDOM('<!doctype html><html><head></head><body><table class="history-table login-logs-table"><tbody><tr class="login-log-new-user"><td>time</td><td>openid</td><td>name</td><td>version</td><td>scene</td><td>source</td><td>registered</td></tr><tr><td>old user</td></tr></tbody></table></body></html>');
 try{
  const {document}=dom.window,style=document.createElement('style');style.textContent=css;document.head.append(style);
  const cells=[...document.querySelectorAll('.login-log-new-user td')],old=document.querySelector('tr:not(.login-log-new-user) td');
  for(const cell of cells){assert.equal(dom.window.getComputedStyle(cell).color,'rgb(21, 128, 61)');assert.equal(dom.window.getComputedStyle(cell).backgroundColor,'rgba(22, 163, 74, 0.08)');}
  assert.notEqual(dom.window.getComputedStyle(old).color,'rgb(21, 128, 61)');
  document.body.className='dark';
  for(const cell of cells)assert.equal(dom.window.getComputedStyle(cell).color,'rgb(74, 222, 128)');
  assert.notEqual(dom.window.getComputedStyle(old).color,'rgb(74, 222, 128)');
 }finally{dom.window.close();}
});
test('login logs table reserves width for the extra scene column',async()=>{
 const css=await readFile(new URL('../dashboard/public/style.css',import.meta.url),'utf8');
 assert.match(css,/\.login-logs-table\s*\{\s*min-width:\s*720px;/);
});
test('left navigation opens login logs, requests today first page and states source limitation',async()=>{
 const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');assert.match(html,/data-view="loginLogs">登录日志/);
 const calls=[];const {app,view,elements}=await setup(async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return {ok:true,json:async()=>data};});app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));
 assert.equal(elements.get('page-title').textContent,'登录日志');assert.deepEqual(calls,[['/h5dashboard/api/login-logs',{offset:0,date:'2026-10-20'}]]);assert.match(view.textContent,/每次成功登录/);assert.match(view.textContent,/历史/);assert.match(view.textContent,/same-openid/);
});
test('pagination and refresh use protected POST and late responses cannot overwrite other tabs',async()=>{
 let resolve;const calls=[];const {app,view}=await setup(async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return new Promise(r=>{resolve=r;});});app.activate();app.setTab('loginLogs');app.renderLoginLogs({...data,total:120,offset:50,hasMore:true},view);
 const buttons=walk(view).filter(e=>e.events.click);assert.equal(buttons.length,2);assert(buttons.every(e=>!e.disabled));buttons[1].click();assert.deepEqual(calls,[['/h5dashboard/api/login-logs',{offset:100,date:'2026-10-20'}]]);app.switchView('overview');const content=view.textContent;resolve({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));assert.equal(view.textContent,content,'stale request cannot replace overview');
});
test('a newer refresh wins over an older response, and logout discards pending rows',async()=>{
 const pending=[];const {app,view}=await setup(async()=>new Promise(resolve=>pending.push(resolve)));app.activate();app.switchView('loginLogs');
 const refresh=walk(view).find(e=>e.textContent==='刷新'&&e.events.click);refresh.click();assert.equal(pending.length,2);
 pending[1]({ok:true,json:async()=>({...data,items:[{...record,openid:'newest-result'}]})});await new Promise(r=>setImmediate(r));assert.match(view.textContent,/newest-result/);
 pending[0]({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));assert.match(view.textContent,/newest-result/);assert.doesNotMatch(view.textContent,/same-openid/);
 refresh.click();app.showLogin();pending[2]({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));assert.equal(view.textContent,'');
});
test('date picker defaults to Beijing today and changing date resets pages while refresh and pages retain it',async()=>{
 const calls=[];const {app,view}=await setup(async(_url,options)=>{const input=JSON.parse(options.body);calls.push(input);return {ok:true,json:async()=>({...data,date:input.date,total:120,offset:input.offset,hasMore:input.offset<100})};});
 app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));
 const picker=walk(view).find(e=>e.type==='date');assert(picker,'login logs have a date picker');assert.equal(picker.value,'2026-10-20','UTC previous day is already today in Beijing');assert.equal(walk(view).find(e=>e.htmlFor===picker.id).textContent,'查询日期（北京时间）');
 walk(view).find(e=>e.textContent==='下一页').click();await new Promise(r=>setImmediate(r));assert.equal(calls.at(-1).offset,50);
 picker.value='2026-10-18';picker.events.change();await new Promise(r=>setImmediate(r));assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18'});assert.match(view.textContent,/北京时间 2026-10-18 · 共/);
 walk(view).find(e=>e.textContent==='下一页').click();await new Promise(r=>setImmediate(r));assert.deepEqual(calls.at(-1),{offset:50,date:'2026-10-18'});
 walk(view).find(e=>e.textContent==='上一页').click();await new Promise(r=>setImmediate(r));assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18'});
 walk(view).find(e=>e.textContent==='刷新').click();await new Promise(r=>setImmediate(r));assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18'});assert.equal(picker.value,'2026-10-18');
});
test('switching dates rejects late older results and clearing the date does not query today',async()=>{
 const pending=[],calls=[];const {app,view}=await setup(async(_url,options)=>{calls.push(JSON.parse(options.body));return new Promise(resolve=>pending.push(resolve));});app.activate();app.switchView('loginLogs');
 const picker=walk(view).find(e=>e.type==='date');picker.value='2026-10-18';picker.events.change();assert.equal(pending.length,2);
 pending[1]({ok:true,json:async()=>({...data,date:'2026-10-18',items:[{...record,openid:'historical-result'}]})});await new Promise(r=>setImmediate(r));
 pending[0]({ok:true,json:async()=>({...data,date:'2026-10-20'})});await new Promise(r=>setImmediate(r));assert.match(view.textContent,/historical-result/);assert.doesNotMatch(view.textContent,/same-openid/);
 walk(view).find(e=>e.textContent==='刷新').click();picker.value='';picker.events.change();assert.equal(calls.length,3);assert.match(view.textContent,/请选择查询日期/);
 pending[2]({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));assert.match(view.textContent,/请选择查询日期/);assert.doesNotMatch(view.textContent,/same-openid/);
});
test('openid filter queries exactly one player and persists across pages and dates until cleared',async()=>{
 const calls=[];const {app,view}=await setup(async(_url,options)=>{const input=JSON.parse(options.body);calls.push(input);return {ok:true,json:async()=>({...data,date:input.date,openid:input.openid??null,total:120,offset:input.offset,hasMore:input.offset<100})};});
 app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));
 const input=walk(view).find(e=>e.id==='login-log-openid');assert(input,'openid filter must be visible');assert.equal(input.maxLength,128);
 input.value='oPlayer_exact-1';input.events.input();
 walk(view).find(e=>e.textContent==='刷新').click();await new Promise(r=>setImmediate(r));
 assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-20',openid:'oPlayer_exact-1'});
 walk(view).find(e=>e.textContent==='下一页').click();await new Promise(r=>setImmediate(r));
 assert.deepEqual(calls.at(-1),{offset:50,date:'2026-10-20',openid:'oPlayer_exact-1'});
 const picker=walk(view).find(e=>e.type==='date');picker.value='2026-10-18';picker.events.change();await new Promise(r=>setImmediate(r));
 assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18',openid:'oPlayer_exact-1'});
 walk(view).find(e=>e.textContent==='清除玩家筛选').click();await new Promise(r=>setImmediate(r));
 assert.equal(input.value,'');assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-18'});
});
test('editing openid invalidates pending results; invalid input is local and submit queries exact text',async()=>{
 const pending=[],calls=[];const {app,view}=await setup(async(_url,options)=>{calls.push(JSON.parse(options.body));return new Promise(resolve=>pending.push(resolve));});
 app.activate();app.switchView('loginLogs');
 const input=walk(view).find(e=>e.id==='login-log-openid'),form=walk(view).find(e=>e.events.submit);
 input.value='invalid openid';input.events.input();
 pending[0]({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));
 assert.match(view.textContent,/筛选条件已修改/);assert.doesNotMatch(view.textContent,/same-openid/);
 let prevented=false;form.events.submit({preventDefault(){prevented=true;}});assert(prevented);assert.equal(calls.length,1);assert.match(view.textContent,/openid.*格式|完整.*openid/);
 input.value='oExact_1';input.events.input();form.events.submit({preventDefault(){}});
 assert.deepEqual(calls.at(-1),{offset:0,date:'2026-10-20',openid:'oExact_1'});
 input.value='oExact_2';input.events.input();form.events.submit({preventDefault(){}});
 pending[2]({ok:true,json:async()=>({...data,openid:'oExact_2',items:[],total:0})});await new Promise(r=>setImmediate(r));
 assert.match(view.textContent,/玩家 oExact_2/);assert.match(view.textContent,/该玩家暂无成功登录记录/);
 pending[1]({ok:true,json:async()=>({...data,openid:'oExact_1'})});await new Promise(r=>setImmediate(r));
 assert.match(view.textContent,/玩家 oExact_2/);assert.doesNotMatch(view.textContent,/same-openid/);
});
test('login log request failures render safe error and explicit refresh can retry',async()=>{
 let count=0;const {app,view}=await setup(async()=>{count++;return {ok:false,status:503,json:async()=>({message:'DASHBOARD_UNAVAILABLE'})};});app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));assert.match(view.textContent,/服务暂时不可用/);const refresh=walk(view).find(e=>e.textContent==='刷新'&&e.events.click);assert(refresh);refresh.click();await new Promise(r=>setImmediate(r));assert.equal(count,2);
});
