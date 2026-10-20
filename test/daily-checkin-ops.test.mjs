import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
test('release symlink entry actually invokes main instead of silently exiting',()=>{
 const dir=mkdtempSync(join(tmpdir(),'daily-cli-entry-'));
 try{const entry=join(dir,'run.mjs');symlinkSync(fileURLToPath(new URL('../ops/run-daily-checkin.mjs',import.meta.url)),entry);const result=spawnSync(process.execPath,[entry],{cwd:dir,encoding:'utf8',timeout:10000});assert.equal(result.status,1,'entry must run; missing staging file must fail rather than silently succeed');assert.match(result.stderr,/DAILY_CHECKIN_OPERATION_FAILED/);assert.equal(result.stdout,'');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('daily CLI is staging-only, preview by default, explicit send only',async()=>{
 let api;try{api=await import('../ops/run-daily-checkin.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
 assert.equal(typeof api?.parseArgs,'function','daily CLI must exist');
 assert.deepEqual(api.parseArgs([]),{send:false});assert.deepEqual(api.parseArgs(['--send']),{send:true});
 const env={DATABASE_URL:'postgresql://minigame_staging_app:unused@127.0.0.1:15441/minigame_staging',REDIS_URL:'redis://:unused@127.0.0.1:16391/0',PORT:'18741',HOST:'127.0.0.1',TRUST_LOCAL_PROXY:'true',SUBSCRIBE_MESSAGES_ENABLED:'true'};
 assert.equal(typeof api.validateDailyEnvironment,'function');
 assert.doesNotThrow(()=>api.validateDailyEnvironment(env,false));assert.throws(()=>api.validateDailyEnvironment(env,true),/STAGING_DAILY_CHECKIN_DISABLED/);
 assert.doesNotThrow(()=>api.validateDailyEnvironment({...env,STAGING_DAILY_CHECKIN_ENABLED:'true'},true));
 assert.throws(()=>api.validateDailyEnvironment({...env,DATABASE_URL:'postgresql://minigame_staging_app:unused@127.0.0.1:15440/minigame'},false));
 for(const args of [['--send','--send'],['--env','.env'],['--all'],['--date','2026-10-20'],['--now','2026-10-20T01:00:00Z'],['--user-id','anything']])assert.throws(()=>api.parseArgs(args),/INVALID_DAILY_CHECKIN_COMMAND/);
});
test('scheduler explicitly uses Beijing09:00 without missed-run catchup or auto restart',()=>{
 const timer=readFileSync(new URL('../ops/minigame-staging-checkin.timer',import.meta.url),'utf8');
 const service=readFileSync(new URL('../ops/minigame-staging-checkin.service',import.meta.url),'utf8');
 assert.match(timer,/OnCalendar=\*-\*-\* 09:00:00 Asia\/Shanghai/);assert.match(timer,/Persistent=false/);assert.match(timer,/AccuracySec=1s/);assert.match(timer,/RandomizedDelaySec=0/);
 assert.match(service,/Type=oneshot/);assert.match(service,/run-daily-checkin\.mjs --send/);assert.match(service,/Restart=no/);assert.match(service,/User=ubuntu/);assert.match(service,/ProtectSystem=strict/);
 assert.doesNotMatch(service,/minigame-login\.service|\.env\.production/);
});
