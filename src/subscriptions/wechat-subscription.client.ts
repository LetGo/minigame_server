import {buildCheckinMessage,type MiniprogramState} from './checkin-template.js';
export {buildCheckinMessage,CHECKIN_TEMPLATE_ID} from './checkin-template.js';
type Outcome='not_sent'|'rejected'|'unknown';
export class SubscriptionDeliveryError extends Error {
 constructor(public readonly outcome:Outcome,public readonly code:number|null=null){super('SUBSCRIPTION_DELIVERY_'+outcome.toUpperCase());this.name='SubscriptionDeliveryError';}
}
/** Fixed WeChat endpoints, bounded body+deadline, no forced token refresh or send retry. */
export class WechatSubscriptionClient {
 #credentials:{appId:string;appSecret:string};
 #state:MiniprogramState;
 #fetcher:typeof fetch;
 #now:()=>number;
 #timeoutMs:number;
 #cache:{token:string;expiresAt:number}|undefined;
 #pending:Promise<string>|undefined;
 constructor(credentials:{appId:string;appSecret:string;subscribeMiniprogramState?:MiniprogramState},fetcher:typeof fetch=globalThis.fetch,options:{now?:()=>number;timeoutMs?:number}={}){
  this.#credentials={appId:credentials.appId,appSecret:credentials.appSecret};this.#fetcher=fetcher;this.#now=options.now??Date.now;this.#timeoutMs=options.timeoutMs??5000;
  this.#state=credentials.subscribeMiniprogramState??'trial';
  if(this.#state!=='trial'&&this.#state!=='formal')throw new SubscriptionDeliveryError('not_sent');
  if(!Number.isInteger(this.#timeoutMs)||this.#timeoutMs<1||this.#timeoutMs>5000)throw new SubscriptionDeliveryError('not_sent');
 }
 async send(openid:string,page='index'):Promise<void>{
  let payload:ReturnType<typeof buildCheckinMessage>;
  try{payload=buildCheckinMessage(openid,page,this.#state);}catch{throw new SubscriptionDeliveryError('not_sent');}
  let token:string;try{token=await this.#stableToken();}catch{throw new SubscriptionDeliveryError('not_sent');}
  let data:unknown;
  try{data=await this.#request('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token='+encodeURIComponent(token),payload);}catch{throw new SubscriptionDeliveryError('unknown');}
  if(!isObject(data)||typeof data.errcode!=='number'||!Number.isInteger(data.errcode)||data.errcode< -2147483648||data.errcode>2147483647)throw new SubscriptionDeliveryError('unknown');
  if(data.errcode!==0)throw new SubscriptionDeliveryError('rejected',data.errcode);
 }
 async #stableToken():Promise<string>{
  if(this.#cache&&this.#cache.expiresAt>this.#now())return this.#cache.token;
  if(this.#pending)return this.#pending;
  this.#pending=this.#newToken();
  try{return await this.#pending;}finally{this.#pending=undefined;}
 }
 async #newToken():Promise<string>{
  const started=this.#now(),data=await this.#request('https://api.weixin.qq.com/cgi-bin/stable_token',{grant_type:'client_credential',appid:this.#credentials.appId,secret:this.#credentials.appSecret,force_refresh:false});
  if(!isObject(data)||typeof data.access_token!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(data.access_token)||typeof data.expires_in!=='number'||!Number.isInteger(data.expires_in)||data.expires_in<=0||data.expires_in>7200||(data.errcode!==undefined&&data.errcode!==0))throw new SubscriptionDeliveryError('not_sent');
  const margin=Math.min(30,data.expires_in/10);this.#cache={token:data.access_token,expiresAt:started+(data.expires_in-margin)*1000};return data.access_token;
 }
 async #request(url:string,payload:unknown):Promise<unknown>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('SUBSCRIPTION_UPSTREAM_TIMEOUT'));},this.#timeoutMs);});
  const operation=(async()=>{
   const response=await this.#fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:controller.signal});
   if(!response.ok||!response.body)throw new Error('SUBSCRIPTION_UPSTREAM_INVALID');
   const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
   try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>65536)throw new Error('SUBSCRIPTION_UPSTREAM_OVERSIZE');text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();return JSON.parse(text) as unknown;}
   finally{void reader.cancel().catch(()=>{});}
  })();
  try{return await Promise.race([operation,deadline]);}finally{if(timer)clearTimeout(timer);controller.abort();}
 }
}
function isObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
