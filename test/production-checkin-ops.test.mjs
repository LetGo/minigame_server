import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
test('production CLI default preview, explicit send, strict production/formal guards',async()=>{
 const api=await import('../ops/run-production-checkin.mjs');
 assert.deepEqual(api.parseArgs([]),{send:false});assert.deepEqual(api.parseArgs(['--send']),{send:true});
 const env={DATABASE_URL:'postgresql://minigame_app:unused@127.0.0.1:15440/minigame',REDIS_URL:'redis://:unused@127.0.0.1:16390/0',HOST:'127.0.0.1',PORT:'18740',WECHAT_APP_ID:'wx1234567890abcdef',SUBSCRIBE_MESSAGES_ENABLED:'true',SUBSCRIBE_MINIPROGRAM_STATE:'formal'};
 assert.doesNotThrow(()=>api.validateProductionDailyEnvironment(env,false));assert.throws(()=>api.validateProductionDailyEnvironment(env,true),/PRODUCTION_DAILY_CHECKIN_DISABLED/);
 assert.doesNotThrow(()=>api.validateProductionDailyEnvironment({...env,PRODUCTION_DAILY_CHECKIN_ENABLED:'true'},true));
 for(const change of [{DATABASE_URL:'postgresql://minigame_staging_app:unused@127.0.0.1:15441/minigame_staging'},{REDIS_URL:'redis://:unused@127.0.0.1:16391/0'},{REDIS_URL:'redis://:unused@127.0.0.1:16390/1'},{SUBSCRIBE_MINIPROGRAM_STATE:'trial'},{SUBSCRIBE_MESSAGES_ENABLED:'false'}])assert.throws(()=>api.validateProductionDailyEnvironment({...env,...change},false));
 for(const args of [['--env','.env.staging'],['--now','2026-10-20'],['--all'],['--send','--send'],['--user-id','x']])assert.throws(()=>api.parseArgs(args),/INVALID_DAILY_CHECKIN_COMMAND/);
});
test('production symlink entry executes main and fails safely without credentials',()=>{
 const dir=mkdtempSync(join(tmpdir(),'production-checkin-entry-'));
 try{const entry=join(dir,'entry.mjs');symlinkSync(fileURLToPath(new URL('../ops/run-production-checkin.mjs',import.meta.url)),entry);const r=spawnSync(process.execPath,[entry],{cwd:dir,encoding:'utf8',timeout:10000});assert.equal(r.status,1);assert.match(r.stderr,/DAILY_CHECKIN_OPERATION_FAILED/);assert.equal(r.stdout,'');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('production timer09Beijing has no catchup or automatic retry; immutable worker',()=>{
 const timer=readFileSync(new URL('../ops/minigame-production-checkin.timer',import.meta.url),'utf8'),service=readFileSync(new URL('../ops/minigame-production-checkin.service',import.meta.url),'utf8');
 assert.match(timer,/OnCalendar=\*-\*-\* 09:00:00 Asia\/Shanghai/);assert.match(timer,/Persistent=false/);assert.match(timer,/RandomizedDelaySec=0/);
 assert.match(service,/runtime\/production-checkin\/current\/ops\/run-production-checkin.mjs --send/);assert.match(service,/Restart=no/);assert.match(service,/Type=oneshot/);assert.match(service,/ProtectSystem=strict/);assert.doesNotMatch(service,/minigame-staging/);
});
