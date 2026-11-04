import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element {
 children=[];value='';events={};className='';dataset={};disabled=false;
 classList={add(){},remove(){},toggle(){}};
 append(...x){this.children.push(...x);} replaceChildren(...x){this.children=[...x];this.value='';}
 set textContent(x){this.value=String(x);this.children=[];} get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}
 addEventListener(k,f){this.events[k]=f;} click(){return this.events.click?.();} reset(){}
}
const walk=e=>[e,...e.children.flatMap(walk)],flush=()=>new Promise(r=>setImmediate(r));
async function setup(fetch=async()=>{throw Error('unexpected fetch');}){
 const source=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const app=runInNewContext(source.slice(0,source.indexOf("$('login-form').addEventListener"))+';({switchView,showLogin,activate(){loggedIn=true;}})',{document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]},fetch,Date});
 return {app,view:get('view-container'),elements};
}
const data={today:'2026-10-22',date:'2026-10-22',timezone:'Asia/Shanghai',generatedAt:'2026-10-22T13:05:00Z',limit:20,items:[{rank:1,userId:'a',openid:'openid-first',nickname:'<img src=x onerror=alert(1)>',dailyCount:98,totalCount:673},{rank:2,userId:'b',openid:'openid-second',nickname:null,dailyCount:7,totalCount:12}]};
const response=value=>({ok:true,json:async()=>value});
test('newer date results beat older responses and clearing a pending date suppresses stale rows',async()=>{
 const pending=[],calls=[];const {app,view}=await setup(async(_url,options)=>{calls.push(JSON.parse(options.body));return new Promise(resolve=>pending.push(resolve));});app.activate();app.switchView('videoRanking');const picker=walk(view).find(e=>e.type==='date');picker.value='2026-10-18';picker.events.change();assert.equal(pending.length,2);
 pending[1](response({...data,date:'2026-10-18',items:[{...data.items[0],openid:'historical-newer'}]}));await flush();pending[0](response(data));await flush();assert.match(view.textContent,/historical-newer/);assert.doesNotMatch(view.textContent,/openid-first/);assert.equal(picker.value,'2026-10-18');
 walk(view).find(e=>e.textContent==='刷新').click();picker.value='';picker.events.change();assert.match(view.textContent,/请选择查询日期/);pending[2](response(data));await flush();assert.match(view.textContent,/请选择查询日期/);
});
test('pending video rankings cannot overwrite another tab or reappear after logout',async()=>{
 let done;const {app,view}=await setup(async()=>new Promise(resolve=>done=resolve));app.activate();app.switchView('videoRanking');app.switchView('player');const text=view.textContent;done(response(data));await flush();assert.equal(view.textContent,text);assert.doesNotMatch(view.textContent,/openid-first/);
 app.switchView('videoRanking');app.showLogin();done(response(data));await flush();assert.equal(view.textContent,'');
});
test('storage failure is not a false empty ranking, refresh retries, and expired sessions clear private rows',async()=>{
 let count=0;const {app,view}=await setup(async()=>{count++;return count<3?{ok:false,status:503,json:async()=>({message:'DASHBOARD_UNAVAILABLE'})}:{ok:false,status:401,json:async()=>({message:'DASHBOARD_LOGIN_REQUIRED'})};});app.activate();app.switchView('videoRanking');await flush();assert.match(view.textContent,/服务暂时不可用/);assert.doesNotMatch(view.textContent,/暂无已上报/);
 const button=walk(view).find(e=>e.textContent==='刷新');await button.click();assert.equal(count,2);await button.click();assert.equal(view.textContent,'');
});
test('date changes and refresh keep the selected day, today resets to server day and empty results are explicit',async()=>{
 const calls=[];const {app,view}=await setup(async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);return response({...data,date:body.date??data.today,items:[]});});app.activate();app.switchView('videoRanking');await flush();
 const picker=walk(view).find(e=>e.type==='date');assert(picker.events.change,'date picker can query another day');picker.value='2026-10-18';await picker.events.change();assert.deepEqual(calls.at(-1),{date:'2026-10-18'});assert.match(view.textContent,/2026-10-18/);assert.match(view.textContent,/所选日期暂无.*视频/);assert.equal(walk(view).find(e=>e.colSpan).colSpan,5);
 const refresh=walk(view).find(e=>e.textContent==='刷新'&&e.events.click);assert(refresh);await refresh.click();assert.deepEqual(calls.at(-1),{date:'2026-10-18'});
 const today=walk(view).find(e=>e.textContent==='今天'&&e.events.click);assert(today);await today.click();assert.deepEqual(calls.at(-1),{});assert.equal(picker.value,data.today);
 picker.value='';const count=calls.length;await picker.events.change();assert.equal(calls.length,count);assert.match(view.textContent,/请选择查询日期/);
});
test('video ranking sidebar loads server-selected Beijing today through authenticated POST and renders all requested fields safely',async()=>{
 const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');assert.match(html,/data-view="videoRanking">视频排行/);
 const calls=[];const {app,view,elements}=await setup(async(url,options)=>{calls.push([url,options]);return response(data);});app.activate();app.switchView('videoRanking');await flush();
 assert.equal(elements.get('page-title').textContent,'视频排行');assert.equal(calls.length,1);assert.equal(calls[0][0],'/h5dashboard/api/video-ranking');assert.deepEqual(JSON.parse(calls[0][1].body),{});assert.equal(calls[0][1].method,'POST');assert.equal(calls[0][1].credentials,'same-origin');assert.equal(calls[0][1].cache,'no-store');
 assert.equal(walk(view).find(e=>e.type==='date').value,data.date,'date must come from server, not client clock');
 const table=walk(view).find(e=>e.className.includes('video-ranking-table'));assert(table);assert.deepEqual(table.children[0].children[0].children.map(e=>e.textContent),['排名','昵称','openid','当日激励视频次数','历史总次数']);
 assert.deepEqual(table.children[1].children.map(r=>r.children.map(e=>e.textContent)),[['1',data.items[0].nickname,'openid-first','98','673'],['2','—','openid-second','7','12']]);assert.equal(table.children[1].children[0].children[1].children.length,0,'nickname is inert text');assert.match(view.textContent,/前 20/);assert.match(view.textContent,/北京时间/);assert.match(view.textContent,/按事件去重/);assert.match(view.textContent,/不代表广告平台/);assert.match(view.textContent,/2026\/10\/22 21:05:00/);
});
