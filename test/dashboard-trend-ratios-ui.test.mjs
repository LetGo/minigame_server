import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element {
 children=[];className='';value='';
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 set textContent(value){this.value=String(value);this.children=[];}
 get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}
}
async function harness(){
 const js=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),view=new Element();
 const render=runInNewContext(js.slice(0,js.indexOf("$('login-form').addEventListener"))+';renderOverview',{document:{getElementById:()=>view,createElement:()=>new Element()}});
 return {view,render,rows:()=>view.children.find(e=>e.className==='history-table-container').children[0].children[1].children.map(r=>r.children.map(c=>c.textContent))};
}
function overview(history){return {today:'2026-10-20',coverageStart:'2026-10-17',metrics:{dau:999,newUsers:999,invitedNewUsers:1,totalUsers:999,todayRewardedVideos:999,d1:{cohortSize:0,returned:null,rate:null}},history:history.map((r,i)=>({date:`2026-10-${String(20-i).padStart(2,'0')}`,newUsers:3,invitedNewUsers:2,dau:4,cohortSize:3,returned:0,d1Rate:0,...r}))};}
test('trend videos append two-decimal average using each row daily active users, not today or viewers',async()=>{
 const h=await harness(),data=overview([{rewardedVideos:12,dau:4},{rewardedVideos:10,dau:3},{rewardedVideos:0,dau:4},{rewardedVideos:0,dau:0},{rewardedVideos:12,dau:0},{rewardedVideos:12,dau:null},{rewardedVideos:null,dau:4},{rewardedVideos:undefined,dau:4},{rewardedVideos:12,dau:undefined}]);
 const original=JSON.stringify(data);h.render(data);
 assert.deepEqual(h.rows().map(r=>r[6]),['12（人均 3.00 次）','10（人均 3.33 次）','0（人均 0.00 次）','0（人均 — 次）','12（人均 — 次）','12（人均 — 次）','—（人均 — 次）','—（人均 — 次）','12（人均 — 次）']);
 assert.equal(JSON.stringify(data),original,'do not mutate API data');
 assert.equal(h.rows()[0].length,7,'no extra trend columns');
 assert.equal(h.view.children[0].children.length,6,'keep six overview cards');
 assert.doesNotMatch(h.view.textContent,/NaN|Infinity/);
 assert.match(h.view.textContent,/人均次数.*当日激励视频次数.*当日登录活跃/);
});
test('trend invited registrations append share of that row new users, with zero and unknown preserved',async()=>{
 const h=await harness();h.render(overview([{newUsers:3,invitedNewUsers:2},{newUsers:4,invitedNewUsers:1},{newUsers:4,invitedNewUsers:0},{newUsers:0,invitedNewUsers:0},{newUsers:null,invitedNewUsers:1},{newUsers:undefined,invitedNewUsers:1},{newUsers:4,invitedNewUsers:null},{newUsers:4,invitedNewUsers:undefined}]));
 assert.deepEqual(h.rows().map(r=>r[2]),['2（66.67%）','1（25.00%）','0（0.00%）','0（—）','1（—）','1（—）','—（—）','—（—）']);
 assert.equal(h.rows()[0][0],'2026-10-20（截至现在）');
 assert.equal(h.rows()[1][0],'2026-10-19');
 assert.match(h.view.textContent,/邀请注册占比.*当日邀请注册人数.*当日新注册人数/);
 assert.doesNotMatch(h.view.textContent,/NaN|Infinity/);
});
