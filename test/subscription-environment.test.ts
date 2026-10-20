import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {loadConfig,type AppConfig} from '../src/config.js';
import {buildCheckinMessage,CHECKIN_TEMPLATE_ID} from '../src/subscriptions/checkin-template.js';
import {WechatSubscriptionClient,SubscriptionDeliveryError} from '../src/subscriptions/wechat-subscription.client.js';
import {SubscriptionsService} from '../src/subscriptions/subscriptions.service.js';

const valid={WECHAT_APP_ID:'wx0123456789abcdef',WECHAT_APP_SECRET:'test-only-secret',DATABASE_URL:'postgresql://user:pass@127.0.0.1/test',REDIS_URL:'redis://127.0.0.1:6379/0'};

test('configuration defaults the subscription jump state to trial and accepts only explicit formal',()=>{
 const base=loadConfig(valid);
 assert.equal(base.subscribeMiniprogramState,'trial');
 assert.equal(loadConfig({...valid,SUBSCRIBE_MINIPROGRAM_STATE:'trial'}).subscribeMiniprogramState,'trial');
 assert.equal(loadConfig({...valid,SUBSCRIBE_MINIPROGRAM_STATE:'formal'}).subscribeMiniprogramState,'formal');
 for(const value of ['','release','production','FORMAL','Formal',' formal','formal ','true','0'])
  assert.throws(()=>loadConfig({...valid,SUBSCRIBE_MINIPROGRAM_STATE:value}),/SUBSCRIBE_MINIPROGRAM_STATE/);
});

test('check-in message defaults to trial, accepts formal, and rejects any other jump state',()=>{
 assert.equal(buildCheckinMessage('openid_abc-def').miniprogram_state,'trial');
 assert.equal(buildCheckinMessage('openid_abc-def','index?from=checkin').miniprogram_state,'trial');
 const formal=buildCheckinMessage('openid_abc-def','index?from=checkin','formal');
 assert.equal(formal.miniprogram_state,'formal');
 assert.equal(formal.template_id,CHECKIN_TEMPLATE_ID);
 assert.equal(formal.page,'index?from=checkin');
 assert.deepEqual(formal.data,{phrase1:{value:'未签到'},thing10:{value:'签到领海量奖励'},thing5:{value:'您的猫咪提示您有海量钻石待领取'}});
 for(const value of [null,0,{},'release','production','FORMAL','Formal',' formal','formal ',true])
  assert.throws(()=>buildCheckinMessage('safe','index',value as never),/miniprogram_state/i);
});

test('transport sends the configured jump state in the actual captured message body',async()=>{
 async function sentBody(credentials:{appId:string;appSecret:string;subscribeMiniprogramState?:string}){
  const bodies:Record<string,unknown>[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
   if(String(input).endsWith('/stable_token'))return Response.json({access_token:'test_token',expires_in:7200});
   bodies.push(JSON.parse(init!.body as string));return Response.json({errcode:0,errmsg:'ok'});
  };
  await new WechatSubscriptionClient(credentials as {appId:string;appSecret:string},fetcher).send('openid_abc-def','index?from=checkin');
  assert.equal(bodies.length,1);return bodies[0]!;
 }
 const credentials={appId:'wx0123456789abcdef',appSecret:'test-only-secret'};
 assert.deepEqual(await sentBody(credentials),buildCheckinMessage('openid_abc-def','index?from=checkin'));
 assert.equal((await sentBody(credentials)).miniprogram_state,'trial');
 const formal=await sentBody({...credentials,subscribeMiniprogramState:'formal'});
 assert.deepEqual(formal,buildCheckinMessage('openid_abc-def','index?from=checkin','formal'));
 assert.equal(formal.miniprogram_state,'formal');
});

test('production composition: loadConfig formal reaches the actual send body through WechatSubscriptionClient',async()=>{
 const bodies:Record<string,unknown>[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  if(String(input).endsWith('/stable_token'))return Response.json({access_token:'test_token',expires_in:7200});
  bodies.push(JSON.parse(init!.body as string));return Response.json({errcode:0,errmsg:'ok'});
 };
 const config=loadConfig({...valid,SUBSCRIBE_MINIPROGRAM_STATE:'formal'});
 assert.equal(config.subscribeMiniprogramState,'formal');
 const client=new WechatSubscriptionClient(config,fetcher);
 await client.send('openid_abc-def','index?from=checkin');
 assert.equal(bodies.length,1);
 const body=bodies[0]!;
 assert.equal(body.miniprogram_state,config.subscribeMiniprogramState);
 assert.equal(body.miniprogram_state,'formal');
 assert.equal(body.template_id,CHECKIN_TEMPLATE_ID);

 bodies.length=0;
 const trialConfig=loadConfig(valid);
 assert.equal(trialConfig.subscribeMiniprogramState,'trial');
 await new WechatSubscriptionClient(trialConfig,fetcher).send('openid_abc-def','index?from=checkin');
 assert.equal(bodies.length,1);
 assert.equal(bodies[0]!.miniprogram_state,trialConfig.subscribeMiniprogramState);
 assert.equal(bodies[0]!.miniprogram_state,'trial');
});

test('transport refuses an invalid jump state before any network call',()=>{
 let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error('must not call');};
 for(const state of ['release','','FORMAL',' formal']){
  assert.throws(()=>new WechatSubscriptionClient({appId:'wx0123456789abcdef',appSecret:'test-only-secret',subscribeMiniprogramState:state as never},fetcher),
   (error:unknown)=>error instanceof SubscriptionDeliveryError&&error.outcome==='not_sent');
 }
 assert.equal(calls,0);
});

function serviceFixture(state:'trial'|'formal'|undefined){
 const token=randomBytes(32).toString('base64url');
 const userId='11111111-1111-4111-8111-111111111111';
 const config={...loadConfig(valid),...state?{subscribeMiniprogramState:state}:{}} as AppConfig;
 const redis={withCommandOptions:()=>({get:async()=>JSON.stringify({appId:config.appId,userId}),eval:async()=>[1,60]})};
 const pool={query:async()=>({rowCount:1,rows:[{id:userId}]})};
 const request={query:{},body:{},get:(name:string)=>name.toLowerCase()==='authorization'?'Bearer '+token:undefined};
 return new SubscriptionsService(config,{redis,pool} as never).template(request as never);
}

test('template response reports the configured jump state and matches the outbound payload',async()=>{
 const formal=await serviceFixture('formal');
 assert.equal(formal.miniprogramState,'formal');
 assert.equal(formal.templateId,CHECKIN_TEMPLATE_ID);
 assert.deepEqual(formal.data,buildCheckinMessage('preview_only','index','formal').data);
 const trial=await serviceFixture('trial');
 assert.equal(trial.miniprogramState,'trial');
 const fallback=await serviceFixture(undefined);
 assert.equal(fallback.miniprogramState,'trial');
 assert.deepEqual(fallback.data,buildCheckinMessage('preview_only').data);
});
