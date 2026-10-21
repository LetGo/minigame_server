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
 const app=runInNewContext(js.slice(0,js.indexOf("$('login-form').addEventListener"))+';({renderLoginLogs,switchView,showLogin,activate(){loggedIn=true;},setTab(value){tab=value;}})',{document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]},fetch,Date:Clock});
 return {app,view:get('view-container'),elements};
}
const record={registeredAt:'2026-10-17T16:01:02Z',sourceScene:1030,loginAt:'2026-10-19T16:30:00Z',openid:'same-openid',nickname:'<img src=x onerror=alert(1)>'};
const data={today:'2026-10-20',timezone:'Asia/Shanghai',generatedAt:'2026-10-19T16:31:00Z',total:2,offset:0,limit:50,hasMore:false,items:[record,{...record,loginAt:'2026-10-19T16:20:00Z',nickname:null,sourceScene:null,registeredAt:null}]};
const walk=e=>[e,...e.children.flatMap(walk)];
test('login logs include first-source raw scene and official description without extra deduplication',async()=>{
 const {app,view}=await setup();app.renderLoginLogs(data,view);
 const table=walk(view).find(e=>e.className.includes('login-logs-table'));assert(table);
 assert.deepEqual(table.children[0].children[0].children.map(e=>e.textContent),['登录时间（北京时间）','openid','昵称','首次来源场景','注册时间（北京时间）']);
 const rows=table.children[1].children;assert.equal(rows.length,2,'do not deduplicate records returned by source');assert.equal(rows[0].children.length,5);
 assert.equal(rows[0].children[0].textContent,new Date(record.loginAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));assert.equal(rows[0].children[1].textContent,record.openid);assert.equal(rows[0].children[2].textContent,record.nickname);assert.equal(rows[0].children[2].children.length,0,'nickname rendered only as text');assert.equal(rows[1].children[2].textContent,'—');assert.equal(rows[0].children[3].textContent,'1030 · 自动化测试下打开小程序');assert.equal(rows[1].children[3].textContent,'未上报');assert.equal(rows[0].children[4].textContent,'2026/10/18 00:01:02');assert.equal(rows[1].children[4].textContent,'—');assert.match(view.textContent,/2026-10-20/);assert.match(view.textContent,/共 2 条/);
});
test('login logs render empty results with disabled pagination',async()=>{
 const {app,view}=await setup();app.renderLoginLogs({...data,total:0,items:[]},view);assert.match(view.textContent,/暂无.*登录记录/);assert.equal(walk(view).find(e=>e.colSpan).colSpan,5);const buttons=walk(view).filter(e=>e.events.click);assert.equal(buttons.length,2);assert(buttons.every(e=>e.disabled));assert.doesNotMatch(view.textContent,/NaN|Infinity/);
});
test('left navigation opens login logs, requests today first page and states source limitation',async()=>{
 const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');assert.match(html,/data-view="loginLogs">登录日志/);
 const calls=[];const {app,view,elements}=await setup(async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return {ok:true,json:async()=>data};});app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));
 assert.equal(elements.get('page-title').textContent,'登录日志');assert.deepEqual(calls,[['/h5dashboard/api/login-logs',{offset:0,date:'2026-10-20'}]]);assert.match(view.textContent,/每天首次成功登录/);assert.match(view.textContent,/不.*逐次登录流水/);assert.match(view.textContent,/same-openid/);
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
test('login log request failures render safe error and explicit refresh can retry',async()=>{
 let count=0;const {app,view}=await setup(async()=>{count++;return {ok:false,status:503,json:async()=>({message:'DASHBOARD_UNAVAILABLE'})};});app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));assert.match(view.textContent,/服务暂时不可用/);const refresh=walk(view).find(e=>e.textContent==='刷新'&&e.events.click);assert(refresh);refresh.click();await new Promise(r=>setImmediate(r));assert.equal(count,2);
});
