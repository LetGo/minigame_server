import {createHash} from 'node:crypto';

export class SaveRepairError extends Error {
 constructor(status,message){super(message);this.name='SaveRepairError';this.status=status;}
}
const fail=(status,message)=>{throw new SaveRepairError(status,message);};
const invalidSave=()=>fail(422,'SAVE_REPAIR_INVALID_SAVE');
const invalidRequest=()=>fail(400,'SAVE_REPAIR_INVALID_REQUEST');
const keys=['Is_Remove_AD_All','Dia','_getDia','_useDia'];
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const digest=data=>createHash('sha256').update(data).digest('hex');
const INT32_MAX=2147483647;
const nonnegativeInt32=value=>Number.isSafeInteger(value)&&value>=0&&value<=INT32_MAX;
function validateDiamondLedger(fields){
 if(!['Dia','_getDia','_useDia'].every(key=>nonnegativeInt32(fields[key]))||fields._getDia%3!==0||fields._useDia%3!==0||fields._getDia/3-fields._useDia/3!==fields.Dia)fail(422,'SAVE_REPAIR_INVALID_LEDGER');
}
function compensateDiamonds(before,amount){
 validateDiamondLedger(before);
 const incomeDelta=amount*3,Dia=before.Dia+amount,_getDia=before._getDia+incomeDelta;
 if(!Number.isSafeInteger(incomeDelta)||!Number.isSafeInteger(Dia)||!Number.isSafeInteger(_getDia)||!nonnegativeInt32(Dia)||!nonnegativeInt32(_getDia))fail(400,'SAVE_REPAIR_DIAMOND_OVERFLOW');
 const after={...before,Dia,_getDia};validateDiamondLedger(after);return after;
}

// Validate JSON without serializing it. Record root value spans to leave all
// unrelated bytes (including large numbers, escaped keys and whitespace) intact.
function rootSpans(data){
 if(typeof data!=='string'||Buffer.byteLength(data)>65536||Buffer.from(data).toString('utf8')!==data)invalidSave();
 let parsed;try{parsed=JSON.parse(data);}catch{invalidSave();}
 if(!object(parsed))invalidSave();
 let i=0;const ws=()=>{while(/[\t\n\r ]/.test(data[i]??'x'))i++;};
 const stringEnd=()=>{i++;while(i<data.length){if(data[i]==='\\'){i+=2;continue;}if(data[i++]==='"')return;}invalidSave();};
 ws();if(data[i++]!=='{')invalidSave();ws();const spans=new Map();
 while(data[i]!=='}'){
  const keyStart=i;stringEnd();let name;try{name=JSON.parse(data.slice(keyStart,i));}catch{invalidSave();}
  if(spans.has(name))invalidSave();ws();i++;ws();const start=i;
  if(data[i]==='"')stringEnd();
  else if(data[i]==='{'||data[i]==='['){let depth=0;do{const c=data[i];if(c==='"'){stringEnd();continue;}if(c==='{'||c==='[')depth++;if(c==='}'||c===']')depth--;i++;}while(depth>0&&i<data.length);}
  else{while(i<data.length&&data[i]!==','&&data[i]!=='}'&&!/[\t\n\r ]/.test(data[i]))i++;}
  spans.set(name,{start,end:i});ws();if(data[i]===','){i++;ws();}else break;
 }
 return spans;
}
// Check the original JSON number token before JSON.parse precision loss can
// turn a fractional/exponent token into an apparently valid integer amount.
export function isCanonicalSaveRepairJson(text){
 try{
  const root=rootSpans(text),changes=root.get('changes');if(!changes)return true;
  const raw=text.slice(changes.start,changes.end),amount=rootSpans(raw).get('addDia');
  return !amount||/^[1-9][0-9]*$/.test(raw.slice(amount.start,amount.end));
 }catch{return false;}
}
function inspect(data){
 const spans=rootSpans(data),fields={};
 for(const k of keys){const s=spans.get(k);if(!s)invalidSave();const raw=data.slice(s.start,s.end);if(k!=='Is_Remove_AD_All'&&!/^(0|[1-9][0-9]*)$/.test(raw))invalidSave();fields[k]=JSON.parse(raw);}
 if(typeof fields.Is_Remove_AD_All!=='boolean')invalidSave();
 for(const k of ['Dia','_getDia','_useDia'])if(!Number.isSafeInteger(fields[k])||fields[k]<0)invalidSave();
 return {spans,fields};
}
export function readRepairFields(data){return inspect(data).fields;}
function validateChanges(changes){
 if(!object(changes)||Object.keys(changes).length===0||Object.keys(changes).some(k=>!['removeAds','addDia'].includes(k)))invalidRequest();
 if(Object.hasOwn(changes,'removeAds')&&typeof changes.removeAds!=='boolean')invalidRequest();
 if(Object.hasOwn(changes,'addDia')&&(!Number.isSafeInteger(changes.addDia)||changes.addDia<=0||changes.addDia>INT32_MAX))invalidRequest();
 return changes;
}
export function buildSaveRepair(data,changes){
 validateChanges(changes);const {spans,fields:before}=inspect(data),after={...before};
 if(Object.hasOwn(changes,'removeAds'))after.Is_Remove_AD_All=changes.removeAds;
 if(Object.hasOwn(changes,'addDia'))Object.assign(after,compensateDiamonds(after,changes.addDia));
 const replacements=keys.filter(k=>before[k]!==after[k]).map(k=>({...spans.get(k),text:JSON.stringify(after[k])})).sort((a,b)=>b.start-a.start);
 if(!replacements.length)fail(400,'SAVE_REPAIR_NO_CHANGES');
 for(const r of replacements)data=data.slice(0,r.start)+r.text+data.slice(r.end);
 if(Buffer.byteLength(data)>65536)invalidRequest();
 return {data,before,after,delta:{Dia:after.Dia-before.Dia,_getDia:after._getDia-before._getDia,_useDia:0}};
}

