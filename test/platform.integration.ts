import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WechatClient } from '../src/auth/wechat.client.js';
import { platformStorage } from './platform-helpers.js';

const buildDir = resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'tmp/platform-candidate-dist');
async function rawHttp(port: number, headers: string, path = '/minigame/api/auth/wechat-login') {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); let output = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('raw HTTP timeout')));
    socket.on('error', reject); socket.on('data', data => { output += data.toString(); });
    socket.on('end', () => resolve(output));
    socket.on('connect', () => socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${headers}\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n{}`));
  });
}

test('compiled two-AppID HTTP runtime isolates sessions, saves and lifecycle on disposable PG/Redis', { timeout: 30000 }, async (t) => {
  const storage = await platformStorage();
  let platform: any;
  try {
    const { createPlatform } = await import(pathToFileURL(resolve(buildDir, 'platform.js')).href);
    const wechat = Object.fromEntries(storage.configs.map(config => [config.appId, new WechatClient(config,
      async () => Response.json({ openid: 'same-platform-openid', session_key: 'private-test-key' }))]));
    platform = await createPlatform({ host: '127.0.0.1', port: 0, games: storage.configs }, { wechat });
    await platform.listen();
    const address = platform.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const [a, b] = storage.configs; assert.ok(a && b);
    async function call(path: string, appId: string | undefined = a!.appId, body: unknown = {}, token?: string, extra: Record<string, string> = {}) {
      const response = await fetch(base + path, { method: 'POST', headers: {
        'content-type': 'application/json', ...(appId === undefined ? {} : { 'X-Minigame-AppId': appId }),
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra,
      }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() as any, headers: response.headers };
    }
    const login = '/minigame/api/auth/wechat-login';
    let authA: any; let authB: any;
    await t.test('same openid yields independent UID and per-AppID repeat login identity', async () => {
      const ra = await call(login, a.appId, { code: 'first-game' }); const rb = await call(login, b.appId, { code: 'second-game' });
      assert.equal(ra.status, 200); assert.equal(rb.status, 200); authA = ra.body; authB = rb.body;
      assert.equal(authA.user.openid, authB.user.openid); assert.notEqual(authA.user.id, authB.user.id);
      assert.equal((await call(login, a.appId, { code: 'repeat-game' })).body.user.id, authA.user.id);
      assert.doesNotMatch(JSON.stringify([authA, authB]), /private-test-key|platform-test-secret|session_key/);
    });
    await t.test('save text and CAS state are isolated through each game session', async () => {
      assert.equal((await call('/minigame/api/data/save', a.appId, { version: 0, data: '{"game":"a"}' }, authA.accessToken)).status, 200);
      assert.equal((await call('/minigame/api/data/get', b.appId, {}, authB.accessToken)).body.exists, false);
      assert.equal((await call('/minigame/api/data/save', b.appId, { version: 0, data: '{"game":"b"}' }, authB.accessToken)).status, 200);
      assert.equal((await call('/minigame/api/data/get', a.appId, {}, authA.accessToken)).body.data, '{"game":"a"}');
      assert.equal((await call('/minigame/api/data/get', b.appId, {}, authB.accessToken)).body.data, '{"game":"b"}');
      assert.equal((await call('/minigame/api/data/save', a.appId, { version: 0, data: '{}' }, authA.accessToken)).status, 409);
      for (let i = 0; i < 2; i++) assert.equal((await storage.pools[i]!.query('SELECT count(*)::int AS n FROM game_saves')).rows[0].n, 1);
    });
    await t.test('cross-game tokens fail even though both runtimes share test Redis DB15', async () => {
      for (const [id, token] of [[a.appId, authB.accessToken], [b.appId, authA.accessToken]]) {
        const response = await call('/minigame/api/data/get', id, {}, token);
        assert.equal(response.status, 401); assert.equal(response.body.message, 'SESSION_INVALID');
      }
    });
    await t.test('strict required, invalid, unregistered and duplicate AppID headers fail before dispatch', async () => {
      const missing = await rawHttp(address.port, ''); assert.match(missing, /400 Bad Request/); assert.match(missing, /APP_ID_REQUIRED/);
      for (const value of ['cat', 'wx0123456789abcdeF', `${a.appId},${b.appId}`, 'wx0123456789abcdefX', '']) {
        const result = await rawHttp(address.port, `X-Minigame-AppId: ${value}\r\n`);
        assert.match(result, /400 Bad Request/); assert.match(result, /APP_ID_INVALID/);
      }
      const unknown = await call(login, 'wx0000000000000000');
      assert.equal(unknown.status, 404); assert.equal(unknown.body.message, 'APP_NOT_REGISTERED');
      const duplicate = await rawHttp(address.port, `X-Minigame-AppId: ${a.appId}\r\nx-minigame-appid: ${a.appId}\r\n`);
      assert.match(duplicate, /400 Bad Request/); assert.match(duplicate, /APP_ID_INVALID/);
      const paddedDuplicate = await rawHttp(address.port, `X-Minigame-AppId: ${a.appId}\r\n` + 'a:\r\n'.repeat(2100) + `X-Minigame-AppId: ${a.appId}\r\n`);
      assert.match(paddedDuplicate, /400 Bad Request/); assert.match(paddedDuplicate, /APP_ID_INVALID/);
    });
    await t.test('unknown or prototype-shaped AppIDs never select a runtime', async () => {
      for (const value of ['constructor', '__proto__', 'wx0123456789abcdef']) {
        const result = await call(login, value);
        assert.equal(result.status, value.startsWith('wx') ? 404 : 400);
      }
    });
    await t.test('trusted proxy policy is fixed loopback and login rate state remains per game', async () => {
      const { createHash } = await import('node:crypto');
      const digest = createHash('sha256').update('203.0.113.8').digest('hex');
      const key = `minigame:login-rate:${a.appId}:${digest}`;
      await storage.redis.set(key, String(a.loginRateLimit), { EX: 60 });
      assert.equal((await call(login, a.appId, { code: 'limited-login' }, undefined, { 'x-forwarded-for': '203.0.113.8' })).status, 429);
      assert.equal((await call(login, b.appId, { code: 'other-game-login' }, undefined, { 'x-forwarded-for': '203.0.113.8' })).status, 200);
    });
    await t.test('body and query cannot select a tenant and cannot bypass mandatory header', async () => {
      for (const path of [login + '?appId=' + b.appId, login]) {
        const response: Response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: 'test-code', appId: b.appId }), signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 400); assert.equal((await response.json() as any).message, 'APP_ID_REQUIRED');
      }
      assert.equal((await call(login, a.appId, { code: 'test-code', appId: b.appId })).status, 400);
      assert.equal((await call('/minigame/api/data/get?appId='+b.appId, a.appId, {}, authA.accessToken)).status, 400);
    });
    await t.test('readiness is internal only; legacy and prefix-confusion paths never dispatch', async () => {
      const ready = await fetch(base + '/internal/ready'); assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { ready: true }); assert.equal(ready.headers.get('cache-control'), 'no-store');
      for (const path of ['/minigame/api/internal/ready', '/minigame/internal/ready', '/cat/api/auth/wechat-login', '/h5login/api/auth/wechat-login', '/minigame/apix/auth/wechat-login', '/minigame/api/../internal/ready', '/minigame/api/%2e%2e/internal/ready']) {
        const response = await call(path, a.appId);
        assert.equal(response.status, 404); assert.equal(response.body.message, 'NOT_FOUND');
        assert.doesNotMatch(JSON.stringify(response.body), /h5login|Cannot POST|postgres|platform_|secret/i);
      }
    });
    await t.test('malformed, excessive and compressed body errors are safe through rewritten route', async () => {
      const bad = await call(login, a.appId, '{PLATFORM_BODY_SENTINEL');
      assert.equal(bad.status, 400); assert.equal(bad.body.message, 'INVALID_JSON');
      assert.doesNotMatch(JSON.stringify(bad.body), /PLATFORM_BODY_SENTINEL|SyntaxError|stack/);
      assert.equal((await call(login, a.appId, { code: 'x'.repeat(20000) })).status, 413);
      assert.equal((await call(login, a.appId, { code: 'x' }, undefined, { 'content-encoding': 'gzip' })).status, 415);
      const largeSave = { version: 1, data: JSON.stringify({ text: '中'.repeat(10000) }) };
      assert.equal((await call('/minigame/api/data/save', a.appId, largeSave, authA.accessToken)).status, 200);
      assert.equal((await call('/minigame/api/data/save', a.appId, { version: 2, data: 'x'.repeat(270000) }, authA.accessToken)).status, 413);
    });
    await t.test('session rate cap remains app-specific and emits Retry-After', async () => {
      const key = `minigame:data-rate:${a.appId}:${authA.user.id}`;
      await storage.redis.set(key, '60', { EX: 60 });
      const limited = await call('/minigame/api/data/get', a.appId, {}, authA.accessToken);
      assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await call('/minigame/api/data/get', b.appId, {}, authB.accessToken)).status, 200);
    });
    await t.test('listener is loopback with fixed timeouts and safe malformed-client handling', async () => {
      assert.equal(address.address, '127.0.0.1'); assert.equal(platform.server.requestTimeout, 15000);
      assert.equal(platform.server.headersTimeout, 10000); assert.equal(platform.server.keepAliveTimeout, 5000);
      const result = await rawHttp(address.port, 'Bad Header: PLATFORM_CLIENT_SECRET\r\n');
      assert.match(result, /400 Bad Request/); assert.doesNotMatch(result, /PLATFORM_CLIENT_SECRET/);
      assert.equal((await fetch(base+'/internal/ready')).status, 200);
    });
    await t.test('idempotent close removes listener and releases both game infrastructures', async () => {
      await platform.close(); await platform.close(); assert.equal(platform.address(), null);
      await assert.rejects(fetch(base+'/internal/ready', { signal: AbortSignal.timeout(1000) }));
      await assert.rejects(platform.listen(), /Platform is closed/);
    });
  } finally { if (platform) await platform.close(); await storage.close(); }
});
