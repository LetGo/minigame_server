import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { migrate } from '../src/database/migrate.js';
import { WechatClient } from '../src/auth/wechat.client.js';
import { Infrastructure } from '../src/infrastructure.js';

const config = loadConfig({ WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_APP_SECRET: 'explicit-source-scene-test-stub',
  DATABASE_URL: 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test',
  REDIS_URL: 'redis://127.0.0.1:16389/15', LOGIN_RATE_LIMIT: '200' });
const prefix = '/h5login/api/';
const route = prefix + 'users/source-scene';
const sessionKey = (token: string) => 'minigame:session:' + createHash('sha256').update(token).digest('hex');

test('source scene API: real isolated storage, first-registration eligibility and immutable attribution', async t => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const redis = createClient({ url: config.redisUrl }); redis.on('error', () => {});
  await redis.connect();
  t.after(async () => { await redis.quit(); await pool.end(); });
  await migrate(pool); await pool.query('TRUNCATE game_users CASCADE'); await redis.flushDb();
  const wechat = new WechatClient(config, async input => Response.json({
    openid: new URL(String(input)).searchParams.get('js_code'), session_key: 'explicit-never-disclose-test-key',
  }));
  const app = await createApplication(config, { wechat });
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const secondApp = await createApplication(config, { wechat });
  await secondApp.listen(0, '127.0.0.1'); t.after(() => secondApp.close());
  async function login(code: string) {
    return (await request(app.getHttpServer()).post(prefix + 'auth/wechat-login').send({ code }).expect(200)).body;
  }
  async function call(token: string, body: unknown, expected = 200, server = app) {
    const r = await request(server.getHttpServer()).post(route).set('Authorization', 'Bearer ' + token).send(body as object).expect(expected);
    assert.equal(r.headers['cache-control'], 'no-store'); return r.body;
  }
  async function stored(uid: string) {
    return (await pool.query('SELECT source_scene,source_scene_reported_at FROM game_users WHERE id=$1', [uid])).rows[0];
  }

  await t.test('first report persists exact server timestamp, same-scene retries keep receipt across later sessions', async () => {
    const actor = await login('scene_first');
    assert.equal(actor.isNewUser, true);
    const first = await call(actor.accessToken, { scene: 1007 });
    assert.deepEqual(Object.keys(first).sort(), ['alreadyRecorded', 'reportedAt', 'scene']);
    assert.equal(first.scene, 1007); assert.equal(first.alreadyRecorded, false);
    const row = await stored(actor.user.id);
    assert.equal(row.source_scene, 1007); assert.equal(row.source_scene_reported_at.toISOString(), first.reportedAt);
    assert.deepEqual(await call(actor.accessToken, { scene: 1007 }), { ...first, alreadyRecorded: true });
    const old = await login('scene_first'); assert.equal(old.isNewUser, false);
    assert.deepEqual(await call(old.accessToken, { scene: 1007 }), { ...first, alreadyRecorded: true });
    for (const token of [actor.accessToken, old.accessToken]) {
      assert.equal((await call(token, { scene: 1008 }, 409)).message, 'SOURCE_SCENE_ALREADY_RECORDED');
    }
    assert.deepEqual(await stored(actor.user.id), row);
  });

  await t.test('old and legacy sessions cannot first-fill metadata or forge new-user eligibility', async () => {
    const first = await login('scene_eligibility');
    const old = await login('scene_eligibility');
    assert.equal((await call(old.accessToken, { scene: 1007 }, 403)).message, 'SOURCE_SCENE_NOT_NEW_USER');
    assert.deepEqual(await stored(first.user.id), { source_scene: null, source_scene_reported_at: null });
    await call(old.accessToken, { scene: 1007, isNewUser: true }, 400);
    await pool.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2)', [config.appId, 'scene_legacy']);
    const legacy = await login('scene_legacy'); assert.equal(legacy.isNewUser, false);
    await call(legacy.accessToken, { scene: 1007 }, 403);
    const key = sessionKey(first.accessToken); const value = JSON.parse((await redis.get(key))!);
    delete value.isNewUser; await redis.set(key, JSON.stringify(value), { EX: 60 });
    await call(first.accessToken, { scene: 1007 }, 403);
    value.isNewUser = true; await redis.set(key, JSON.stringify(value), { EX: 60 });
    await call(first.accessToken, { scene: 1007 });
  });

  await t.test('strict integer boundaries and request shape prevent coercion and acting as another user', async () => {
    const actor = await login('scene_validation');
    for (const scene of [0, -1, 2147483648, 1007.5, '1007', '', true, null, [], {}, '1; DROP TABLE game_users']) {
      assert.equal((await call(actor.accessToken, { scene }, 400)).message, 'INVALID_SOURCE_SCENE');
    }
    for (const body of [{}, [], { scene: 1007, userId: actor.user.id }, { scene: 1007, reportedAt: '2026-10-17' }]) {
      assert.equal((await call(actor.accessToken, body, 400)).message, 'INVALID_INVITE_REQUEST');
    }
    await request(app.getHttpServer()).post(route + '?scene=1007').set('Authorization', 'Bearer ' + actor.accessToken).send({ scene: 1007 }).expect(400);
    const malformed = await request(app.getHttpServer()).post(route).set('Authorization', 'Bearer ' + actor.accessToken)
      .set('Content-Type', 'application/json').send('{broken-json').expect(400);
    assert.equal(malformed.body.message, 'INVALID_JSON');
    assert.deepEqual(await stored(actor.user.id), { source_scene: null, source_scene_reported_at: null });
    for (const scene of [1, 2147483647]) {
      const edge = await login('scene_edge_' + scene);
      assert.equal((await call(edge.accessToken, { scene })).scene, scene);
    }
  });

  await t.test('competing API instances preserve exactly one source; identical concurrent reports are idempotent', async () => {
    const actor = await login('scene_race');
    const responses = await Promise.all([app, secondApp].map((server, index) => request(server.getHttpServer())
      .post(route).set('Authorization', 'Bearer ' + actor.accessToken).send({ scene: 1007 + index })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const winner = responses.find(r => r.status === 200)!.body;
    assert.equal(responses.find(r => r.status === 409)!.body.message, 'SOURCE_SCENE_ALREADY_RECORDED');
    assert.equal((await stored(actor.user.id)).source_scene, winner.scene);
    const same = await login('scene_same_race');
    const parallel = await Promise.all(Array.from({ length: 6 }, (_, index) => call(same.accessToken, { scene: 1007 }, 200, index % 2 ? app : secondApp)));
    assert.equal(parallel.filter(r => !r.alreadyRecorded).length, 1);
    assert.equal(new Set(parallel.map(r => r.reportedAt)).size, 1);
    const laterSession = await login('scene_same_race');
    assert.equal((await call(laterSession.accessToken, { scene: 1007 })).alreadyRecorded, true);
  });

  await t.test('source metadata and invitation attribution remain independent in either reporting order', async () => {
    const inviter = await login('scene_inviter');
    for (const sourceFirst of [true, false]) {
      const actor = await login('scene_and_invite_' + sourceFirst);
      const report = () => request(app.getHttpServer()).post(prefix + 'invites/report')
        .set('Authorization', 'Bearer ' + actor.accessToken).send({ inviterUid: inviter.user.id }).expect(200);
      if (sourceFirst) { await call(actor.accessToken, { scene: 1007 }); assert.equal((await report()).body.accepted, true); }
      else { assert.equal((await report()).body.accepted, true); await call(actor.accessToken, { scene: 1007 }); }
      assert.equal((await stored(actor.user.id)).source_scene, 1007);
    }
  });

  await t.test('missing, foreign-app, expired and deleted-user sessions cannot set attribution', async () => {
    await request(app.getHttpServer()).post(route).send({ scene: 1007 }).expect(401);
    const actor = await login('scene_auth'); const key = sessionKey(actor.accessToken);
    const raw = (await redis.get(key))!; const value = JSON.parse(raw);
    await redis.set(key, JSON.stringify({ ...value, appId: 'wx1111111111111111' }), { EX: 60 });
    await call(actor.accessToken, { scene: 1007 }, 401);
    await redis.del(key); await call(actor.accessToken, { scene: 1007 }, 401);
    await redis.set(key, raw, { EX: 60 });
    await pool.query('DELETE FROM game_users WHERE id=$1', [actor.user.id]);
    await call(actor.accessToken, { scene: 1007 }, 401);
  });

  await t.test('storage failures return sanitized errors without partially writing a source', async () => {
    const actor = await login('scene_failure');
    const infra = app.get(Infrastructure);
    const query = infra.pool.query;
    try {
      (infra.pool as any).query = async () => { throw new Error('private-storage-details-must-not-leak'); };
      const response = await call(actor.accessToken, { scene: 1007 }, 503);
      assert.equal(response.message, 'INVITE_STORAGE_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(response), /private-storage-details/);
    } finally { infra.pool.query = query; }
    assert.deepEqual(await stored(actor.user.id), { source_scene: null, source_scene_reported_at: null });
    assert.equal((await call(actor.accessToken, { scene: 1007 })).alreadyRecorded, false);
  });
});
