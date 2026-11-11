import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
async function harness(history){
 const script=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8');
 const dom=new JSDOM('<div id="view-container"></div>');
 const render=runInNewContext(script.slice(0,script.indexOf("$('login-form').addEventListener"))+';renderOverview',{document:dom.window.document});
 const data={today:'2026-11-07',coverageStart:'2026-10-01',metrics:{dau:100,newUsers:999,totalUsers:999,todayRewardedVideos:999,d1:{cohortSize:0,returned:null,rate:null}},history:history.map((row,i)=>({date:`2026-11-${String(7-i).padStart(2,'0')}`,newUsers:3,dau:10,rewardedVideos:100,cohortSize:3,returned:0,d1Rate:0,...row}))};
 const original=JSON.stringify(data);render(data);assert.equal(JSON.stringify(data),original);
 return {dom,doc:dom.window.document};
}
test('overview adds registration-cohort video column with each day registrations as denominator including nonviewers',async()=>{
 const {dom,doc}=await harness([{registeredUserVideos:10,newUsers:3},{registeredUserVideos:0,newUsers:4},{registeredUserVideos:0,newUsers:0},{registeredUserVideos:5,newUsers:0},{registeredUserVideos:5,newUsers:null},{registeredUserVideos:null,newUsers:4},{newUsers:4}]);
 try{
  const titles=[...doc.querySelectorAll('.history-table th')].map(x=>x.textContent);
  assert.deepEqual(titles,['北京时间日期','新注册','其中邀请注册','登录活跃','次日留存','次日回访 / 当日新增','激励视频次数','注册用户视频数']);
  const rows=[...doc.querySelectorAll('.history-table tbody tr')];
  assert.deepEqual(rows.map(r=>r.children[7].textContent),['10（人均 3.33 次）','0（人均 0.00 次）','0（人均 — 次）','5（人均 — 次）','5（人均 — 次）','—（人均 — 次）','—（人均 — 次）']);
  assert(rows.every(r=>r.children.length===8));assert.equal(rows[0].children[6].textContent,'100（人均 10.00 次）','existing all-user DAU average unchanged');
  assert.equal(rows[0].className,'history-weekend');assert.match(rows[0].children[0].textContent,/周六.*截至现在/);
  assert.equal(doc.querySelectorAll('.metric-card').length,6,'only add the requested table column');
  assert.match(doc.body.textContent,/注册用户视频数.*当天注册.*当天.*人均.*当日新注册人数/);
  assert.doesNotMatch(doc.body.textContent,/NaN|Infinity|undefined/);
 }finally{dom.window.close();}
});
