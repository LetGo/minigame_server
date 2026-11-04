import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element {
 children=[];value='';events={};className='';dataset={};attrs={};disabled=false;
 classList={add(){},remove(){},toggle(){}};
 append(...x){this.children.push(...x);} replaceChildren(...x){this.children=[...x];this.value='';}
 set textContent(x){this.value=String(x);this.children=[];} get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}
 setAttribute(k,v){this.attrs[k]=String(v);} addEventListener(k,f){this.events[k]=f;} reset(){}
}
const walk=e=>[e,...e.children.flatMap(walk)];
const flush=()=>new Promise(r=>setImmediate(r));
const response=value=>({ok:true,json:async()=>value});
const fixture={today:'2026-10-30',cohortDate:'2026-10-29',timezone:'Asia/Shanghai',generatedAt:'2026-10-30T03:00:00Z',loginCoverage:true,
 registrations:{total:4,items:[{scene:1007,value:2},{scene:9999,value:1},{scene:null,value:1}]},
 rewardedVideos:{total:6,items:[{scene:1007,value:6}]},returnedUsers:{total:2,items:[{scene:1007,value:1},{scene:null,value:1}]}};
async function setup(fetch=async()=>{throw Error('unexpected fetch');}){
 const source=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),elements=new Map();
 const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const app=runInNewContext(source.slice(0,source.indexOf("$('login-form').addEventListener"))+';({renderYesterdayAnalysis:typeof renderYesterdayAnalysis===\'function\'?renderYesterdayAnalysis:null,switchView,showLogin,refresh,start,activate(){loggedIn=true;}})',{
 document:{getElementById:get,createElement:()=>new Element(),createElementNS:(_ns,tag)=>Object.assign(new Element(),{tagName:tag}),querySelectorAll:()=>[],hidden:false},fetch,Date});
 return {app,view:get('view-container')};
}
test('analysis tab loads once, polls fresh server dates and rejects late results after navigation/logout',async()=>{
 const calls=[],pending=[];const {app,view}=await setup(async(url,options)=>{calls.push([url,options]);return new Promise(r=>pending.push(r));});
 app.activate();app.switchView('yesterdayAnalysis');assert.equal(calls.length,1);assert.equal(calls[0][0],'/h5dashboard/api/yesterday-analysis');assert.deepEqual(JSON.parse(calls[0][1].body),{});
 const duplicate=app.refresh();assert.equal(calls.length,1,'entry and automatic refresh share an in-flight request');pending.shift()(response(fixture));await duplicate;await flush();assert.match(view.textContent,/2026-10-29/);
 const update=app.refresh();assert.equal(calls.length,2);pending.shift()(response({...fixture,today:'2026-10-31',cohortDate:'2026-10-30'}));await update;assert.match(view.textContent,/北京时间 2026-10-30/);
 const stale=app.refresh();app.switchView('player');const playerText=view.textContent;pending.shift()(response(fixture));await stale;assert.equal(view.textContent,playerText);
 app.switchView('yesterdayAnalysis');assert.equal(calls.length,4);app.showLogin();pending.shift()(response(fixture));await flush();assert.equal(view.textContent,'');
 const html=await readFile(new URL('../dashboard/public/index.html',import.meta.url),'utf8');assert.match(html,/data-view="yesterdayAnalysis">昨日用户分析/);
});
test('empty and uncovered pies remain distinct and scene text is never parsed as markup',async()=>{
 const {app,view}=await setup();app.renderYesterdayAnalysis({...fixture,registrations:{total:0,items:[]},rewardedVideos:{total:0,items:[]},returnedUsers:{total:null,items:null}},view);
 assert.match(view.textContent,/昨日暂无已完成首次登录/);assert.match(view.textContent,/暂无该队列已上报的视频/);assert.match(view.textContent,/未覆盖/);assert.equal(walk(view).filter(e=>e.tagName==='path'||e.tagName==='circle').length,0);
 app.renderYesterdayAnalysis({...fixture,registrations:{total:1,items:[{scene:'<script>alert(1)</script>',value:1}]}},view);
 const label=walk(view).find(e=>e.className==='scene-legend-label'&&e.textContent.startsWith('<script>'));assert(label);assert.equal(label.children.length,0);
 const css=await readFile(new URL('../dashboard/public/style.css',import.meta.url),'utf8');assert.match(css,/\.scene-charts-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,/);assert.match(css,/\.scene-legend-label\s*\{[^}]*overflow-wrap:\s*anywhere/);
});
test('analysis errors clear prior figures and manual refresh retries without showing false zeros',async()=>{
 let n=0;const {app,view}=await setup(async()=>++n===1?response(fixture):n===2?{ok:false,status:503,json:async()=>({message:'DASHBOARD_UNAVAILABLE'})}:response(fixture));app.activate();app.switchView('yesterdayAnalysis');await flush();assert.match(view.textContent,/2026-10-29/);
 await app.refresh();assert.match(view.textContent,/服务暂时不可用/);assert.doesNotMatch(view.textContent,/合计/);await walk(view).find(e=>e.textContent==='刷新').events.click();assert.match(view.textContent,/2026-10-29/);
});
test('re-entering while an old analysis is pending starts a fresh query and only the new response wins',async()=>{
 const pending=[];const {app,view}=await setup(async()=>new Promise(r=>pending.push(r)));app.activate();app.switchView('yesterdayAnalysis');app.switchView('player');app.switchView('yesterdayAnalysis');assert.equal(pending.length,2);
 pending[1](response({...fixture,cohortDate:'2026-11-01'}));await flush();pending[0](response(fixture));await flush();assert.match(view.textContent,/2026-11-01/);assert.doesNotMatch(view.textContent,/2026-10-29/);
});
test('expired analysis sessions remove all private charts instead of preserving stale data',async()=>{
 let n=0;const {app,view}=await setup(async()=>++n===1?response(fixture):{ok:false,status:401,json:async()=>({message:'DASHBOARD_LOGIN_REQUIRED'})});app.activate();app.switchView('yesterdayAnalysis');await flush();assert.match(view.textContent,/合计/);await app.refresh();assert.equal(view.textContent,'');
});
test('three real SVG pies show registration-scene counts, ratios and official descriptions with consistent colors',async()=>{
 const {app,view}=await setup();assert.equal(typeof app.renderYesterdayAnalysis,'function','new analysis renderer exists');
 app.renderYesterdayAnalysis(fixture,view);
 const charts=walk(view).filter(e=>e.className==='scene-chart');assert.equal(charts.length,3);
 assert.match(view.textContent,/昨日注册 scene/);assert.match(view.textContent,/昨日注册用户昨日激励视频次数/);assert.match(view.textContent,/昨日注册今日实时登录用户/);
 const svgs=walk(view).filter(e=>e.tagName==='svg'&&e.attrs.viewBox==='0 0 240 240');assert.equal(svgs.length,3);assert(svgs.every(e=>e.attrs.role==='img'&&e.attrs['aria-label']));
 assert.match(charts[0].textContent,/1007 · 单人聊天会话/);assert.match(charts[0].textContent,/9999 · 官方当前文档未收录/);assert.match(charts[0].textContent,/未上报/);assert.match(charts[0].textContent,/50.00%/);
 assert.match(charts[1].textContent,/100.00%/);assert.equal(walk(charts[1]).filter(e=>e.tagName==='circle').length,1,'single scene renders a full circle');
 const firstColor=walk(charts[0]).find(e=>e.tagName==='path').attrs.fill;
 assert.equal(walk(charts[1]).find(e=>e.tagName==='circle').attrs.fill,firstColor,'same scene same color across pies');
 assert.match(view.textContent,/北京时间 2026-10-29/);assert.match(view.textContent,/2026-10-30/);assert.match(view.textContent,/每 30 秒/);
 assert.match(view.textContent,/首次/);assert.match(view.textContent,/不代表广告平台/);
});
