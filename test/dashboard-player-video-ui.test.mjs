import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element {
 children=[];value='';events={};className='';dataset={};
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=[...items];this.value='';}
 set textContent(value){this.value=String(value);this.children=[];}
 get textContent(){return this.value+this.children.map(x=>x.textContent).join('');}
 addEventListener(name,fn){this.events[name]=fn;}
}
const walk=e=>[e,...e.children.flatMap(walk)];
async function setup(){
 const js=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8');
 return runInNewContext(js.slice(0,js.indexOf("$('login-form').addEventListener"))+';({renderPlayer})',{
  document:{getElementById:()=>new Element(),createElement:()=>new Element()},Date
 });
}
const base={user:{id:'sample-uid',openid:'sample-openid'},save:{exists:true,data:'{ "RewardAdWatchCount": 0 }',version:3},invitations:{summary:{total:0,claimed:0,unclaimed:0},items:[]},dailyLogins:[]};
test('player panel renders server completion aggregate, Beijing timestamps and placement totals, preserving raw save',async()=>{
 const app=await setup(),target=new Element();
 app.renderPlayer({...base,rewardedVideos:{total:673,today:98,firstRecordedAt:'2026-10-18T13:18:13Z',lastRecordedAt:'2026-10-22T04:32:28Z',placements:[{placement:'<img src=x onerror=alert(1)>',total:169,today:20}]}},target);
 const all=walk(target),section=all.find(e=>e.id==='player-rewarded-videos');assert(section,'player query includes rewarded video section');
 assert.match(section.textContent,/激励视频/);assert.match(section.textContent,/累计次数673/);assert.match(section.textContent,/今日次数98/);
 assert.match(section.textContent,/2026\/10\/18 21:18:13/);assert.match(section.textContent,/2026\/10\/22 12:32:28/);
 const table=walk(section).find(e=>e.className.includes('player-video-table'));assert(table);
 assert.deepEqual(table.children[0].children[0].children.map(e=>e.textContent),['广告点位','累计次数','今日次数']);
 assert.deepEqual(table.children[1].children[0].children.map(e=>e.textContent),['<img src=x onerror=alert(1)>','169','20']);
 assert.equal(table.children[1].children[0].children[0].children.length,0,'untrusted placement text only');
 assert.match(section.textContent,/北京时间/);assert.match(section.textContent,/去重/);assert.match(section.textContent,/不.*平台/);
 assert.equal(all.find(e=>e.id==='raw-save').textContent,base.save.data,'do not use or rewrite save counter');
});
test('zero events show zero, missing dates and an empty message; unavailable aggregate is not a false zero',async()=>{
 const app=await setup(),target=new Element();
 app.renderPlayer({...base,rewardedVideos:{total:0,today:0,firstRecordedAt:null,lastRecordedAt:null,placements:[]}},target);
 const section=walk(target).find(e=>e.id==='player-rewarded-videos');assert.match(section.textContent,/累计次数0/);assert.match(section.textContent,/今日次数0/);assert.match(section.textContent,/首次记录（北京时间）—/);assert.match(section.textContent,/最近记录（北京时间）—/);assert.match(section.textContent,/暂无已上报的视频完成记录/);assert.doesNotMatch(section.textContent,/NaN|Invalid Date|undefined/);
 const absent=new Element();app.renderPlayer(base,absent);const unavailable=walk(absent).find(e=>e.id==='player-rewarded-videos');assert.match(unavailable.textContent,/暂不可用/);assert.doesNotMatch(unavailable.textContent,/累计次数0/);
});
