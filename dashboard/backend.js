import {isCanonicalSaveRepairJson} from './save-repair.mjs';
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {join} from 'node:path';import {promisify} from 'node:util';import {scrypt,randomBytes,createHash,timingSafeEqual} from 'node:crypto';import {isIP} from 'node:net';
import {createOverviewCache} from './overview-cache.mjs';
const derive=promisify(scrypt),cookieName='__Secure-minigame-dashboard';
const csp="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
class Failure extends Error{constructor(status,message){super(message);this.status=status;}}
function fail(status,message){throw new Failure(status,message);}
function hash(value){return createHash('sha256').update(value).digest('hex');}
export function createDashboardServer({pool,redis,config,queries,productionStatus,saveRepair,retentionReport,staticDir=fileURLToPath(new URL('./public/',import.meta.url)),loginRateLimit=5,overviewClock=Date.now}){
 if(!pool||!redis||!queries?.overview||!queries?.player||!config?.username||!/^https:\/\//.test(config.origin??'')||!/^([a-f0-9]{32}):([a-f0-9]{128})$/.test(config.passwordHash??''))throw new Error('Invalid dashboard configuration');
 const base=config.basePath??'/h5dashboard/';if(!/^\/[a-z0-9-]+\/$/.test(base))throw new Error('Invalid dashboard path');
 const redisCall=()=>redis.withCommandOptions({abortSignal:AbortSignal.timeout(3000)});
 const overview=createOverviewCache({appId:config.appId,load:appId=>queries.overview(pool,appId),now:overviewClock});
 let passwordJobs=0;
 const headers={'Cache-Control':'no-store','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
 const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const key=token=>'minigame:dashboard:session:'+hash(token);
 async function session(req){const parts=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));if(parts.length!==1)fail(401,'DASHBOARD_LOGIN_REQUIRED');const token=parts[0].slice(cookieName.length+1);if(!/^[A-Za-z0-9_-]{43}$/.test(token)||Buffer.from(token,'base64url').toString('base64url')!==token)fail(401,'DASHBOARD_LOGIN_REQUIRED');const raw=await redisCall().get(key(token));let value;try{value=JSON.parse(raw??'null');}catch{fail(401,'DASHBOARD_LOGIN_REQUIRED');}if(value?.username!==config.username)fail(401,'DASHBOARD_LOGIN_REQUIRED');return {token,username:value.username};}
 async function body(req,limit=8192,validateText){if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))fail(415,'JSON_REQUIRED');if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')fail(415,'UNSUPPORTED_ENCODING');if(Number(req.headers['content-length']??0)>limit){req.resume();fail(413,'REQUEST_TOO_LARGE');}const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit){req.resume();fail(413,'REQUEST_TOO_LARGE');}chunks.push(chunk);}let value;const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))fail(400,'INVALID_JSON');try{value=JSON.parse(text);}catch{fail(400,'INVALID_JSON');}if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'INVALID_REQUEST');if(validateText&&!validateText(text))fail(400,'SAVE_REPAIR_INVALID_REQUEST');return value;}
 const server=createServer(async(req,res)=>{
  for(const [name,value]of Object.entries(headers))res.setHeader(name,value);
  try{
   const url=req.url??'';if(!url.startsWith(base)||url.includes('?')||url.includes('#'))fail(404,'NOT_FOUND');const path=url.slice(base.length),method=req.method;
   if(method==='GET'&&['','index.html','app.js','style.css'].includes(path)){const name=path||'index.html';let data;try{data=await readFile(join(staticDir,name));}catch{fail(404,'NOT_FOUND');}res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});res.end(data);return;}
   const valid=(method==='GET'&&['api/me','api/overview','api/production-status','api/retention-report'].includes(path))||(method==='POST'&&['api/login','api/logout','api/player','api/login-logs','api/video-ranking','api/yesterday-analysis','api/save-repair/lookup','api/save-repair/preview','api/save-repair/apply'].includes(path));if(!valid)fail(404,'NOT_FOUND');
   if(method==='POST'&&req.headers.origin!==config.origin)fail(403,'ORIGIN_FORBIDDEN');
   if(path==='api/login'){
    const remote=req.socket.remoteAddress??'unknown';const forwarded=req.headers['x-real-ip'];const ip=config.trustLocalProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:remote;
    const n=await redisCall().eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n",{keys:['minigame:dashboard:login-rate:'+hash(ip)],arguments:[]});
    if(Number(n)>loginRateLimit||passwordJobs>=2){res.setHeader('Retry-After','60');fail(429,'DASHBOARD_RATE_LIMITED');}
    const input=await body(req,2048);if(Object.keys(input).sort().join(',')!=='password,username'||typeof input.username!=='string'||input.username.length>64||typeof input.password!=='string'||input.password.length>512)fail(400,'INVALID_REQUEST');
    const [salt,expected]=config.passwordHash.split(':');let computed;passwordJobs++;try{computed=await derive(input.password,salt,64);}finally{passwordJobs--;}
    if(!timingSafeEqual(computed,Buffer.from(expected,'hex'))||input.username!==config.username)fail(401,'DASHBOARD_CREDENTIALS_INVALID');
    const token=randomBytes(32).toString('base64url');const stored=await redisCall().set(key(token),JSON.stringify({username:config.username,issuedAt:new Date().toISOString()}),{EX:28800,NX:true});if(stored!=='OK')fail(503,'DASHBOARD_UNAVAILABLE');
    res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=${base}; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);reply(res,200,{authenticated:true,username:config.username});return;
   }
   const actor=await session(req);
   if(path==='api/me'){reply(res,200,{authenticated:true,username:actor.username,environment:config.environment??'production'});return;}
   if(path==='api/overview'){reply(res,200,await overview());return;}
   // Stored aggregate snapshot only: this route never starts a DB query or report job.
   if(path==='api/retention-report'){if(typeof retentionReport!=='function')fail(503,'RETENTION_REPORT_UNAVAILABLE');let snapshot;try{snapshot=await retentionReport();}catch{fail(503,'RETENTION_REPORT_UNAVAILABLE');}if(!snapshot||snapshot.appId!==config.appId)fail(503,'RETENTION_REPORT_UNAVAILABLE');reply(res,200,snapshot);return;}
   // Read-only, authenticated after the session check; no loader means fail closed.
   if(path==='api/production-status'){if(typeof productionStatus!=='function')fail(503,'PRODUCTION_STATUS_UNAVAILABLE');let snapshot;try{snapshot=await productionStatus();}catch{snapshot=null;}if(!snapshot)fail(503,'PRODUCTION_STATUS_UNAVAILABLE');reply(res,200,snapshot);return;}
   if(path==='api/logout'){const input=await body(req);if(Object.keys(input).length)fail(400,'INVALID_REQUEST');await redisCall().del(key(actor.token));res.setHeader('Set-Cookie',`${cookieName}=; Path=${base}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);reply(res,200,{authenticated:false});return;}
   if(path==='api/login-logs'){const input=await body(req);if(Object.keys(input).some(k=>!['offset','date'].includes(k)))fail(400,'INVALID_REQUEST');const offset=input.offset===undefined?0:input.offset;if(!Number.isInteger(offset)||offset<0||offset>10000000)fail(400,'INVALID_REQUEST');const date=input.date===undefined?null:input.date;if(date!==null||Object.hasOwn(input,'date')){if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.startsWith('0000-'))fail(400,'INVALID_REQUEST');const stamp=new Date(date+'T00:00:00.000Z');if(!Number.isFinite(stamp.getTime())||stamp.toISOString().slice(0,10)!==date)fail(400,'INVALID_REQUEST');}reply(res,200,await queries.loginLogs(pool,config.appId,offset,date));return;}
   if(path==='api/video-ranking'){if(typeof queries.videoRanking!=='function')fail(503,'VIDEO_RANKING_UNAVAILABLE');const input=await body(req);if(Object.keys(input).some(k=>k!=='date'))fail(400,'INVALID_REQUEST');let date=null;if(Object.hasOwn(input,'date')){const value=input.date;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000-'))fail(400,'INVALID_REQUEST');const stamp=new Date(value+'T00:00:00.000Z');if(!Number.isFinite(stamp.getTime())||stamp.toISOString().slice(0,10)!==value)fail(400,'INVALID_REQUEST');date=value;}reply(res,200,await queries.videoRanking(pool,config.appId,date));return;}
   // 昨日用户分析: read-only, app-scoped from config, empty body only; no loader means fail closed.
   if(path==='api/yesterday-analysis'){if(typeof queries.yesterdayAnalysis!=='function')fail(503,'YESTERDAY_ANALYSIS_UNAVAILABLE');const input=await body(req);if(Object.keys(input).length)fail(400,'INVALID_REQUEST');const snapshot=await queries.yesterdayAnalysis(pool,config.appId);if(!snapshot)fail(503,'YESTERDAY_ANALYSIS_UNAVAILABLE');reply(res,200,snapshot);return;}
   if(path.startsWith('api/save-repair/')){
    const operation=path.slice('api/save-repair/'.length);
    if(operation==='apply'&&config.saveRepairEnabled!==true)fail(403,'SAVE_REPAIR_DISABLED');
    if(typeof saveRepair?.[operation]!=='function')fail(503,'SAVE_REPAIR_UNAVAILABLE');
    const input=await body(req,8192,isCanonicalSaveRepairJson);
    let result;
    try{result=operation==='apply'?await saveRepair.apply(input,actor.username):await saveRepair[operation](input);}
    catch(error){
     const safe={SAVE_REPAIR_DISABLED:403,SAVE_REPAIR_INVALID_REQUEST:400,SAVE_REPAIR_INVALID_SAVE:422,SAVE_REPAIR_INVALID_LEDGER:422,SAVE_REPAIR_DIAMOND_OVERFLOW:400,SAVE_REPAIR_NO_SAVE:404,SAVE_REPAIR_VERSION_CONFLICT:409,SAVE_REPAIR_REQUEST_CONFLICT:409,SAVE_REPAIR_NO_CHANGES:400,PLAYER_NOT_FOUND:404,INVALID_OPENID:400};
     if(Object.hasOwn(safe,error?.message??''))fail(safe[error.message],error.message);
     throw error;
    }
    reply(res,200,result);return;
   }
   const input=await body(req);let record;
   if(Object.keys(input).join(',')==='uid'){
    if(typeof input.uid!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.uid))fail(400,'INVALID_UID');
    record=await queries.player(pool,config.appId,input.uid,'uid');
   }else{
    if(Object.keys(input).join(',')!=='openid'||typeof input.openid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.openid))fail(400,'INVALID_OPENID');
    record=await queries.player(pool,config.appId,input.openid);
   }
   if(!record)fail(404,'PLAYER_NOT_FOUND');reply(res,200,record);
  }catch(error){if(!res.headersSent)reply(res,error instanceof Failure?error.status:503,{message:error instanceof Failure?error.message:'DASHBOARD_UNAVAILABLE'});else res.end();}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;
 return server;
}
