// Explicit synthetic fixtures, NOT real WeChat successful login evidence.
// Uses only isolated staging owner DB15441 and Redis16391; deletes its own fixtures.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { readEnv, assertStaging } from './staging-admin.mjs';

const env = readEnv('.env.staging');
const infra = readEnv('.env.staging.infrastructure');
assertStaging(env);
const pool = new Pool({ host: '127.0.0.1', port: 15441, database: 'minigame_staging',
  user: 'minigame_staging_owner', password: infra.POSTGRES_PASSWORD, connectionTimeoutMillis: 3000 });
const redis = createClient({ url: env.REDIS_URL, disableOfflineQueue: true,
  socket: { connectTimeout: 3000, reconnectStrategy: false } });
redis.on('error', () => {});
const base = 'https://sub2api.wdaveh5game.com/h5login-test/api/';
const ids = [], keys = [], checks = [];
const prefix = 'staging_smoke_' + randomUUID() + '_';
let cleanupVerified = false;
async function call(operation, payload, token, expected = 200, raw = false, production = false) {
  // Avoid consuming the existing shared public per-IP Nginx burst limit.
  await new Promise(resolve => setTimeout(resolve, 150));
  const target = production ? 'https://sub2api.wdaveh5game.com/h5login/api/' : base;
  const response = await fetch(target + operation, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: raw ? payload : JSON.stringify(payload), signal: AbortSignal.timeout(20000), redirect: 'error' });
  assert.equal(response.status, expected, operation);
  if (!production) assert.equal(response.headers.get('x-minigame-environment'), 'staging');
  const text = await response.text();
  if (expected !== 413) assert.equal(response.headers.get('cache-control'), 'no-store');
  checks.push(`${production ? 'production-isolation:' : ''}${operation}:${expected}`);
  return expected === 413 ? text : JSON.parse(text);
}
async function fixture(suffix, isNewUser) {
  const result = await pool.query('INSERT INTO game_users(app_id,open_id,first_login_completed) VALUES($1,$2,true) RETURNING id', [env.WECHAT_APP_ID, prefix + suffix]);
  const id = result.rows[0].id; ids.push(id);
  const token = randomBytes(32).toString('base64url');
  const key = 'minigame:session:' + createHash('sha256').update(token).digest('hex');
  keys.push(key, `minigame:invite-rate:${env.WECHAT_APP_ID}:${id}`, `minigame:data-rate:${env.WECHAT_APP_ID}:${id}`);
  await redis.set(key, JSON.stringify({ userId: id, appId: env.WECHAT_APP_ID, issuedAt: new Date().toISOString(), isNewUser }), { EX: 300, NX: true });
  return { id, token };
}
try {
  await redis.connect();
  await call('auth/wechat-login', {}, undefined, 400);
  assert.equal((await call('auth/wechat-login', '{bad', undefined, 400, true)).message, 'INVALID_JSON');
  for (const operation of ['users/profile', 'invites/report', 'invites/list', 'invites/claim', 'data/get']) await call(operation, {}, undefined, 401);
  const a = await fixture('inviter', false);
  const b = await fixture('invitee', true);
  const c = await fixture('other', false);
  const profile = await call('users/profile', { nickname: '测试联调', avatarUrl: 'https://example.com/staging-avatar.png' }, b.token);
  assert.equal(profile.user.id, b.id);
  assert.equal((await call('invites/report', { inviterUid: a.id }, b.token)).accepted, true);
  assert.equal((await call('invites/report', { inviterUid: a.id }, b.token)).alreadyBound, true);
  assert.equal((await call('invites/report', { inviterUid: a.id }, c.token)).reason, 'NOT_NEW_USER');
  const list = await call('invites/list', { limit: 20 }, a.token);
  assert.deepEqual(list.summary, { total: 1, claimed: 0, unclaimed: 1 });
  assert.equal(list.items[0].nickname, '测试联调');
  assert.equal(Object.hasOwn(list.items[0], 'invitationId'), false);
  const claim = await call('invites/claim', { inviteeUid: b.id }, a.token);
  assert.equal(claim.rewardClaimed, true);
  assert.deepEqual(await call('invites/claim', { inviteeUid: b.id }, a.token), claim);
  await call('invites/claim', { inviteeUid: b.id }, c.token, 404);
  assert.equal((await call('data/get', {}, b.token)).exists, false);
  const original = '{"big":9007199254740993123,"text":"测试环境"}\n';
  assert.equal((await call('data/save', { version: 0, data: original }, b.token)).version, 1);
  assert.equal((await call('data/get', {}, b.token)).data, original);
  await call('data/save', { version: 0, data: original }, b.token, 409);
  assert.equal((await call('data/get', {}, c.token)).exists, false);
  // 64KiB original JSON whose escaped HTTP representation exceeds16KiB.
  const boundary = '{' + '\t'.repeat(65534) + '}';
  assert.equal(Buffer.byteLength(boundary), 65536);
  assert.equal((await call('data/save', { version: 1, data: boundary }, b.token)).version, 2);
  assert.equal((await call('data/get', {}, b.token)).data, boundary);
  await call('auth/wechat-login', { code: 'x'.repeat(17000) }, undefined, 413);
  await call('data/get', {}, b.token, 401, false, true);
  await call('invites/list', {}, b.token, 404, false, true);
  const invalid = await call('auth/wechat-login', { code: 'invalid_staging_smoke_' + randomUUID().replaceAll('-', '') }, undefined, 401);
  assert.equal(invalid.message, 'WECHAT_CODE_INVALID');
  // Exercise the actual generated optional SDK against HTTPS staging too.
  const sdkModule = { exports: {} };
  runInNewContext(readFileSync('client/minigame-data-client.js', 'utf8'), { module: sdkModule, exports: sdkModule.exports });
  const wx = { request(options) {
    setTimeout(() => {
      fetch(options.url, { method: options.method, headers: options.header,
        body: JSON.stringify(options.data), signal: AbortSignal.timeout(20000) })
        .then(async response => {
          assert.equal(response.headers.get('x-minigame-environment'), 'staging');
          checks.push(`bundled-sdk:${options.url.split('/').pop()}:${response.status}`);
          options.success({ statusCode: response.status, data: await response.json(), header: Object.fromEntries(response.headers) });
        }).catch(options.fail);
    }, 150);
  } };
  const store = sdkModule.exports.createDataClient({ wx, accessToken: c.token, baseUrl: base.replace(/\/api\/$/, '') });
  assert.equal((await store.get()).exists, false);
  assert.equal((await store.save(original, 0)).version, 1);
  assert.equal((await store.get()).data, original);
} finally {
  if (ids.length) {
    await pool.query('DELETE FROM game_users WHERE id=ANY($1::uuid[]) AND open_id LIKE $2', [ids, prefix + '%']);
    assert.equal((await pool.query('SELECT id FROM game_users WHERE id=ANY($1::uuid[])', [ids])).rowCount, 0);
  }
  if (redis.isReady && keys.length) {
    await redis.del(keys);
    assert((await redis.mGet(keys)).every(value => value === null));
  }
  cleanupVerified = true;
  if (redis.isOpen) redis.destroy();
  await pool.end();
}
const result = { checkedAt: new Date().toISOString(), baseUrl: base, checks, checkCount: checks.length,
  syntheticFixtures: true, realWeChatSuccessfulLoginVerified: false, realWeChatInvalidCodeVerified: true,
  fixtureCleanupVerified: cleanupVerified };
writeFileSync('tmp/staging-setup/public-smoke.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
