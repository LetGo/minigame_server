import assert from 'node:assert/strict';
import {test} from 'node:test';
test('operator subscription command defaults to preview and refuses bulk/production/missing idempotency',async()=>{
 let api;try{api=await import('../ops/send-checkin-subscription.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
 assert.equal(typeof api?.parseArgs,'function','staging-only send command must exist');
 const uid='11111111-1111-4111-8111-111111111111',request='22222222-2222-4222-8222-222222222222';
 assert.deepEqual(api.parseArgs(['--user-id',uid]),{userId:uid,send:false,page:'index'});
 assert.deepEqual(api.parseArgs(['--user-id',uid,'--send','--request-id',request,'--page','index?from=checkin']),{userId:uid,send:true,requestId:request,page:'index?from=checkin'});
 for(const args of [[],['--send'],['--user-id',uid,'--send'],['--user-id',uid,'--all'],['--user-id',uid,'--env','.env'],['--openid','fake'],['--user-id',uid,'--request-id',request],['--user-id',uid,'--user-id',uid],['--user-id','bad'],['--user-id',uid,'--send','--request-id','bad'],['--user-id',uid,'--page','https://evil.invalid'],['--user-id',uid,'--send','--request-id',request,'--send']])assert.throws(()=>api.parseArgs(args),/INVALID_SUBSCRIPTION_COMMAND/);
});
