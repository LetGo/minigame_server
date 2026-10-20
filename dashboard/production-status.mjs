// Read-only production status collector for the authenticated dashboard.
// Fixed allowlisted sources only: three root .env flags, the root leaderboard minimums,
// three fixed systemd units, one localhost login probe, one readonly PG SELECT 1 and one Redis PING.
// Nothing here writes, restarts, sends, or reads arbitrary environment/paths.
import {readFile as readFileDefault} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {join} from 'node:path';

export const PRODUCTION_ROOT='/home/ubuntu/.hermes/workspace/projects/minigame_server';
export const CHECKIN_TEMPLATE_ID='2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4';
export const UNITS=Object.freeze({api:'minigame-login.service',timer:'minigame-production-checkin.timer',worker:'minigame-production-checkin.service'});
export const PROBE_URL='http://127.0.0.1:18740/h5login/api/auth/wechat-login';
// Fixed child environment: systemd then renders timestamps in UTC only, never ambiguous local labels.
export const SYSTEMD_ENV=Object.freeze({TZ:'UTC',LC_ALL:'C'});
const BOUND_MS=2000,TTL_MS=10000,REFRESH_SECONDS=30,BODY_LIMIT=4096;
// Receipts aggregation is bounded by the dashboard pool's own 5s statement timeout.
const SQL_BOUND_MS=5000;
const MISSING_CODE_MESSAGE='code must be a string';
const ENV_KEYS=['SUBSCRIBE_MESSAGES_ENABLED','PRODUCTION_DAILY_CHECKIN_ENABLED','SUBSCRIBE_MINIPROGRAM_STATE'];

const iso=value=>{
 if(value===null||value===undefined)return null;
 const date=value instanceof Date?value:new Date(value);
 return Number.isFinite(date.getTime())?date.toISOString():null;
};
// systemd is invoked with TZ=UTC, so only an explicit "UTC" timestamp or "@epoch" is accepted.
// Any other zone label (CST, local abbreviations) is treated as unparseable, never guessed.
const utcStamp=/^[A-Z][a-z]{2} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/;
const epochStamp=/^@(\d{1,12})$/;
export function parseSystemdTime(value){
 const raw=text(value).trim();
 if(!raw)return null;
 const epoch=epochStamp.exec(raw);
 if(epoch){const ms=Number(epoch[1])*1000;return Number.isFinite(ms)?new Date(ms).toISOString():null;}
 const match=utcStamp.exec(raw);
 if(!match)return null;
 const [,year,month,day,hour,minute,second]=match.map(part=>part===undefined?part:Number(part));
 const ms=Date.UTC(year,month-1,day,hour,minute,second);
 const date=new Date(ms);
 if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day
  ||date.getUTCHours()!==hour||date.getUTCMinutes()!==minute||date.getUTCSeconds()!==second)return null;
 return date.toISOString();
}
const bounded=(promise,ms=BOUND_MS)=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('BOUNDED_OPERATION_TIMEOUT')),ms);
 promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
});
const text=value=>Buffer.isBuffer(value)?value.toString('utf8'):String(value??'');

function defaultSystemctl(args){
 return new Promise(resolve=>{
  try{
   execFile('/usr/bin/systemctl',args,{timeout:BOUND_MS,killSignal:'SIGKILL',maxBuffer:65536,encoding:'utf8',windowsHide:true,env:{...process.env,...SYSTEMD_ENV}},(error,stdout)=>{
    resolve({exitCode:error?(typeof error.code==='number'?error.code:-1):0,stdout:text(stdout)});
   });
 }catch{resolve({exitCode:-1,stdout:''});}
});
}

function parseProperties(stdout){
 const map=new Map();
 for(const line of text(stdout).split('\n')){
  const at=line.indexOf('=');if(at<1)continue;
  map.set(line.slice(0,at),line.slice(at+1));
 }
 return map;
}

// The login probe only ever sends an empty body: a healthy API must reject it before WeChat is
// contacted. Only the Nest missing-`code` validation rejection counts; nothing is surfaced.
async function probeAccepted(response){
 if(Number(response?.status)!==400)return false;
 const type=String(response?.headers?.get?.('content-type')??'');
 if(!/^application\/json\b/i.test(type))return false;
 if(typeof response.text!=='function')return false;
 const raw=await response.text();
 if(typeof raw!=='string'||raw.length>BODY_LIMIT)return false;
 let parsed;
 try{parsed=JSON.parse(raw);}catch{return false;}
 if(!parsed||typeof parsed!=='object')return false;
 if(!Array.isArray(parsed.message)||!parsed.message.includes(MISSING_CODE_MESSAGE))return false;
 return parsed.statusCode===undefined||parsed.statusCode===400;
}

export function parseEnvFlags(source){
 const found=new Map();
 for(const line of text(source).split('\n')){
  const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#'))continue;
  const at=trimmed.indexOf('=');if(at<1)continue;
  const key=trimmed.slice(0,at).trim();if(!ENV_KEYS.includes(key))continue;
  let value=trimmed.slice(at+1).trim();
  if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
  found.set(key,value);
 }
 return found;
}

