import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element {
 children=[];className='';value='';title='';
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];}
 set textContent(value){this.value=String(value);this.children=[];}
 get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}
}
async function harness(){
 const script=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),view=new Element();
 const render=runInNewContext(script.slice(0,script.indexOf("$('login-form').addEventListener"))+';renderOverview',{document:{getElementById:()=>view,createElement:()=>new Element()}});
 return {view,render};
}
function fixture(comparison){return {today:'2026-10-27',generatedAt:'2026-10-27T03:30:00Z',coverageStart:'2026-10-17',yesterdaySameTime:comparison,metrics:{dau:20,newUsers:5,invitedNewUsers:3,todayRewardedVideos:120,totalUsers:800,d1:{rate:.5,cohortSize:6,returned:3}},history:[]};}
test('four daily cards show smaller yesterday-at-same-time counts while totals and D1 stay unchanged',async()=>{
 const {view,render}=await harness(),data=fixture({date:'2026-10-26',cutoffAt:'2026-10-26T03:30:00Z',dau:18,newUsers:4,invitedNewUsers:0,todayRewardedVideos:99});
 const before=JSON.stringify(data);render(data);const cards=view.children[0].children;
 assert.equal(cards.length,6);
 const expected=new Map([['今日活跃用户','18'],['今日新注册','4'],['今日邀请新注册','0'],['今日激励视频次数','99']]);
 for(const card of cards){const title=card.children[0].textContent,comparison=card.children.find(x=>x.className==='metric-comparison');
  if(expected.has(title)){assert(comparison,`${title} requires same-time comparison`);assert.equal(comparison.textContent,`昨日同期：${expected.get(title)}`);assert.match(comparison.title,/2026.*10.*26.*11:30:00/);}
  else assert.equal(comparison,undefined,`${title} is not a daily count`);
 }
 assert.equal(cards[0].children[1].textContent,'20');assert.equal(cards[3].children[1].textContent,'50.00%');assert.equal(cards[4].children[1].textContent,'800');assert.equal(JSON.stringify(data),before);
 assert.match(view.textContent,/昨日同期.*北京时间.*更新于/);
});
test('missing and partial yesterday data render dash rather than invented zero or yesterday full-day totals',async()=>{
 const {view,render}=await harness();
 for(const comparison of [undefined,null,{}, {dau:null,newUsers:0,invitedNewUsers:undefined,todayRewardedVideos:0}]){
  const data=fixture(comparison);data.history=[{date:'2026-10-26',newUsers:500,invitedNewUsers:400,dau:900,rewardedVideos:9000,cohortSize:500,returned:2,d1Rate:.004}];render(data);
  const labels=view.children[0].children.flatMap(c=>c.children.filter(x=>x.className==='metric-comparison'));
  assert.equal(labels.length,4);assert.deepEqual(labels.map(x=>x.textContent),comparison?.newUsers===0?['昨日同期：—','昨日同期：0','昨日同期：—','昨日同期：0']:Array(4).fill('昨日同期：—'));
  assert.doesNotMatch(labels.map(x=>x.textContent).join(' '),/900|500|NaN|Infinity|undefined|null/);
 }
});
test('daily primary values are green above yesterday, red below, and neutral when equal or unknown',async()=>{
 const {view,render}=await harness();
 const keys=['dau','newUsers','invitedNewUsers','todayRewardedVideos'];
 const indices=[0,1,2,5];
 for(const yesterday of [0,5,20,null,undefined]){
  const data=fixture(Object.fromEntries(keys.map(key=>[key,yesterday])));
  for(const key of keys)data.metrics[key]=5;
  render(data);const cards=view.children[0].children;
  for(const index of indices){
   const value=cards[index].children[1],expected=yesterday==null?'metric-value':yesterday<5?'metric-value metric-value-better':yesterday>5?'metric-value metric-value-worse':'metric-value';
   assert.equal(value.className,expected,`${keys[indices.indexOf(index)]}: yesterday ${yesterday}`);
   assert.equal(value.textContent,'5');
   assert.equal(cards[index].children.find(x=>x.className==='metric-comparison').className,'metric-comparison');
  }
  for(const index of [3,4])assert.equal(cards[index].children[1].className,'metric-value');
 }
 const data=fixture({dau:0,newUsers:5,invitedNewUsers:5,todayRewardedVideos:5});
 data.metrics.dau=0;data.metrics.invitedNewUsers=null;data.metrics.todayRewardedVideos=0;render(data);
 assert.equal(view.children[0].children[0].children[1].className,'metric-value');
 assert.equal(view.children[0].children[2].children[1].className,'metric-value');
 assert.equal(view.children[0].children[5].children[1].className,'metric-value metric-value-worse');
});
test('comparison primary-value CSS maps better to green and worse to red without recoloring yesterday labels',async()=>{
 const css=await readFile(new URL('../dashboard/public/style.css',import.meta.url),'utf8');
 assert.match(css,/\.metric-value\.metric-value-better\s*\{\s*color:\s*var\(--color-success\);\s*\}/);
 assert.match(css,/\.metric-value\.metric-value-worse\s*\{\s*color:\s*var\(--color-error\);\s*\}/);
 assert.match(css,/--color-success:\s*#10b981/);
 assert.match(css,/--color-error:\s*#ef4444/);
});
test('comparison CSS places muted small type to the right of primary counts and permits narrow-card wrapping',async()=>{
 const css=await readFile(new URL('../dashboard/public/style.css',import.meta.url),'utf8');
 assert.match(css,/\.metric-card\s*\{[^}]*display:\s*grid/s);
 assert.match(css,/\.metric-comparison\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*2[^}]*font-size:\s*0\.8125rem[^}]*color:\s*var\(--color-muted\)[^}]*overflow-wrap:\s*anywhere/s);
});
