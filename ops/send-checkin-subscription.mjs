// Operator-only, staging-only, single user. Default invocation is read-only preview.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {readEnv,assertStaging} from './staging-admin.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseArgs(argv){
 const result={send:false,page:'index'},seen=new Set();
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];if(!['--user-id','--request-id','--page','--send'].includes(arg)||seen.has(arg))throw Error('INVALID_SUBSCRIPTION_COMMAND');seen.add(arg);
  if(arg==='--send'){result.send=true;continue;}
  const value=argv[++i];if(typeof value!=='string'||value.startsWith('--'))throw Error('INVALID_SUBSCRIPTION_COMMAND');
  result[{'--user-id':'userId','--request-id':'requestId','--page':'page'}[arg]]=value;
 }
 if(!UUID.test(result.userId??'')||(result.send?!UUID.test(result.requestId??''):result.requestId!==undefined)||!/^[A-Za-z0-9][A-Za-z0-9_./?=&%+-]{0,511}$/.test(result.page)||result.page.includes('://')||result.page.startsWith('//'))throw Error('INVALID_SUBSCRIPTION_COMMAND');
 return result.send?{userId:result.userId,send:true,requestId:result.requestId,page:result.page}:{userId:result.userId,send:false,page:result.page};
}
export async function main(argv=process.argv.slice(2)){
 const options=parseArgs(argv),env=readEnv('.env.staging');assertStaging(env);
 assert.equal(env.SUBSCRIBE_MESSAGES_ENABLED,'true','subscription feature must be enabled in staging');
 const release=resolve('runtime/staging/current');
 const {loadConfig}=await import(pathToFileURL(resolve(release,'dist/config.js')).href);
 const {previewCheckin,sendCheckin}=await import(pathToFileURL(resolve(release,'dist/subscriptions/checkin-sender.js')).href);
 const {WechatSubscriptionClient}=await import(pathToFileURL(resolve(release,'dist/subscriptions/wechat-subscription.client.js')).href);
 const config=loadConfig(env),pool=new Pool({connectionString:env.DATABASE_URL,max:2,connectionTimeoutMillis:3000,statement_timeout:10000});
 try{
  if(!options.send){
   const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await previewCheckin(c,config.appId,options.userId,options.page);await c.query('ROLLBACK');console.log(JSON.stringify({environment:'staging',dryRun:true,...result},null,2));return result;}finally{c.release();}
  }
  const result=await sendCheckin(pool,new WechatSubscriptionClient(config),{appId:config.appId,...options});
  const row=(await pool.query('SELECT state,user_id,template_id FROM game_subscription_sends WHERE app_id=$1 AND request_id=$2',[config.appId,options.requestId])).rows[0];
  assert(row&&row.state===result.state&&row.user_id===result.userId&&row.template_id===result.templateId,'send receipt read-back mismatch');
  console.log(JSON.stringify({environment:'staging',dryRun:false,readBackVerified:true,...result},null,2));
  if(result.state!=='sent')process.exitCode=2;return result;
 }finally{await pool.end();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().catch(error=>{const allowed=/^(INVALID_SUBSCRIPTION_COMMAND|INVALID_SUBSCRIPTION_TARGET|INVALID_SUBSCRIPTION_REQUEST_ID|SUBSCRIPTION_USER_NOT_FOUND|SUBSCRIPTION_NOT_ACCEPTED|SUBSCRIPTION_SEND_PENDING|SUBSCRIPTION_REQUEST_CONFLICT|SUBSCRIPTION_SEND_STATUS_UNCERTAIN)$/;console.error(allowed.test(error?.message??'')?error.message:'SUBSCRIPTION_OPERATION_FAILED (sensitive details suppressed)');process.exitCode=1;});
}