export function leaderboardMinimums(source){
 const match=/MINIMUM\s*=\s*\{\s*stage\s*:\s*(\d+)\s*,\s*boss\s*:\s*(\d+)\s*\}/.exec(text(source));
 return match?{stageMinimum:Number(match[1]),bossMinimum:Number(match[2])}:{stageMinimum:null,bossMinimum:null};
}

export function createProductionStatus({root=PRODUCTION_ROOT,files={readFile:readFileDefault},systemctl=defaultSystemctl,fetch=globalThis.fetch,pool,redis,appId,now=Date.now,ttlMs=TTL_MS}={}){
 if(typeof pool?.query!=='function'||typeof redis?.withCommandOptions!=='function'||typeof appId!=='string'||!appId)throw new Error('Invalid production status configuration');
 let entry=null,pending=null;

 async function readFlags(){
  try{
   const parsed=parseEnvFlags(await bounded(files.readFile(join(root,'.env'),'utf8')));
   const send=parsed.get('SUBSCRIBE_MESSAGES_ENABLED'),checkin=parsed.get('PRODUCTION_DAILY_CHECKIN_ENABLED'),state=parsed.get('SUBSCRIBE_MINIPROGRAM_STATE');
   const flag=value=>value==='true'?true:value==='false'?false:null;
   const a=flag(send),b=flag(checkin);
   return {
    enabled:a===false||b===false?false:a===true&&b===true?true:null,
    jumpState:state==='formal'?'formal':state==='trial'?'trial':'unknown',
   };
  }catch{return {enabled:null,jumpState:'unknown'};}
 }

 async function readMinimums(){
  try{return leaderboardMinimums(await bounded(files.readFile(join(root,'dist/leaderboards/leaderboards.service.js'),'utf8')));}
  catch{return {stageMinimum:null,bossMinimum:null};}
 }

 async function apiProbe(){
  const [service,probe]=await Promise.all([
   (async()=>{
    try{
     const out=await bounded(systemctl(['show',UNITS.api,'--property=ActiveState,SubState']));
     if(out.exitCode!==0)return {serviceActive:null};
     const props=parseProperties(out.stdout);
     if(!props.has('ActiveState'))return {serviceActive:null};
     return {serviceActive:props.get('ActiveState')==='active'};
    }catch{return {serviceActive:null};}
   })(),
   (async()=>{
    try{
     const response=await bounded(fetch(PROBE_URL,{method:'POST',headers:{'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(BOUND_MS)}));
     const probeOk=await bounded(probeAccepted(response));
     try{await response?.body?.cancel?.();}catch{}
     return {probeOk};
    }catch{return {probeOk:null};}
   })(),
  ]);
  const serviceActive=service.serviceActive??null,probeOk=probe.probeOk??null;
  const state=serviceActive===null||probeOk===null?'unknown':serviceActive&&probeOk?'ok':'error';
  return {state,serviceActive,probeOk};
 }

 async function databaseProbe(){
  try{
   const result=await bounded(pool.query('SELECT 1 AS ok'));
   return {state:Number(result?.rows?.[0]?.ok)===1?'ok':'error'};
  }catch{return {state:'unknown'};}
 }

 async function redisProbe(){
  try{
   const reply=await bounded(redis.withCommandOptions({abortSignal:AbortSignal.timeout(BOUND_MS)}).ping());
   return {state:String(reply)==='PONG'?'ok':'error'};
  }catch{return {state:'unknown'};}
 }

 async function scheduleProbe(){
  let enabled=null,active=null,nextRunAt=null,lastTriggerAt=null,workerResult=null,exitCode=null;
  const [timer,worker]=await Promise.all([
   (async()=>{
    try{
     const out=await bounded(systemctl(['show',UNITS.timer,'--property=ActiveState,SubState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec']));
     if(out.exitCode!==0)return null;
     return parseProperties(out.stdout);
    }catch{return null;}
   })(),
   (async()=>{
    try{
     const out=await bounded(systemctl(['show',UNITS.worker,'--timestamp=unix','--property=ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp']));
     if(out.exitCode!==0)return null;
     return parseProperties(out.stdout);
    }catch{return null;}
   })(),
  ]);
  if(timer){
   const nextRaw=(timer.get('NextElapseUSecRealtime')??'').trim();
   const lastRaw=(timer.get('LastTriggerUSec')??'').trim();
   nextRunAt=nextRaw?parseSystemdTime(nextRaw):null;
   lastTriggerAt=lastRaw?parseSystemdTime(lastRaw):null;
   // A nonempty but unreadable timestamp means unreadable schedule state, never "never triggered".
   if((nextRaw&&nextRunAt===null)||(lastRaw&&lastTriggerAt===null))return {enabled:null,active:null,nextRunAt:null,lastTriggerAt:null,workerResult:null,exitCode:null};
   const unitFileState=timer.get('UnitFileState');
   enabled=unitFileState==='enabled'?true:unitFileState==='disabled'||unitFileState==='masked'?false:null;
   const state=timer.get('ActiveState');
   active=state==='active'?true:state==='inactive'||state==='failed'?false:null;
  }
  if(worker){
   const startedAt=worker.get('ExecMainStartTimestamp')??'';
   const startedIso=parseSystemdTime(startedAt);
   // ExecMainStartTimestamp is a process start (manual or timer). Only the timer's own
   // LastTriggerUSec may populate lastTriggerAt, so a manual warm-up is never a scheduled run.
   if(startedIso){
    workerResult=worker.get('Result')??null;
    const status=Number(worker.get('ExecMainStatus'));
    exitCode=Number.isInteger(status)?status:null;
   }
  }
  return {enabled,active,nextRunAt,lastTriggerAt,workerResult,exitCode};
 }

 async function receiptsProbe(){
  const sql=`WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at),
   win AS (
    SELECT (at AT TIME ZONE 'Asia/Shanghai')::date AS day,
      (((at AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai') AS starts,
      ((((at AT TIME ZONE 'Asia/Shanghai')::date + 1))::timestamp AT TIME ZONE 'Asia/Shanghai') AS ends
    FROM moment
   )
   SELECT json_build_object(
    'today',(SELECT json_build_object(
       'total',count(*)::int,
       'sent',count(*) FILTER (WHERE s.state='sent')::int,
       'failed',count(*) FILTER (WHERE s.state='failed')::int,
       'unknown',count(*) FILTER (WHERE s.state='unknown')::int,
       'sending',count(*) FILTER (WHERE s.state='sending')::int)
     FROM game_subscription_sends s CROSS JOIN win w
     WHERE s.app_id=$1 AND s.template_id=$2 AND s.started_at>=w.starts AND s.started_at<w.ends),
    'last',(SELECT json_build_object('state',s.state,'startedAt',s.started_at,'finishedAt',s.finished_at,
       'scheduledDate',s.scheduled_date::text,'upstreamCode',s.upstream_code)
     FROM game_subscription_sends s
     WHERE s.app_id=$1 AND s.template_id=$2
     ORDER BY s.started_at DESC,s.request_id DESC LIMIT 1)
   ) AS result`;
  try{
   const result=await bounded(pool.query(sql,[appId,CHECKIN_TEMPLATE_ID]),SQL_BOUND_MS);
   const value=result?.rows?.[0]?.result;
   if(!value||typeof value!=='object')return {available:false,today:null,last:null};
   const today=value.today;
   const last=value.last&&typeof value.last==='object'?{
    state:['sent','failed','unknown','sending'].includes(value.last.state)?value.last.state:'unknown',
    startedAt:iso(value.last.startedAt),
    finishedAt:iso(value.last.finishedAt),
    scheduledDate:typeof value.last.scheduledDate==='string'?value.last.scheduledDate:null,
    upstreamCode:Number.isInteger(value.last.upstreamCode)?value.last.upstreamCode:null,
   }:null;
   // Partial or malformed aggregates are unavailable, never coerced into fabricated zeros.
   const counts=['total','sent','failed','unknown','sending'];
   const complete=!!today&&typeof today==='object'&&counts.every(key=>Number.isInteger(today[key])&&today[key]>=0)
    &&today.total===today.sent+today.failed+today.unknown+today.sending;
   if(!complete)return {available:false,today:null,last:null};
   return {available:true,today:{total:today.total,sent:today.sent,failed:today.failed,unknown:today.unknown,sending:today.sending},last};
  }catch{return {available:false,today:null,last:null};}
 }

 async function collect(){
  const [api,database,redisState,flagsValue,minimums,schedule,receipts]=await Promise.all([
   apiProbe(),databaseProbe(),redisProbe(),readFlags(),readMinimums(),scheduleProbe(),receiptsProbe(),
  ]);
  return {
   environment:'production',
   checkedAt:new Date(now()).toISOString(),
   refreshSeconds:REFRESH_SECONDS,
   api,database,redis:redisState,
   subscriptions:{enabled:flagsValue.enabled,jumpState:flagsValue.jumpState,schedule,receipts},
   leaderboards:minimums,
  };
 }

 return async function productionStatus(){
  // A fresh failure must surface as a sanitized failure: never a stale healthy snapshot.
  try{
   const at=now();
   if(!Number.isFinite(at))throw new Error('Invalid production status clock');
   if(entry&&at>=entry.startedAt&&at<entry.expiresAt)return entry.value;
   if(!pending){
    entry=null;
    const startedAt=at;
    pending=collect().then(value=>{
     const checkedAt=Date.parse(value?.checkedAt);
     if(!value||!Number.isFinite(checkedAt))throw new Error('Invalid production status snapshot');
     const finishedAt=now();
     if(finishedAt>=startedAt&&finishedAt<startedAt+ttlMs)entry={startedAt,expiresAt:startedAt+ttlMs,value};
     return value;
    }).finally(()=>{pending=null;});
   }
   return await pending;
  }catch{throw new Error('PRODUCTION_STATUS_UNAVAILABLE');}
 };
}
