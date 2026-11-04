import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element{
 children=[];value='';text='';events={};className='';classList={add:()=>{},remove:()=>{}};
 append(...xs){this.children.push(...xs);}replaceChildren(...xs){this.children=[...xs];this.text='';}
 set textContent(x){this.text=String(x);this.children=[];}get textContent(){return this.text+this.children.map(x=>x.textContent).join('');}
 addEventListener(k,fn){this.events[k]=fn;}
}
const walk=e=>[e,...e.children.flatMap(walk)];
const uid='11111111-1111-4111-8111-111111111111';
async function setup(fetcher=async()=>({ok:true,status:200,json:async()=>({marker:'found'})})){
 const js=await readFile(new URL('../dashboard/public/app.js',import.meta.url),'utf8'),view=new Element(),seen=[],rendered=[];
 runInNewContext(js.slice(0,js.indexOf("$('login-form').addEventListener"))+`;loggedIn=true;tab='player';renderPlayer=(data,target)=>{rendered.push(data);target.append(node('p',data.marker));};renderPlayerForm();`,{document:{getElementById:()=>view,createElement:()=>new Element()},fetch:async(path,options)=>{seen.push({path,body:JSON.parse(options.body)});return fetcher();},rendered});
 const find=id=>walk(view).find(e=>e.id===id),form=find('player-form'),input=find('openid-input'),mode=find('player-query-type');
 return {view,find,input,mode,seen,rendered,submit:()=>form.events.submit({preventDefault(){}})};
}
test('player form keeps openid default and submits explicit UID lookup without altering identifiers',async()=>{
 const h=await setup();assert(h.mode,'lookup mode selector is visible');assert.equal(h.mode.value,'openid');
 assert.deepEqual(h.mode.children.map(e=>e.value),['openid','uid']);
 h.input.value='sample_openid';await h.submit();assert.deepEqual(h.seen[0].body,{openid:'sample_openid'});
 h.mode.value='uid';h.mode.events.change();assert.match(h.view.textContent,/玩家 UID/);assert.equal(h.input.maxLength,36);
 h.input.value=uid;await h.submit();assert.deepEqual(h.seen[1].body,{uid});assert.equal(h.rendered.length,2);
 h.mode.value='openid';h.mode.events.change();assert.equal(h.input.maxLength,128);assert.equal(h.find('player-result').textContent,'');
});
test('changing lookup mode or input invalidates an in-flight result',async()=>{
 for(const change of ['mode','input']){
  let finish;const pending=new Promise(r=>{finish=r;});const h=await setup(()=>pending);h.input.value='sample_openid';const request=h.submit();
  if(change==='mode'){assert(h.mode);h.mode.value='uid';h.mode.events.change();}else{h.input.value='different_openid';assert(h.input.events.input);h.input.events.input();}
  finish({ok:true,status:200,json:async()=>({marker:'stale'})});await request;assert.equal(h.rendered.length,0);assert.equal(h.find('player-result').textContent,'');
 }
});
test('UID errors and missing-player errors have mode-independent Chinese guidance',async()=>{
 for(const [message,status,expected] of [['INVALID_UID',400,/UID.*格式/],['PLAYER_NOT_FOUND',404,/未找到.*玩家/]]){
  const h=await setup(async()=>({ok:false,status,json:async()=>({message})}));assert(h.mode);h.mode.value='uid';h.mode.events.change();h.input.value=uid;await h.submit();const error=h.find('player-error');assert.match(error.textContent,expected);assert.doesNotMatch(error.textContent,/该 openid/);
 }
});
