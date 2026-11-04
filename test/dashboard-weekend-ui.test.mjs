import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element {
 children=[];className='';value='';
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 set textContent(v){this.value=String(v);this.children=[];}
 get textContent(){return this.value+this.children.map(c=>c.textContent).join('');}
}
test('overview marks only Saturday and Sunday rows in its Beijing-date 14-day trend without changing metrics',async()=>{
 const script=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),view=new Element();
 const render=runInNewContext(script.slice(0,script.indexOf("$('login-form').addEventListener"))+';renderOverview',{document:{getElementById:()=>view,createElement:()=>new Element()}});
 const dates=['2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-17','2026-10-18','2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25'];
 const history=dates.map(date=>({date,newUsers:4,invitedNewUsers:1,dau:2,rewardedVideos:6,cohortSize:4,returned:2,d1Rate:.5,retentionDate:date==='2026-10-24'?'2026-10-25':'2026-10-26'}));
 const data={today:'2026-10-25',coverageStart:'2026-10-17',metrics:{dau:2,newUsers:4,invitedNewUsers:1,totalUsers:60,todayRewardedVideos:6,d1:{cohortSize:4,returned:2,rate:.5}},history};
 const before=JSON.stringify(data);render(data);
 const table=view.children.find(e=>e.className==='history-table-container').children[0],rows=table.children[1].children;
 assert.equal(rows.length,14);assert.equal(table.children[0].children[0].children.length,7);
 assert.deepEqual(rows.filter(r=>r.className==='history-weekend').map(r=>r.children[0].textContent),['2026-10-25（周日）（截至现在）','2026-10-24（周六）','2026-10-18（周日）','2026-10-17（周六）']);
 assert.deepEqual(rows.map(r=>r.children[0].textContent.slice(0,10)),[...dates].reverse());
 for(const row of rows){
  const date=row.children[0].textContent.slice(0,10),weekend=['2026-10-17','2026-10-18','2026-10-24','2026-10-25'].includes(date);
  assert.equal(row.className==='history-weekend',weekend);
  if(!weekend)assert.equal(row.children[0].textContent,date,'weekday dates stay unchanged');
  assert.equal(row.children.length,7);assert.equal(row.children[1].textContent,'4');assert.equal(row.children[2].textContent,'1（25.00%）');assert.equal(row.children[3].textContent,'2');assert.equal(row.children[6].textContent,'6（人均 3.00 次）');
 }
 assert.equal(rows[0].children[4].textContent,'待次日统计');assert.equal(rows[0].children[5].textContent,'待次日统计');assert.equal(rows[1].children[4].textContent,'50.00%（实时）');
 assert.equal(view.children[0].children.length,6);assert.equal(JSON.stringify(data),before);
 assert.match(view.textContent,/周六.*周日.*绿色/);
});
test('weekend coloring targets all cells in weekend rows with light and dark theme colors',async()=>{
 const css=await readFile(new URL('../dashboard/public/style.css',import.meta.url),'utf8');
 assert.match(css,/\.history-table\s+tbody\s+tr\.history-weekend\s*>\s*td\s*\{[^}]*color:\s*#15803d\s*;[^}]*background-color:/s);
 assert.match(css,/body\.dark\s+\.history-table\s+tbody\s+tr\.history-weekend\s*>\s*td\s*\{[^}]*color:\s*#4ade80\s*;/s);
});