function validateInput(input,operation){
 const allowed=operation==='lookup'?['openid']:['openid','version','fingerprint','changes',...(operation==='apply'?['requestId','reason']:[])];
 if(!object(input)||Object.keys(input).length!==allowed.length||Object.keys(input).some(k=>!allowed.includes(k)))invalidRequest();
 if(typeof input.openid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.openid))invalidRequest();
 if(operation!=='lookup'){
  if(!Number.isInteger(input.version)||input.version<1||input.version>2147483646||typeof input.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.fingerprint))invalidRequest();
  validateChanges(input.changes);
 }
 if(operation==='apply'&&(typeof input.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId)||typeof input.reason!=='string'||input.reason.trim().length===0||Array.from(input.reason).length>200||/[\x00-\x1f\x7f]/.test(input.reason)))invalidRequest();
}
function versionCheck(row,input){if(row.version!==input.version||digest(row.data)!==input.fingerprint)fail(409,'SAVE_REPAIR_VERSION_CONFLICT');}
function saveMeta(row){return {exists:typeof row.data==='string',version:row.version??0,updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null};}
export function createSaveRepair({pool,writePool=null,appId,enabled=false}){
 if(!pool||typeof appId!=='string'||!appId||appId.length>32)throw new Error('Invalid save repair configuration');
 const writable=enabled===true&&writePool!==null;
 async function user(db,openid){const r=await db.query('SELECT u.id,u.open_id,p.nickname FROM game_users u LEFT JOIN game_profiles p ON p.user_id=u.id WHERE u.app_id=$1 AND u.open_id=$2 AND u.first_login_completed=true',[appId,openid]);if(r.rowCount!==1)fail(404,'PLAYER_NOT_FOUND');return {id:r.rows[0].id,openid:r.rows[0].open_id,nickname:r.rows[0].nickname};}
 async function save(db,userId,lock=false){const r=await db.query(`SELECT s.data,s.version,s.updated_at FROM game_saves s JOIN game_users u ON u.id=s.user_id WHERE s.user_id=$1 AND u.app_id=$2${lock?' FOR UPDATE OF s':''}`,[userId,appId]);return r.rows[0]??{data:null,version:0,updated_at:null};}
 async function load(input){const u=await user(pool,input.openid),s=await save(pool,u.id);return {u,s};}
 return {
  async lookup(input){validateInput(input,'lookup');const {u,s}=await load(input);return {user:u,save:saveMeta(s),fields:s.data===null?null:readRepairFields(s.data),fingerprint:s.data===null?null:digest(s.data),writable};},
  async preview(input){validateInput(input,'preview');const {u,s}=await load(input);if(s.data===null)fail(404,'SAVE_REPAIR_NO_SAVE');versionCheck(s,input);const repair=buildSaveRepair(s.data,input.changes);return {user:u,save:saveMeta(s),before:repair.before,after:repair.after,delta:repair.delta,changes:input.changes,fingerprint:input.fingerprint,writable};},
  async apply(input,actor){
   if(!writable)fail(403,'SAVE_REPAIR_DISABLED');validateInput(input,'apply');
   if(typeof actor!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(actor))invalidRequest();
   const changes={...(Object.hasOwn(input.changes,'removeAds')?{removeAds:input.changes.removeAds}:{}),...(Object.hasOwn(input.changes,'addDia')?{addDia:input.changes.addDia}:{})};
   const requestHash=digest(JSON.stringify({actor,openid:input.openid,version:input.version,fingerprint:input.fingerprint,changes,reason:input.reason}));
   const c=await writePool.connect();let begun=false,rollbackError;
   try{
    await c.query('BEGIN');begun=true;
    // Serializes identical idempotency keys, including retries before COMMIT.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[appId+':'+input.requestId]);
    const prior=(await c.query('SELECT request_hash,result FROM game_dashboard_save_repairs WHERE app_id=$1 AND request_id=$2',[appId,input.requestId])).rows[0];
    if(prior){if(prior.request_hash!==requestHash)fail(409,'SAVE_REPAIR_REQUEST_CONFLICT');await c.query('COMMIT');begun=false;return {...prior.result,alreadyApplied:true};}
    const u=await user(c,input.openid),s=await save(c,u.id,true);if(s.data===null)fail(404,'SAVE_REPAIR_NO_SAVE');versionCheck(s,input);
    const repair=buildSaveRepair(s.data,changes);
    const updated=await c.query('UPDATE game_saves SET data=$2,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND version=$3 RETURNING version,updated_at',[u.id,repair.data,input.version]);
    if(updated.rowCount!==1)fail(409,'SAVE_REPAIR_VERSION_CONFLICT');
    const diamondFields=fields=>Object.fromEntries(['Dia','_getDia','_useDia'].map(key=>[key,fields[key]]));
    const diamondCompensation=Object.hasOwn(changes,'addDia')?{amount:changes.addDia,before:diamondFields(repair.before),after:diamondFields(repair.after),delta:repair.delta}:null;
    const result={user:u,save:saveMeta({...updated.rows[0],data:repair.data}),fields:repair.after,diamondCompensation,requestId:input.requestId,alreadyApplied:false};
    await c.query('INSERT INTO game_dashboard_save_repairs(app_id,request_id,user_id,actor,reason,request_hash,before_data,after_data,before_version,after_version,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',[appId,input.requestId,u.id,actor,input.reason,requestHash,s.data,repair.data,s.version,result.save.version,JSON.stringify(result)]);
    // Independently read the exact saved target before committing the receipt.
    const verified=await save(c,u.id);if(verified.version!==result.save.version||verified.data!==repair.data)throw new Error('Save verification failed');
    await c.query('COMMIT');begun=false;return result;
   }catch(error){if(begun)await c.query('ROLLBACK').catch(error=>{rollbackError=error;});throw error;}finally{c.release(rollbackError);}
  }
 };
}
