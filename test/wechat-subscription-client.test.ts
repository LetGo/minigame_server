import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {WechatSubscriptionClient,SubscriptionDeliveryError} from '../src/subscriptions/wechat-subscription.client.js';
import {buildCheckinMessage,CHECKIN_TEMPLATE_ID,CHECKIN_TEMPLATE_NUMBER} from '../src/subscriptions/checkin-template.js';
const credentials=()=>({appId:'wx1234567890abcdef',appSecret:randomUUID()});
function failure(outcome:string,code:number|null=null){return (e:unknown)=>{assert(e instanceof Error);assert(e instanceof SubscriptionDeliveryError);assert.equal(e.outcome,outcome);assert.equal(e.code,code);assert.doesNotMatch(String(e)+JSON.stringify(e),/private-upstream|access_token=|secret-test|openid-private/);return true;};}
test('fixed check-in template preserves exact user fields, character limits and explicit trial jump',()=>{
 const message=buildCheckinMessage('openid_abc-def','index?from=checkin');assert.equal(CHECKIN_TEMPLATE_NUMBER,85);assert.equal(message.template_id,'2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4');assert.equal(message.miniprogram_state,'trial');assert.equal(message.lang,'zh_CN');assert.equal(message.page,'index?from=checkin');
 assert.deepEqual(message.data,{phrase1:{value:'未签到'},thing10:{value:'签到领海量奖励'},thing5:{value:'您的猫咪提示您有海量钻石待领取'}});assert(Array.from(message.data.phrase1.value).length<=5);for(const field of [message.data.thing10,message.data.thing5])assert(Array.from(field.value).length<=20);
 for(const v of [null,undefined,12,{},'','bad space','a'.repeat(129)])assert.throws(()=>buildCheckinMessage(v as any));
 for(const v of [null,12,{},'','https://evil.invalid','//evil.invalid','index\n','a'.repeat(513)])assert.throws(()=>buildCheckinMessage('safe',v as any));
});
test('stable token POST is single-flight and cached; send uses exact official POST and never forces refresh',async()=>{
 const seen:{url:string;init:RequestInit|undefined}[]=[],secret=credentials();
 const fetcher:typeof fetch=async(input,init)=>{const url=String(input);seen.push({url,init});return Response.json(url.endsWith('/stable_token')?{access_token:'test_token',expires_in:7200}:{errcode:0,errmsg:'ok'});};
 const client=new WechatSubscriptionClient(secret,fetcher);await Promise.all(Array.from({length:8},()=>client.send('openid_abc-def','index?from=checkin')));
 assert.equal(seen.filter(r=>r.url.endsWith('/stable_token')).length,1);assert.equal(seen.length,9);
 assert.deepEqual(JSON.parse(seen[0]!.init!.body as string),{grant_type:'client_credential',appid:secret.appId,secret:secret.appSecret,force_refresh:false});
 for(const entry of seen){assert.equal(entry.init?.method,'POST');assert.equal(entry.init?.redirect,'error');assert(entry.init?.signal instanceof AbortSignal);if(!entry.url.endsWith('/stable_token')){assert.equal(entry.url,'https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=test_token');assert.deepEqual(JSON.parse(entry.init!.body as string),buildCheckinMessage('openid_abc-def','index?from=checkin'));}}
 assert(!JSON.stringify(client).includes(secret.appSecret));
});
test('real token expires_in controls early cache expiry instead of a hard-coded two hours',async()=>{
 let now=1000,tokens=0;const fetcher:typeof fetch=async(input)=>Response.json(String(input).endsWith('/stable_token')?{access_token:'token'+(++tokens),expires_in:10}:{errcode:0});
 const client=new WechatSubscriptionClient(credentials(),fetcher,{now:()=>now});await client.send('safe');await client.send('safe');assert.equal(tokens,1);now=12000;await client.send('safe');assert.equal(tokens,2);
});
test('invalid local arguments fail as not_sent before any network operation',async()=>{
 let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error('must not call');};const client=new WechatSubscriptionClient(credentials(),fetcher);
 for(const [openid,page] of [['','index'],['bad space','index'],['safe','https://evil.invalid'],['safe','index\n']])await assert.rejects(()=>client.send(openid!,page),failure('not_sent'));assert.equal(calls,0);
});
test('invalid, denied, redirected or unavailable token cannot cause a send',async()=>{
 for(const payload of [{errcode:40164,errmsg:'private-upstream secret-test'},null,{access_token:'',expires_in:7200},{access_token:'valid',expires_in:0},{access_token:'valid',expires_in:NaN},{access_token:'valid',expires_in:7201}]){
  let calls=0;const fetcher:typeof fetch=async()=>{calls++;return Response.json(payload);};await assert.rejects(()=>new WechatSubscriptionClient(credentials(),fetcher).send('safe'),failure('not_sent'));assert.equal(calls,1);
 }
 for(const response of [()=>new Response('bad json'),()=>new Response('',{status:302}),()=>new Response('',{status:503})]){let calls=0;const fetcher:typeof fetch=async()=>{calls++;return response();};await assert.rejects(()=>new WechatSubscriptionClient(credentials(),fetcher).send('safe'),failure('not_sent'));assert.equal(calls,1);}
});
test('explicit send rejection preserves only numeric code, with no token-invalid or message retry',async()=>{
 for(const code of [43101,43108,40037,40001,-1]){let calls=0;const fetcher:typeof fetch=async(input)=>{calls++;return Response.json(String(input).endsWith('/stable_token')?{access_token:'test_token',expires_in:7200}:{errcode:code,errmsg:'private-upstream openid-private secret-test'});};await assert.rejects(()=>new WechatSubscriptionClient(credentials(),fetcher).send('safe'),failure('rejected',code));assert.equal(calls,2);}
});
test('attempted sends with ambiguous HTTP, malformed JSON or network loss are unknown, never retried',async()=>{
 const variants=[()=>Response.json({}),()=>Response.json(null),()=>Response.json({errcode:'0'}),()=>new Response('not json'),()=>new Response('',{status:500}),()=>new Response('',{status:302}),()=>{throw Error('private-upstream access_token=secret-test');}];
 for(const response of variants){let calls=0;const fetcher:typeof fetch=async(input)=>{calls++;return String(input).endsWith('/stable_token')?Response.json({access_token:'test_token',expires_in:7200}):response();};await assert.rejects(()=>new WechatSubscriptionClient(credentials(),fetcher).send('safe'),failure('unknown'));assert.equal(calls,2);}
});
test('deadline covers stalled response body, not just fetch headers; token timeout is not_sent',async()=>{
 const stalled=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));
 for(const tokenStalls of [true,false]){let calls=0;const fetcher:typeof fetch=async(input)=>{calls++;return String(input).endsWith('/stable_token')&&!tokenStalls?Response.json({access_token:'test_token',expires_in:7200}):stalled();};await assert.rejects(()=>new WechatSubscriptionClient(credentials(),fetcher,{timeoutMs:40}).send('safe'),failure(tokenStalls?'not_sent':'unknown'));assert.equal(calls,tokenStalls?1:2);}
});
test('upstream response body limit fails closed before unbounded parsing',async()=>{
 const fetcher:typeof fetch=async(input)=>String(input).endsWith('/stable_token')?Response.json({access_token:'test_token',expires_in:7200}):new Response(' '.repeat(65537));await assert.rejects(()=>new WechatSubscriptionClient(credentials(),fetcher).send('safe'),failure('unknown'));
});
