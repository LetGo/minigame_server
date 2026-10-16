import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { createClient } from 'redis';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { migrate } from '../src/database/migrate.js';
import { WechatClient } from '../src/auth/wechat.client.js';
import { Infrastructure } from '../src/infrastructure.js';

const config = loadConfig({
  WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_APP_SECRET: 'integration-test-only',
  DATABASE_URL: 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test',
  REDIS_URL: 'redis://127.0.0.1:16389/15', LOGIN_RATE_LIMIT: '200',
});
const route = '/h5login/api/auth/wechat-login';

test('login HTTP flow with real isolated PostgreSQL and Redis (WeChat transport stubbed)', async (t) => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const redis = createClient({ url: config.redisUrl });
  redis.on('error', () => {});
  await redis.connect();
  t.after(async () => { await redis.quit(); await pool.end(); });
  await migrate(pool);
  await migrate(pool);
  await pool.query('TRUNCATE game_users');
  await redis.flushDb();
  let upstreamCalls = 0;
  const wechat = new WechatClient(config, async () => {
    upstreamCalls++;
    return Response.json({ openid: 'player_one', session_key: 'upstream-private-key' });
  });
  const app = await createApplication(config, { wechat });
  t.after(() => app.close());
  await app.init();

  await t.test('first login creates a user and a hashed, expiring Redis session', async () => {
    const response = await request(app.getHttpServer()).post(route).send({ code: 'fresh-code' }).expect(200);
    assert.equal(response.body.tokenType, 'Bearer');
    assert.equal(response.body.expiresIn, 604800);
    assert.match(response.body.accessToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(response.body.user.id, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(response.body), /openid|session_key|upstream-private-key|integration-test-only/);
    assert.equal(response.headers['cache-control'], 'no-store');
    const rows = await pool.query('SELECT id, app_id, open_id FROM game_users');
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].id, response.body.user.id);
    assert.equal(rows.rows[0].app_id, config.appId);
    assert.equal(rows.rows[0].open_id, 'player_one');
    const hash = createHash('sha256').update(response.body.accessToken).digest('hex');
    const key = `minigame:session:${hash}`;
    const session = JSON.parse((await redis.get(key))!);
    assert.equal(session.userId, response.body.user.id);
    assert.equal(session.appId, config.appId);
    assert.ok((await redis.ttl(key)) > 604790);
    assert.equal(await redis.exists(`minigame:session:${response.body.accessToken}`), 0);
  });

  await t.test('repeat and concurrent logins reuse the same unique user with distinct tokens', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      request(app.getHttpServer()).post(route).send({ code: `concurrent-code-${i}` }).expect(200)));
    assert.equal(new Set(responses.map(r => r.body.user.id)).size, 1);
    assert.equal(new Set(responses.map(r => r.body.accessToken)).size, 8);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_users')).rows[0].n, 1);
  });

  await t.test('invalid and unexpected fields are rejected before contacting WeChat', async () => {
    const before = upstreamCalls;
    for (const payload of [{}, { code: '' }, { code: ' ' }, { code: 'a b' }, { code: 12 }, { code: 'a'.repeat(513) }, { code: 'ok', openid: 'attacker' }]) {
      await request(app.getHttpServer()).post(route).send(payload).expect(400);
    }
    assert.equal(upstreamCalls, before);
  });

  await t.test('malformed, oversized and compressed request bodies are safely rejected', async () => {
    const before = upstreamCalls;
    const malformed = await request(app.getHttpServer()).post(route).set('Content-Type', 'application/json').send('{bad').expect(400);
    assert.equal(malformed.body.message, 'INVALID_JSON');
    assert.doesNotMatch(JSON.stringify(malformed.body), /SyntaxError|stack|\{bad/);
    const nonJson = await request(app.getHttpServer()).post(route).set('Content-Type', 'application/json').send('not-json-PROBE_SENTINEL').expect(400);
    assert.equal(nonJson.body.message, 'INVALID_JSON');
    assert.doesNotMatch(JSON.stringify(nonJson.body), /not-json|PROBE/);
    await request(app.getHttpServer()).post(route).send({ code: 'a'.repeat(20000) }).expect(413);
    await request(app.getHttpServer()).post(route).set('Content-Encoding', 'gzip').send({ code: 'abc' }).expect(415);
    assert.equal(upstreamCalls, before);
  });

  await t.test('database failure returns a sanitized 503 and never issues a token', async () => {
    await pool.query('ALTER TABLE game_users RENAME TO game_users_temporarily_unavailable');
    try {
      const response = await request(app.getHttpServer()).post(route).send({ code: 'db-failure-code' }).expect(503);
      assert.equal(response.body.message, 'LOGIN_STORAGE_UNAVAILABLE');
      assert.equal(response.body.accessToken, undefined);
      assert.doesNotMatch(JSON.stringify(response.body), /SELECT|INSERT|postgres|stack/);
    } finally {
      await pool.query('ALTER TABLE game_users_temporarily_unavailable RENAME TO game_users');
    }
  });

  await t.test('Redis-backed limit is atomic, ignores forged forwarded IPs and expires', async () => {
    await redis.flushDb();
    const limited = await createApplication({ ...config, loginRateLimit: 2, loginRateWindowSeconds: 1 }, { wechat });
    try {
      await limited.init();
      const before = upstreamCalls;
      const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => request(limited.getHttpServer())
        .post(route).set('X-Forwarded-For', `203.0.113.${i + 1}`).send({ code: `rate-code-${i}` })));
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 429, 429, 429]);
      assert.equal(upstreamCalls - before, 2);
      assert.ok(responses.filter(r => r.status === 429).every(r => Number(r.headers['retry-after']) >= 1));
      await new Promise(resolve => setTimeout(resolve, 1100));
      await request(limited.getHttpServer()).post(route).send({ code: 'after-window' }).expect(200);
    } finally {
      await limited.close();
    }
  });

  await t.test('session-write failure after WeChat verification returns no token', async () => {
    await redis.flushDb();
    let broken: Awaited<ReturnType<typeof createApplication>>;
    const failAfterExchange = new WechatClient(config, async () => {
      broken.get(Infrastructure).redis.destroy();
      return Response.json({ openid: 'post_exchange_outage', session_key: 'test-key' });
    });
    broken = await createApplication(config, { wechat: failAfterExchange });
    try {
      await broken.init();
      const response = await request(broken.getHttpServer()).post(route).send({ code: 'write-failure-code' }).expect(503);
      assert.equal(response.body.message, 'LOGIN_STORAGE_UNAVAILABLE');
      assert.equal(response.body.accessToken, undefined);
    } finally {
      await broken.close();
    }
  });

  await t.test('compiled entrypoint releases dependencies and exits when port binding fails', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const child = spawn(process.execPath, ['dist/main.js'], {
      env: { ...process.env, WECHAT_APP_ID: config.appId, WECHAT_APP_SECRET: config.appSecret,
        DATABASE_URL: config.databaseUrl, REDIS_URL: config.redisUrl, PORT: String(address.port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', data => { logs += String(data); });
    child.stderr.on('data', data => { logs += String(data); });
    const exit = new Promise<number | null>(resolve => child.once('close', resolve));
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([exit, new Promise<'timed-out'>(resolve => { timer = setTimeout(() => resolve('timed-out'), 4000); })]);
      assert.equal(result, 1);
      assert.doesNotMatch(logs, /integration-test-only|postgresql:\/\//);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  await t.test('Redis outage fails closed before WeChat and user creation', async () => {
    const before = upstreamCalls;
    app.get(Infrastructure).redis.destroy();
    const response = await request(app.getHttpServer()).post(route).send({ code: 'redis-failure-code' }).expect(503);
    assert.equal(response.body.accessToken, undefined);
    assert.equal(upstreamCalls, before);
  });
});
