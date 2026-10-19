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
async function setup(fetch=async()=>{throw Error('unexpected fetch');}){
 const js=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),elements=new Map();
 const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const app=runInNewContext(js.slice(0,js.indexOf("$('login-form').addEventListener"))+';({renderLoginLogs,switchView,showLogin,activate(){loggedIn=true;},setTab(value){tab=value;}})',{document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]},fetch});
 return {app,view:get('view-container'),elements};
}
const record={loginAt:'2026-10-19T16:30:00Z',openid:'same-openid',nickname:'<img src=x onerror=alert(1)>'};
const data={today:'2026-10-20',timezone:'Asia/Shanghai',generatedAt:'2026-10-19T16:31:00Z',total:2,offset:0,limit:50,hasMore:false,items:[record,{...record,loginAt:'2026-10-19T16:20:00Z',nickname:null}]};
const walk=e=>[e,...e.children.flatMap(walk)];
test('login logs render only time, openid and nickname without extra deduplication',async()=>{
 const {app,view}=await setup();app.renderLoginLogs(data,view);
 const table=walk(view).find(e=>e.className.includes('login-logs-table'));assert(table);
 assert.deepEqual(table.children[0].children[0].children.map(e=>e.textContent),['登录时间（北京时间）','openid','昵称']);
 const rows=table.children[1].children;assert.equal(rows.length,2,'do not deduplicate records returned by source');assert.equal(rows[0].children.length,3);
 assert.equal(rows[0].children[0].textContent,new Date(record.loginAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));assert.equal(rows[0].children[1].textContent,record.openid);assert.equal(rows[0].children[2].textContent,record.nickname);assert.equal(rows[0].children[2].children.length,0,'nickname rendered only as text');assert.equal(rows[1].children[2].textContent,'—');assert.match(view.textContent,/2026-10-20/);assert.match(view.textContent,/共 2 条/);
});
test('login logs render empty results with disabled pagination',async()=>{
 const {app,view}=await setup();app.renderLoginLogs({...data,total:0,items:[]},view);assert.match(view.textContent,/暂无.*登录记录/);const buttons=walk(view).filter(e=>e.events.click);assert.equal(buttons.length,2);assert(buttons.every(e=>e.disabled));assert.doesNotMatch(view.textContent,/NaN|Infinity/);
});
test('left navigation opens login logs, requests today first page and states source limitation',async()=>{
 const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');assert.match(html,/data-view="loginLogs">登录日志/);
 const calls=[];const {app,view,elements}=await setup(async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return {ok:true,json:async()=>data};});app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));
 assert.equal(elements.get('page-title').textContent,'登录日志');assert.deepEqual(calls,[['/h5dashboard/api/login-logs',{offset:0}]]);assert.match(view.textContent,/每天首次成功登录/);assert.match(view.textContent,/不.*逐次登录流水/);assert.match(view.textContent,/same-openid/);
});
test('pagination and refresh use protected POST and late responses cannot overwrite other tabs',async()=>{
 let resolve;const calls=[];const {app,view}=await setup(async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return new Promise(r=>{resolve=r;});});app.activate();app.setTab('loginLogs');app.renderLoginLogs({...data,total:120,offset:50,hasMore:true},view);
 const buttons=walk(view).filter(e=>e.events.click);assert.equal(buttons.length,2);assert(buttons.every(e=>!e.disabled));buttons[1].click();assert.deepEqual(calls,[['/h5dashboard/api/login-logs',{offset:100}]]);app.switchView('overview');const content=view.textContent;resolve({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));assert.equal(view.textContent,content,'stale request cannot replace overview');
});
test('a newer refresh wins over an older response, and logout discards pending rows',async()=>{
 const pending=[];const {app,view}=await setup(async()=>new Promise(resolve=>pending.push(resolve)));app.activate();app.switchView('loginLogs');
 const refresh=walk(view).find(e=>e.textContent==='刷新'&&e.events.click);refresh.click();assert.equal(pending.length,2);
 pending[1]({ok:true,json:async()=>({...data,items:[{...record,openid:'newest-result'}]})});await new Promise(r=>setImmediate(r));assert.match(view.textContent,/newest-result/);
 pending[0]({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));assert.match(view.textContent,/newest-result/);assert.doesNotMatch(view.textContent,/same-openid/);
 refresh.click();app.showLogin();pending[2]({ok:true,json:async()=>data});await new Promise(r=>setImmediate(r));assert.equal(view.textContent,'');
});
test('login log request failures render safe error and explicit refresh can retry',async()=>{
 let count=0;const {app,view}=await setup(async()=>{count++;return {ok:false,status:503,json:async()=>({message:'DASHBOARD_UNAVAILABLE'})};});app.activate();app.switchView('loginLogs');await new Promise(r=>setImmediate(r));assert.match(view.textContent,/服务暂时不可用/);const refresh=walk(view).find(e=>e.textContent==='刷新'&&e.events.click);assert(refresh);refresh.click();await new Promise(r=>setImmediate(r));assert.equal(count,2);
});
