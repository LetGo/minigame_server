// Operator/systemd entrypoint. Only persistent staging; default is read-only preview.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {readEnv,assertStaging} from './staging-admin.mjs';
export function parseArgs(argv){
 if(argv.length===0)return {send:false};
 if(argv.length===1&&argv[0]==='--send')return {send:true};
 throw Error('INVALID_DAILY_CHECKIN_COMMAND');
}
export function validateDailyEnvironment(env,send){
 assertStaging(env);
 assert.equal(env.SUBSCRIBE_MESSAGES_ENABLED,'true','STAGING_SUBSCRIPTIONS_DISABLED');
 if(send)assert.equal(env.STAGING_DAILY_CHECKIN_ENABLED,'true','STAGING_DAILY_CHECKIN_DISABLED');
}
export async function main(argv=process.argv.slice(2)){
 const {send}=parseArgs(argv),env=readEnv('.env.staging');validateDailyEnvironment(env,send);
 const release=resolve('runtime/staging/current');
 const {loadConfig}=await import(pathToFileURL(resolve(release,'dist/config.js')).href);
 const {previewDailyCheckin,runDailyCheckin}=await import(pathToFileURL(resolve(release,'dist/subscriptions/daily-checkin.js')).href);
 const config=loadConfig(env),pool=new Pool({connectionString:env.DATABASE_URL,max:4,connectionTimeoutMillis:3000,statement_timeout:10000});
 try{
  let result;
  if(send){
   const {WechatSubscriptionClient}=await import(pathToFileURL(resolve(release,'dist/subscriptions/wechat-subscription.client.js')).href);
   result=await runDailyCheckin(pool,new WechatSubscriptionClient(config),{appId:config.appId,delayMs:300});
  }else{
   const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');result=await previewDailyCheckin(c,{appId:config.appId});await c.query('ROLLBACK');}finally{c.release();}
  }
  console.log(JSON.stringify({environment:'staging',dryRun:!send,...result},null,2));
  if(result.stopped===true)process.exitCode=2;
  return result;
 }finally{await pool.end();}
}
if(process.argv[1]&&pathToFileURL(realpathSync(resolve(process.argv[1]))).href===import.meta.url){
 main().catch(error=>{console.error(error?.message==='INVALID_DAILY_CHECKIN_COMMAND'?error.message:'DAILY_CHECKIN_OPERATION_FAILED (sensitive details suppressed; inspect durable receipts before retry)');process.exitCode=1;});
}
