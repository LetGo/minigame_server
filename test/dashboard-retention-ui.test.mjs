import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element{children=[];className='';value='';append(...items){this.children.push(...items);}replaceChildren(...items){this.children=[...items];}set textContent(value){this.value=String(value);this.children=[];}get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}}
test('retention table belongs to registration date, today is pending and yesterday remains live',async()=>{
 const script=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),view=new Element();
 const render=runInNewContext(script.slice(0,script.indexOf("$('login-form').addEventListener"))+';renderOverview',{document:{getElementById:()=>view,createElement:()=>new Element()}});
 const make=(date,retentionDate,newUsers,returned,d1Rate)=>({date,retentionDate,newUsers,cohortSize:newUsers,returned,d1Rate,invitedNewUsers:0,dau:1,d1Pending:date==='2026-10-20'});
 const data={today:'2026-10-20',coverageStart:'2026-10-17',metrics:{dau:6,newUsers:5,invitedNewUsers:0,totalUsers:20,todayRewardedVideos:0,d1:{cohortSize:4,returned:2,rate:.5}},history:[make('2026-10-18','2026-10-19',8,2,.25),make('2026-10-19','2026-10-20',4,2,.5),make('2026-10-20','2026-10-21',5,null,null),make('2026-10-17','2026-10-18',0,0,null),make('2026-10-16','2026-10-17',3,null,null)]};
 render(data);
 const table=view.children.find(e=>e.className==='history-table-container').children[0],rows=table.children[1].children.map(r=>r.children.map(c=>c.textContent));
 assert.equal(table.children[0].children[0].children[5].textContent,'次日回访 / 当日新增');
 assert.equal(rows[0][0],'2026-10-20（截至现在）');assert.equal(rows[0][4],'待次日统计');assert.equal(rows[0][5],'待次日统计');
 assert.equal(rows[1][0],'2026-10-19');assert.equal(rows[1][4],'50.00%（实时）');assert.equal(rows[1][5],'2 / 4');
 assert.equal(rows[2][0],'2026-10-18');assert.equal(rows[2][4],'25.00%');assert.equal(rows[2][5],'2 / 8');
 assert.equal(rows[3][4],'—');assert.equal(rows[4][4],'—');assert.equal(rows[4][5],'— / 3');
 const card=view.children[0].children.find(e=>e.children[0].textContent==='实时次日留存');assert.equal(card.children[1].textContent,'50.00%');assert.match(card.children[2].textContent,/昨日新增 4 · 今日回访 2/);
 assert.match(view.textContent,/次日留存按注册日期归属/);assert.doesNotMatch(view.textContent,/NaN|Infinity|回访 \/ 昨日新增/);assert.equal(data.history[0].date,'2026-10-18','response order unchanged');
});
