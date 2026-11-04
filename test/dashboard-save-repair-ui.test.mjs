import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element{
 children=[];value='';events={};className='';dataset={};disabled=false;checked=false;hidden=false;text='';classList={add(){},remove(){},toggle(){}};
 append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;this.text='';}set textContent(v){this.text=String(v??'');this.children=[];}get textContent(){return this.text+this.children.map(x=>x.textContent).join('');}addEventListener(k,fn){this.events[k]=fn;}reset(){}
}
const walk=e=>[e,...e.children.flatMap(walk)];
const snapshot={user:{id:'sample-uid',openid:'o-player',nickname:'<img onerror=x>'},save:{exists:true,version:5,updatedAt:'2026-10-31T10:00:00Z'},fields:{Is_Remove_AD_All:false,Dia:3,_getDia:3309,_useDia:3300},fingerprint:'a'.repeat(64),writable:true};
async function setup(handler,confirmation=true){
 const source=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),elements=new Map(),calls=[],confirms=[];
 const document={getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:()=>new Element(),querySelectorAll:()=>[],hidden:false};
 const context=runInNewContext(source.slice(0,source.indexOf("$('login-form').addEventListener"))+';({open(){loggedIn=true;switchView("saveRepair")},leave(){switchView("player")},logout:showLogin})',{document,Date,Number,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},confirm:text=>{confirms.push(text);return confirmation;},fetch:async(url,options)=>{const body=options.body?JSON.parse(options.body):null;calls.push({url,body});const value=await handler(url,body);return {ok:value.status===undefined||value.status===200,status:value.status??200,json:async()=>value.data??value};},clearInterval(){},setInterval(){}});
 context.open();const view=elements.get('view-container');return {context,view,calls,confirms,get:id=>walk(view).find(e=>e.id===id)};
}
test('diamond editor explains triple raw counters and starts with optional empty positive integer amount',async()=>{
 const app=await setup(handler);
 assert.match(app.view.textContent,/补偿钻石数量（余额增加 N，累计获取统计增加 3N）/);
 assert.match(app.view.textContent,/_getDia.*_useDia.*原始3倍统计.*非实际钻石/);
 assert.equal(app.get('save-repair-dia').min,'1');assert.equal(app.get('save-repair-dia').step,'1');assert.equal(app.get('save-repair-dia').value,'');
});
const submit=e=>e.events.submit({preventDefault(){}}),click=e=>e.events.click({preventDefault(){}});
const handler=async(url,body)=>url.endsWith('/lookup')?snapshot:url.endsWith('/preview')?{...snapshot,before:snapshot.fields,after:{Is_Remove_AD_All:true,Dia:103,_getDia:3609,_useDia:3300},changes:body.changes}:{...snapshot,save:{version:6},fields:{Is_Remove_AD_All:true,Dia:103,_getDia:3609,_useDia:3300}};
test('reason starts empty and must be explicitly supplied before preview or confirmation',async()=>{
 const app=await setup(handler);assert.equal(app.get('save-repair-reason').value,'');assert.equal(app.get('save-repair-reason').required,true);assert.equal(app.get('save-repair-reason').placeholder,'玩家钻石补偿');
 app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-dia').value='100';
 for(const reason of ['', '   ', 'x'.repeat(201), '坏\n原因']){app.get('save-repair-reason').value=reason;await click(app.get('save-repair-preview'));await click(app.get('save-repair-apply'));assert.equal(app.calls.length,1);assert.equal(app.confirms.length,0);assert.match(app.view.textContent,/请填写有效修改原因/);}
 app.get('save-repair-reason').value='玩家钻石补偿';await click(app.get('save-repair-preview'));
 // Also defend against a value cleared without an input/change event.
 app.get('save-repair-reason').value='';await click(app.get('save-repair-apply'));assert.equal(app.calls.length,2);assert.equal(app.confirms.length,0);assert.equal(app.get('save-repair-apply').disabled,true);
});
test('cancel or disabled writer never posts apply and editing invalidates preview',async()=>{
 for(const writable of [true,false]){
  const app=await setup(async(url,body)=>url.endsWith('/lookup')?{...snapshot,writable}:handler(url,body),false);
  app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-reason').value='玩家钻石补偿：工单123';app.get('save-repair-dia').value='100';app.get('save-repair-ads').checked=true;await click(app.get('save-repair-preview'));
  assert.equal(app.get('save-repair-apply').disabled,!writable);await click(app.get('save-repair-apply'));assert.equal(app.calls.length,2);
  app.get('save-repair-dia').value='200';app.get('save-repair-dia').events.input();assert.equal(app.get('save-repair-apply').disabled,true);await click(app.get('save-repair-apply'));assert.equal(app.calls.length,2);
 }
});
test('bad diamond inputs do not request preview; missing save never enables editor',async()=>{
 const app=await setup(handler);app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-reason').value='玩家钻石补偿：工单123';
 for(const bad of ['0','-1','1.5','1e3','1E3','garbage',' 1','+1','2147483648','9007199254740992']){app.get('save-repair-dia').value=bad;await click(app.get('save-repair-preview'));assert.equal(app.calls.length,1,`reject ${bad}`);assert.match(app.view.textContent,/正整数.*2147483647/);}
 app.get('save-repair-dia').value='';await click(app.get('save-repair-preview'));assert.equal(app.calls.length,1);assert.match(app.view.textContent,/没有需要保存的修改/);
 app.get('save-repair-ads').checked=true;await click(app.get('save-repair-preview'));assert.deepEqual(app.calls[1].body.changes,{removeAds:true});await click(app.get('save-repair-apply'));assert.deepEqual(app.calls[2].body.changes,{removeAds:true});
 for(const valid of ['1','2147483647']){const boundary=await setup(handler);boundary.get('save-repair-openid').value='o-player';await submit(boundary.get('save-repair-form'));boundary.get('save-repair-reason').value='边界交由服务端校验';boundary.get('save-repair-dia').value=valid;await click(boundary.get('save-repair-preview'));assert.equal(boundary.calls[1].body.changes.addDia,Number(valid));}
 const missing=await setup(async()=>({...snapshot,save:{exists:false,version:0},fields:null}));missing.get('save-repair-openid').value='o-player';await submit(missing.get('save-repair-form'));assert.equal(missing.get('save-repair-preview').disabled,true);assert.match(missing.view.textContent,/没有云存档/);
});
test('lost response after a simulated commit requires manual lookup and never automatically grants twice',async()=>{
 let committed=false,writes=0;
 const app=await setup(async(url,body)=>{if(url.endsWith('/apply')){committed=true;writes++;throw new Error('network response lost');}if(url.endsWith('/lookup')&&committed)return {...snapshot,save:{...snapshot.save,version:6},fields:{...snapshot.fields,Dia:103,_getDia:3609}};return handler(url,body);});
 app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-reason').value='玩家钻石补偿：工单123';app.get('save-repair-dia').value='100';await click(app.get('save-repair-preview'));await click(app.get('save-repair-apply'));
 assert.equal(committed,true);assert.match(app.view.textContent,/结果可能已保存/);assert.equal(app.get('save-repair-apply').disabled,true);assert.equal(app.get('save-repair-preview').disabled,true);await click(app.get('save-repair-apply'));assert.equal(app.calls.length,3);assert.equal(writes,1);assert.equal(app.calls[2].body.requestId,'11111111-1111-4111-8111-111111111111');
 await submit(app.get('save-repair-form'));assert.equal(app.calls.length,4);assert.match(app.view.textContent,/3609/);assert.equal(app.get('save-repair-dia').value,'');assert.equal(app.get('save-repair-reason').value,'');assert.equal(app.get('save-repair-apply').disabled,true);
});
test('definitive conflict requires relookup and cannot double-submit',async()=>{
 let release;const deferred=new Promise(r=>{release=r;});
 const app=await setup(async(url,body)=>url.endsWith('/apply')?(await deferred,{status:409,data:{message:'SAVE_REPAIR_VERSION_CONFLICT'}}):handler(url,body));
 app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-reason').value='玩家钻石补偿：工单123';app.get('save-repair-dia').value='100';await click(app.get('save-repair-preview'));
 const pending=click(app.get('save-repair-apply'));assert.equal(app.get('save-repair-apply').disabled,true);await click(app.get('save-repair-apply'));assert.equal(app.calls.length,3);release();await pending;
 assert.match(app.view.textContent,/存档已更新/);assert.match(app.view.textContent,/重新查询核对/);assert.equal(app.get('save-repair-apply').disabled,true);await click(app.get('save-repair-apply'));assert.equal(app.calls.length,3);
});
test('double-click successful save uses one requestId and only one simulated write',async()=>{
 let release,writes=0;const deferred=new Promise(r=>{release=r;}),requestIds=new Set();
 const app=await setup(async(url,body)=>{if(url.endsWith('/apply')){if(!requestIds.has(body.requestId)){requestIds.add(body.requestId);writes++;}await deferred;}return handler(url,body);});
 app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-reason').value='防重测试工单';app.get('save-repair-dia').value='100';await click(app.get('save-repair-preview'));
 const pending=click(app.get('save-repair-apply'));await click(app.get('save-repair-apply'));assert.equal(writes,1);assert.equal(app.calls.filter(e=>e.url.endsWith('/apply')).length,1);assert.deepEqual([...requestIds],['11111111-1111-4111-8111-111111111111']);release();await pending;await click(app.get('save-repair-apply'));assert.equal(writes,1);assert.equal(app.confirms.length,1);
});
test('stale preview after editing, navigation or logout cannot enable confirmation',async()=>{
 for(const mode of ['edit','leave','logout']){let release;const deferred=new Promise(r=>{release=r;});const app=await setup(async(url,body)=>{if(url.endsWith('/preview'))await deferred;return handler(url,body);});app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-dia').value='100';app.get('save-repair-reason').value='工单';const oldApply=app.get('save-repair-apply'),pending=click(app.get('save-repair-preview'));if(mode==='edit'){app.get('save-repair-dia').value='200';app.get('save-repair-dia').events.input();}else if(mode==='leave')app.context.leave();else app.context.logout();release();await pending;await click(oldApply);assert.equal(app.calls.length,2);assert.equal(app.confirms.length,0);if(mode==='edit')assert.equal(oldApply.disabled,true);}
});
test('number-input badInput is rejected even when browser exposes an empty value',async()=>{
 const app=await setup(handler);app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-reason').value='工单';app.get('save-repair-ads').checked=true;app.get('save-repair-dia').value='';app.get('save-repair-dia').validity={badInput:true};await click(app.get('save-repair-preview'));assert.equal(app.calls.length,1);assert.match(app.view.textContent,/正整数/);
});
test('stale lookup after navigation or edited openid cannot display another player',async()=>{
 for(const mode of ['leave','edit','logout']){
  let release;const deferred=new Promise(r=>{release=r;});const app=await setup(async()=>{await deferred;return snapshot;});app.get('save-repair-openid').value='o-player';const pending=submit(app.get('save-repair-form'));
  if(mode==='leave')app.context.leave();else if(mode==='logout')app.context.logout();else{app.get('save-repair-openid').value='o-other';app.get('save-repair-openid').events.input();}
  release();await pending;assert.doesNotMatch(app.view.textContent,/sample-uid/);
 }
});
test('server preview shows original, modified and signed raw triple deltas in table and UID confirmation without sending computed fields',async()=>{
 const before={Is_Remove_AD_All:false,Dia:20,_getDia:960,_useDia:900},after={...before,Dia:10020,_getDia:30960},delta={Dia:10000,_getDia:30000,_useDia:0};
 const app=await setup(async(url,body)=>url.endsWith('/lookup')?{...snapshot,fields:before}:url.endsWith('/preview')?{...snapshot,before,after,delta,changes:body.changes}:{...snapshot,save:{version:6},fields:after});
 app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-dia').value='10000';app.get('save-repair-reason').value='工单：玩家钻石补偿';await click(app.get('save-repair-preview'));
 const table=walk(app.view).filter(e=>e.className==='history-table save-repair-table').at(-1);
 assert.deepEqual(table.children[0].children.map(e=>e.textContent),['字段','原始值','修改值','增量']);
 for(const [key,from,to,change] of [['Dia','20','10020','+10000'],['_getDia','960','30960','+30000'],['_useDia','900','900','0']]){const row=table.children.find(e=>e.children[0]?.textContent===key);assert.deepEqual(row.children.map(e=>e.textContent),[key,from,to,change]);}
 await click(app.get('save-repair-apply'));assert.match(app.confirms[0],/UID：sample-uid/);assert.match(app.confirms[0],/Dia：20 → 10020（增量：\+10000）/);assert.match(app.confirms[0],/_getDia：960 → 30960（增量：\+30000）/);assert.match(app.confirms[0],/_useDia：900 → 900（增量：0）/);assert.match(app.confirms[0],/原因：工单：玩家钻石补偿/);
 assert.deepEqual(Object.keys(app.calls[1].body).sort(),['changes','fingerprint','openid','version']);assert.deepEqual(Object.keys(app.calls[2].body).sort(),['changes','fingerprint','openid','reason','requestId','version']);assert.deepEqual(app.calls[2].body.changes,{addDia:10000});assert.equal(app.calls[2].body.reason,'工单：玩家钻石补偿');
});
test('ledger, int32 overflow and invalid-save errors explain manual review and never allow saving',async()=>{
 for(const [code,expected] of [['SAVE_REPAIR_INVALID_LEDGER',/账目异常.*人工复核.*未自动修账/],['SAVE_REPAIR_DIAMOND_OVERFLOW',/int32.*超限.*拒绝/],['SAVE_REPAIR_INVALID_SAVE',/人工复核/],['SAVE_REPAIR_INVALID_REQUEST',/正整数/]]){
  const app=await setup(async(url,body)=>url.endsWith('/preview')?{status:400,data:{message:code}}:handler(url,body));app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-dia').value='100';app.get('save-repair-reason').value='人工核对工单';await click(app.get('save-repair-preview'));assert.match(app.view.textContent,expected);assert.equal(app.get('save-repair-apply').disabled,true);await click(app.get('save-repair-apply'));assert.equal(app.calls.length,2);assert.equal(app.confirms.length,0);
 }
});
test('modify-data tab looks up openid, previews synchronized diamond delta and writes only after explicit confirm',async()=>{
 const app=await setup(handler);assert(app.get('save-repair-form'),'new tab renders repair form');
 app.get('save-repair-openid').value='o-player';await submit(app.get('save-repair-form'));app.get('save-repair-reason').value='玩家钻石补偿：工单123';
 assert.match(app.view.textContent,/3309/);assert.match(app.view.textContent,/3300/);assert.match(app.view.textContent,/退出游戏/);
 app.get('save-repair-dia').value='100';app.get('save-repair-ads').checked=true;await click(app.get('save-repair-preview'));
 assert.equal(app.calls.length,2);assert.match(app.view.textContent,/3609/);assert.match(app.view.textContent,/103/);assert.equal(app.get('save-repair-apply').disabled,false);
 await click(app.get('save-repair-apply'));assert.equal(app.calls.length,3);assert.equal(app.confirms.length,1);assert.match(app.confirms[0],/o-player/);
 const payload=app.calls[2].body;assert.deepEqual(payload.changes,{removeAds:true,addDia:100});assert.equal(payload.version,5);assert.equal(payload.fingerprint,snapshot.fingerprint);assert.equal(payload.requestId,'11111111-1111-4111-8111-111111111111');assert(!('data'in payload));assert.match(app.view.textContent,/保存成功/);assert.equal(app.get('save-repair-apply').disabled,true);
});
