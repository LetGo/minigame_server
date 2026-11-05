import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { platformStorage } from './platform-helpers.js';

const dist = resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'tmp/platform-candidate-dist');
const platformUrl = pathToFileURL(join(dist, 'platform.js')).href;
function childRun(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn('/usr/bin/node', args, { env: { PATH: '/usr/bin:/bin', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
  const result = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
  void result.finally(() => clearTimeout(timer));
  return { child, result, output: () => output };
}
async function noRuntimeConnections(storage: Awaited<ReturnType<typeof platformStorage>>) {
  const username = new URL(storage.configs[0]!.databaseUrl).username;
  const end = Date.now() + 3000;
  while ((await storage.owner.query('SELECT 1 FROM pg_stat_activity WHERE usename=$1', [username])).rowCount) {
    assert.ok(Date.now() < end, 'all game runtime database connections must be released'); await delay(20);
  }
}

test('compiled runtime cleans up partial startup, bind failure and SIGTERM; symlink main is exact', { timeout: 40000 }, async (t) => {
  const storage = await platformStorage(); const dir = await mkdtemp(join(tmpdir(), 'platform-entry-'));
  try {
    await t.test('later game infrastructure failure closes every earlier initialized app', async () => {
      const games = storage.configs.map(c => ({ ...c })); games[1]!.databaseUrl = 'postgresql://no:FAILURE_SECRET@127.0.0.1:1/unavailable';
      const run = childRun(['--input-type=module', '-e', `import {createPlatform} from ${JSON.stringify(platformUrl)};
        try { await createPlatform(${JSON.stringify({ host: '127.0.0.1', port: 0, games })}); process.exitCode=2; }
        catch(e) { console.error(e.message); process.exitCode=1; }`]);
      assert.equal(await run.result, 1); assert.match(run.output(), /Platform startup failed/);
      assert.doesNotMatch(run.output(), /FAILURE_SECRET|postgresql:|platform-test-secret/); await noRuntimeConnections(storage);
    });
    await t.test('second app init hook failure still closes both initialized infrastructures', async () => {
      const factoryUrl = pathToFileURL(resolve('node_modules/@nestjs/core/index.js')).href;
      const run = childRun(['--input-type=module', '-e', `import {NestFactory} from ${JSON.stringify(factoryUrl)};
        const original=NestFactory.create.bind(NestFactory); let count=0;
        NestFactory.create=async (...args)=>{if(++count===2)args[0].providers.push({provide:'PLATFORM_INIT_FAILURE',useValue:{onModuleInit(){throw new Error('INIT_SECRET')}}});return original(...args);};
        const {createPlatform}=await import(${JSON.stringify(platformUrl)});
        try {await createPlatform(${JSON.stringify({ host: '127.0.0.1', port: 0, games: storage.configs })}); process.exitCode=2;}
        catch(e){console.error(e.message);process.exitCode=1;}`]);
      assert.equal(await run.result, 1); assert.match(run.output(), /Platform startup failed/);
      assert.doesNotMatch(run.output(), /INIT_SECRET|postgresql:/); await noRuntimeConnections(storage);
    });
    await t.test('one app shutdown hook rejection does not skip cleanup of the other game', async () => {
      const factoryUrl = pathToFileURL(resolve('node_modules/@nestjs/core/index.js')).href;
      const run = childRun(['--input-type=module', '-e', `import {NestFactory} from ${JSON.stringify(factoryUrl)};
        const original=NestFactory.create.bind(NestFactory);let count=0;
        NestFactory.create=async(...args)=>{const app=await original(...args);return ++count===2?new Proxy(app,{get(target,key){return key==='close'?async()=>{throw new Error('CLOSE_SECRET')}:Reflect.get(target,key)}}):app;};
        const {createPlatform}=await import(${JSON.stringify(platformUrl)});
        const p=await createPlatform(${JSON.stringify({ host: '127.0.0.1', port: 0, games: storage.configs })});
        await p.listen();try{await p.close();process.exitCode=2;}catch(e){console.error(e.message);process.exitCode=1;}`]);
      assert.equal(await run.result, 1); assert.match(run.output(), /Platform shutdown failed/);
      assert.doesNotMatch(run.output(), /CLOSE_SECRET|postgresql:/); await noRuntimeConnections(storage);
    });
    await t.test('Nest lifecycle logs cannot print raw error messages or secrets', async () => {
      const factoryUrl = pathToFileURL(resolve('node_modules/@nestjs/core/index.js')).href;
      const run = childRun(['--input-type=module', '-e', `import {NestFactory} from ${JSON.stringify(factoryUrl)};
        const original=NestFactory.create.bind(NestFactory);
        NestFactory.create=async(...args)=>{args[0].providers.push({provide:'PLATFORM_LOG_FAILURE',useValue:{onModuleDestroy(){throw new Error('PLATFORM_LOG_SECRET')}}});return original(...args);};
        const {createPlatform}=await import(${JSON.stringify(platformUrl)});
        const p=await createPlatform(${JSON.stringify({ host: '127.0.0.1', port: 0, games: storage.configs })});await p.close();`]);
      assert.equal(await run.result, 0); assert.doesNotMatch(run.output(), /PLATFORM_LOG_SECRET|Error:|at file:/); await noRuntimeConnections(storage);
    });
    await t.test('listen EADDRINUSE closes both apps and leaves no live handles', async () => {
      const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
      try {
        const address = occupied.address(); assert.ok(address && typeof address === 'object');
        const run = childRun(['--input-type=module', '-e', `import {createPlatform} from ${JSON.stringify(platformUrl)};
          const p=await createPlatform(${JSON.stringify({ host: '127.0.0.1', port: address.port, games: storage.configs })});
          try { await p.listen(); process.exitCode=2; } catch(e) { console.error(e.message); process.exitCode=1; }`]);
        assert.equal(await run.result, 1); assert.match(run.output(), /Platform listen failed/); await noRuntimeConnections(storage);
      } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
    });
    await t.test('SIGTERM closes every app on a two-game runtime', async () => {
      const run = childRun(['--input-type=module', '-e', `import {createPlatform} from ${JSON.stringify(platformUrl)};
        const p=await createPlatform(${JSON.stringify({ host: '127.0.0.1', port: 0, games: storage.configs })});
        await p.listen(); console.log('TEST_READY');`]);
      const deadline = Date.now() + 5000;
      while (!run.output().includes('TEST_READY') && run.child.exitCode === null && Date.now() < deadline) await delay(20);
      assert.match(run.output(), /TEST_READY/); run.child.kill('SIGTERM');
      assert.equal(await run.result, 0); await noRuntimeConnections(storage);
    });
    const mainFile = join(dist, 'platform-main.js');
    const linked = join(dir, 'platform-main-link.mjs'); await symlink(mainFile, linked);
    await t.test('symlink-launched invalid config executes main, fails nonzero and never leaks path', async () => {
      const run = childRun([linked], { MINIGAME_REGISTRY_FILE: join(dir, 'MISSING_SECRET') });
      assert.equal(await run.result, 1); assert.equal(run.output().trim(), 'MINIGAME_PLATFORM_STARTUP_FAILED');
    });
    await t.test('healthy symlink entry emits fixed ready marker and graceful SIGTERM', async () => {
      const config = storage.configs[0]!;
      const envFile = join(dir, 'game.env'); const registry = join(dir, 'registry.json');
      await writeFile(envFile, `WECHAT_APP_ID=${config.appId}\nWECHAT_APP_SECRET=${config.appSecret}\nDATABASE_URL=${config.databaseUrl}\nREDIS_URL=${config.redisUrl}\n`, { mode: 0o600 });
      await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId: config.appId, envFile }] }), { mode: 0o600 });
      const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
      const address = probe.address(); assert.ok(address && typeof address === 'object');
      await new Promise<void>(resolve => probe.close(() => resolve()));
      const run = childRun([linked], { MINIGAME_REGISTRY_FILE: registry, MINIGAME_PORT: String(address.port) });
      try {
        const deadline = Date.now() + 5000;
        while (!run.output().includes('MINIGAME_PLATFORM_READY') && run.child.exitCode === null && Date.now() < deadline) await delay(20);
        assert.equal(run.output().trim(), 'MINIGAME_PLATFORM_READY');
        const response = await fetch(`http://127.0.0.1:${address.port}/internal/ready`, { signal: AbortSignal.timeout(1000) });
        assert.deepEqual(await response.json(), { ready: true }); run.child.kill('SIGTERM');
        assert.equal(await run.result, 0); await noRuntimeConnections(storage);
      } finally { if (run.child.exitCode === null) run.child.kill('SIGKILL'); await run.result; }
    });
    await t.test('importing main does not start it', async () => {
      const run = childRun(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(mainFile).href)}); console.log('IMPORTED');`]);
      assert.equal(await run.result, 0); assert.equal(run.output().trim(), 'IMPORTED');
    });
  } finally { await storage.close(); await rm(dir, { recursive: true, force: true }); }
});
