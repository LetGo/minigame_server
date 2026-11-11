import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element{children=[];className='';value='';append(...items){this.children.push(...items);}replaceChildren(...items){this.children=[...items];}set textContent(value){this.value=String(value);this.children=[];}get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}}
test('14-day trend renders per-day reported rewarded videos with zero and unavailable fallback',async()=>{
 const script=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),view=new Element();
 const render=runInNewContext(script.slice(0,script.indexOf("$('login-form').addEventListener"))+';renderOverview',{document:{getElementById:()=>view,createElement:()=>new Element()}});
 const data={today:'2026-10-20',coverageStart:'2026-10-17',metrics:{dau:2,newUsers:1,invitedNewUsers:0,totalUsers:8,todayRewardedVideos:12,d1:{cohortSize:2,returned:1,rate:.5}},history:[
  {date:'2026-10-18',rewardedVideos:0},
  {date:'2026-10-20',rewardedVideos:12},
  {date:'2026-10-19',rewardedVideos:7},
  {date:'2026-10-17',rewardedVideos:null},
  {date:'2026-10-16'}
 ].map(r=>({newUsers:1,invitedNewUsers:0,dau:1,cohortSize:1,returned:0,d1Rate:0,...r}))};
 render(data);
 const table=view.children.find(e=>e.className==='history-table-container').children[0];
 assert.deepEqual(table.children[0].children[0].children.map(c=>c.textContent),['北京时间日期','新注册','其中邀请注册','登录活跃','次日留存','次日回访 / 当日新增','激励视频次数','注册用户视频数']);
 const rows=table.children[1].children.map(r=>r.children.map(c=>c.textContent));
 assert.deepEqual(rows.map(r=>r[6]),['12（人均 12.00 次）','7（人均 7.00 次）','0（人均 0.00 次）','—（人均 — 次）','—（人均 — 次）']);
 assert.equal(rows[0][0],'2026-10-20（截至现在）');assert.equal(rows[0][4],'待次日统计');
 assert.equal(data.history[0].date,'2026-10-18','response order must not change');
 assert.match(view.textContent,/激励视频次数按北京时间.*客户端上报.*事件去重/);
 assert.match(view.textContent,/无上报记录.*0.*不代表.*未观看/);
 assert.doesNotMatch(view.textContent,/NaN|Infinity/);
});
