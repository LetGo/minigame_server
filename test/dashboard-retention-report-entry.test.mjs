import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {isMainModule} from '../scripts/build-retention-report.mjs';

// No .env.dashboard in the isolated cwd: main must fail before any DB or report write.
test('retention CLI launched through a current directory symlink actually executes main',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'retention entry '));
 try {
  await symlink(resolve('.'),join(directory,'current'),'dir');
  const result=spawnSync(process.execPath,[join(directory,'current/scripts/build-retention-report.mjs'),'--invalid-test-argument'],{cwd:directory,encoding:'utf8',timeout:5000});
  assert.ifError(result.error);
  assert.equal(result.status,1,'symlink launch must not silently exit zero without entering main');
  assert.match(result.stderr,/Retention report unavailable: generation failed/);
  assert.equal(result.stdout,'');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('direct and file-symlink CLI launches execute main, while importing stays inert',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'retention entry '));
 const entry=resolve('scripts/build-retention-report.mjs');
 try {
  const link=join(directory,'linked cli.mjs');await symlink(entry,link);
  for(const path of [entry,link]) {
   const result=spawnSync(process.execPath,[path,'--invalid-test-argument'],{cwd:directory,encoding:'utf8',timeout:5000});
   assert.ifError(result.error);assert.equal(result.status,1);assert.match(result.stderr,/Retention report unavailable: generation failed/);assert.equal(result.stdout,'');
  }
  const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(entry).href)});console.log('import-only')`],{cwd:directory,encoding:'utf8',timeout:5000});
  assert.ifError(imported.error);assert.equal(imported.status,0);assert.equal(imported.stdout,'import-only\n');assert.equal(imported.stderr,'');
  assert.equal(isMainModule(entry,pathToFileURL(entry).href),true);
  assert.equal(isMainModule(link,pathToFileURL(entry).href),true);
  assert.equal(isMainModule(entry,pathToFileURL(link).href),true);
  assert.equal(isMainModule('',pathToFileURL(entry).href),false);
  assert.equal(isMainModule(join(directory,'missing'),pathToFileURL(entry).href),false);
  assert.equal(isMainModule(entry,import.meta.url),false);
  assert.equal(isMainModule(entry,'invalid-url'),false);
 }finally{await rm(directory,{recursive:true,force:true});}
});
