import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/database/migrate.js';

// Disposable isolated PostgreSQL/Redis only (compose.test.yaml, project minigame-login-test).
const TEST_URL = 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
const TEST_REDIS = 'redis://127.0.0.1:16389/15';
const BUILD_DIR = resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist');
const RATE_LIMIT = 1000;

// Login (optional scene) must stay a single-use-code, session-issuing endpoint whose
// first-registration source scene rides in the SAME transaction as registration, the
// session and the daily-login row. All assertions run against compiled JS + real storage
// with the least-privilege runtime role, never the production/staging services.
test('login scene: first-registration source scene persisted in the existing login transaction', async t => {
  const owner = new Pool({ connectionString: TEST_URL });
  const admin = createClient({ url: TEST_REDIS });
  admin.on('error', () => {});
  const suffix = randomBytes(6).toString('hex');
  const role = 'login_scene_' + suffix;
  const appId = 'wx' + randomBytes(8).toString('hex');
  const appIds = [appId];
  const tokens: string[] = [];
  let app: any;
  let loginCalls = 0;
  let upstreamCalls = 0;

  const config = loadConfig({
    WECHAT_APP_ID: appId,
    WECHAT_APP_SECRET: 'explicit-login-scene-stub',
    DATABASE_URL: `postgresql://${role}:isolated-login-scene-only@127.0.0.1:15439/minigame_test`,
    REDIS_URL: TEST_REDIS,
    LOGIN_RATE_LIMIT: String(RATE_LIMIT),
  });

  try {
    await migrate(owner);
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-login-scene-only'`);
    // Least privilege: no DELETE/DDL, matching the deployed runtime role.
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE ON game_users,game_profiles TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT ON game_daily_logins TO ${role}`);
    await owner.query(`GRANT INSERT ON game_login_events TO ${role}`);
    await admin.connect();

    const { createApplication } = await import(pathToFileURL(resolve(BUILD_DIR, 'application.js')).href);
    const { WechatClient } = await import(pathToFileURL(resolve(BUILD_DIR, 'auth/wechat.client.js')).href);
    // The code is only an openid here; no real WeChat transport or credential is used.
    const wechat = new WechatClient(config, async (input: URL | RequestInfo) =>
      (upstreamCalls++, Response.json({
        openid: new URL(String(input)).searchParams.get('js_code'), session_key: 'private-login-scene-key',
      })));
    app = await createApplication(config, { wechat });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/`;
    const sessionKey = (token: string) => 'minigame:session:' + createHash('sha256').update(token).digest('hex');

    async function call(body: unknown, status = 200) {
      loginCalls++;
      const response = await fetch(base + 'auth/wechat-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      assert.equal(response.status, status, `unexpected status for ${JSON.stringify(body)}`);
      const data = await response.json() as any;
      if (data.accessToken) tokens.push(data.accessToken);
      assert.doesNotMatch(JSON.stringify(data), /private-login-scene-key|explicit-login-scene-stub|session_key/);
      return data;
    }
    async function stored(openid: string, app = appId) {
      const rows = (await owner.query(
        'SELECT source_scene,source_scene_reported_at FROM game_users WHERE app_id=$1 AND open_id=$2', [app, openid])).rows;
      assert.equal(rows.length, 1, `expected exactly one ${app}/${openid} row`);
      return rows[0];
    }
    async function dbNow(): Promise<Date> {
      return (await owner.query('SELECT clock_timestamp() AS now')).rows[0].now;
    }
    async function full(openid: string, app = appId) {
      const rows = (await owner.query(
        `SELECT source_scene,source_scene_reported_at,last_client_version,first_login_completed
         FROM game_users WHERE app_id=$1 AND open_id=$2`, [app, openid])).rows;
      assert.equal(rows.length, 1, `expected exactly one ${app}/${openid} row`);
      return rows[0];
    }
    const publicUser = (body: any) => Object.keys(body).sort();

    await t.test('a newly registered login carrying scene persists it with the database clock', async () => {
      const openid = 'scene_new_' + suffix;
      const before = await dbNow();
      const body = await call({ code: openid, scene: 1007 });
      const after = await dbNow();
      assert.equal(body.isNewUser, true);
      // Response shape is unchanged: scene is never echoed back nor used as identity.
      assert.deepEqual(publicUser(body), ['accessToken', 'expiresIn', 'isNewUser', 'tokenType', 'user']);
      assert.deepEqual(Object.keys(body.user).sort(), ['avatarUrl', 'id', 'nickname', 'openid']);
      assert.equal(body.scene, undefined);
      const row = await stored(openid);
      assert.equal(row.source_scene, 1007);
      assert.ok(row.source_scene_reported_at instanceof Date, 'reported_at must be a timestamp');
      assert.ok(row.source_scene_reported_at >= before && row.source_scene_reported_at <= after,
        'reported_at must come from the database clock inside the login transaction');
      // Redis session payload stays server-owned and identical to the pre-scene contract.
      const session = JSON.parse((await admin.get('minigame:session:' + createHash('sha256').update(body.accessToken).digest('hex')))!);
      assert.deepEqual(Object.keys(session).sort(), ['appId', 'isNewUser', 'issuedAt', 'userId']);
      assert.equal(session.userId, body.user.id);
      assert.equal(session.isNewUser, true);
    });

    await t.test('a completed historical user with no recorded scene is never backfilled by a later login', async () => {
      // Rows registered before scene reporting existed stay NULL: migration defaults
      // first_login_completed to true, so no current launch may claim their source.
      const legacyOpenid = 'scene_legacy_' + suffix;
      await owner.query('INSERT INTO game_users(app_id,open_id,first_login_completed) VALUES($1,$2,true)',
        [appId, legacyOpenid]);
      const legacy = await call({ code: legacyOpenid, scene: 1007 });
      assert.equal(legacy.isNewUser, false);
      assert.deepEqual(await stored(legacyOpenid), { source_scene: null, source_scene_reported_at: null });

      // Same for an account registered by a client that did not send a scene at all.
      const omittedOpenid = 'scene_omitted_' + suffix;
      assert.equal((await call({ code: omittedOpenid })).isNewUser, true);
      const later = await call({ code: omittedOpenid, scene: 1008 });
      assert.equal(later.isNewUser, false);
      assert.deepEqual(await stored(omittedOpenid), { source_scene: null, source_scene_reported_at: null });
    });

    await t.test('scene is a strict JSON integer 1..2147483647 and is rejected before any exchange', async () => {
      const exchangesBefore = upstreamCalls;
      const rejected = [0, -1, 2147483648, -2147483649, 1007.5, '1007', true, false, '', ' ', ' 1007', [], {}, null];
      for (const [index, scene] of rejected.entries()) {
        const openid = `scene_invalid_${index}_` + suffix;
        const body = await call({ code: openid, scene }, 400);
        assert.equal(body.accessToken, undefined);
        assert.equal(body.isNewUser, undefined);
        assert.doesNotMatch(JSON.stringify(body), new RegExp(openid));
        // No exchange means no registration row was attempted for a rejected payload.
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_users WHERE app_id=$1 AND open_id=$2',
          [appId, openid])).rows[0].n, 0);
      }
      // A rejected payload must stop before the one-use WeChat code is consumed.
      assert.equal(upstreamCalls, exchangesBefore, 'invalid scenes must not trigger a WeChat exchange');
    });

    await t.test('the exclusive integer bounds are accepted and stored verbatim', async () => {
      for (const scene of [1, 2147483647]) {
        const openid = `scene_bound_${scene}_` + suffix;
        const body = await call({ code: openid, scene });
        assert.equal(body.isNewUser, true);
        assert.equal((await stored(openid)).source_scene, scene);
      }
    });

    await t.test('a later login never replaces the first scene and is never refused for a different value', async () => {
      const openid = 'scene_keep_' + suffix;
      const first = await call({ code: openid, scene: 1007 });
      assert.equal(first.isNewUser, true);
      const original = await stored(openid);
      assert.equal(original.source_scene, 1007);
      for (const scene of [1008, 2000, 1, 2147483647]) {
        const later = await call({ code: openid, scene });
        assert.equal(later.isNewUser, false);
        assert.ok(later.accessToken);
        // The stored value and its timestamp stay byte-identical: no rewrite, no rejection.
        assert.deepEqual(await stored(openid), original);
      }
      const legacyShape = await call({ code: openid });
      assert.ok(legacyShape.accessToken);
      assert.deepEqual(await stored(openid), original);
    });

    await t.test('legacy code-only and clientVersion requests keep their documented behavior', async () => {
      const legacyOpenid = 'scene_client_legacy_' + suffix;
      const legacy = await call({ code: legacyOpenid });
      assert.equal(legacy.isNewUser, true);
      assert.deepEqual(publicUser(legacy), ['accessToken', 'expiresIn', 'isNewUser', 'tokenType', 'user']);
      const legacyRow = await full(legacyOpenid);
      assert.deepEqual(legacyRow, {
        source_scene: null, source_scene_reported_at: null, last_client_version: null, first_login_completed: true,
      });

      const versionedOpenid = 'scene_client_version_' + suffix;
      const versioned = await call({ code: versionedOpenid, clientVersion: '2.0.7', scene: 1007 });
      assert.equal(versioned.isNewUser, true);
      let row = await full(versionedOpenid);
      assert.equal(row.last_client_version, '2.0.7');
      assert.equal(row.source_scene, 1007);
      // An older client that only starts reporting its version later must not disturb the scene.
      const versionOnly = await call({ code: versionedOpenid, clientVersion: '2.0.8' });
      assert.equal(versionOnly.isNewUser, false);
      row = await full(versionedOpenid);
      assert.equal(row.last_client_version, '2.0.8');
      assert.equal(row.source_scene, 1007);
      await call({ code: versionedOpenid });
      row = await full(versionedOpenid);
      assert.equal(row.last_client_version, '2.0.8');
      assert.equal(row.source_scene, 1007);
    });

    await t.test('scene stays a top-level request field and cannot carry identity or aliases', async () => {
      const openid = 'scene_shape_' + suffix;
      const accepted = await call({ code: openid, scene: 1007 });
      const uid = accepted.user.id;
      for (const body of [
        { code: openid, scene: 1008, sourceScene: 1008 },
        { code: openid, scene: 1008, source_scene: 1008 },
        { code: openid, scene: 1008, sceneId: 1008 },
        { code: openid, scene: 1008, userId: uid },
        { code: openid, scene: 1008, appId },
        { code: openid, scene: 1008, reportedAt: '2026-10-28T00:00:00.000Z' },
      ]) {
        const rejected = await call(body, 400);
        assert.equal(rejected.accessToken, undefined);
      }
      assert.equal((await stored(openid)).source_scene, 1007);
    });

    await t.test('the independent /users/source-scene endpoint keeps its first-session contract', async () => {
      async function report(token: string, scene: unknown, status = 200) {
        const response = await fetch(base + 'users/source-scene', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ scene }), signal: AbortSignal.timeout(8000),
        });
        assert.equal(response.status, status);
        return await response.json() as any;
      }

      // Registered with a login scene: the endpoint returns the original receipt, and a
      // different value still conflicts exactly as it did before login carried a scene.
      const withScene = await call({ code: 'scene_both_' + suffix, scene: 1007 });
      const receipt = await report(withScene.accessToken, 1007);
      assert.equal(receipt.alreadyRecorded, true);
      assert.equal(receipt.scene, 1007);
      assert.equal((await stored('scene_both_' + suffix)).source_scene, 1007);
      assert.equal((await report(withScene.accessToken, 1008, 409)).message, 'SOURCE_SCENE_ALREADY_RECORDED');

      // Registered without a scene: the first session can still report it once.
      const openid = 'scene_report_' + suffix;
      const fresh = await call({ code: openid });
      assert.equal(fresh.isNewUser, true);
      const first = await report(fresh.accessToken, 1007);
      assert.equal(first.alreadyRecorded, false);
      assert.equal((await stored(openid)).source_scene, 1007);

      // A later, non-new session still cannot first-fill an empty slot.
      const emptyOpenid = 'scene_report_later_' + suffix;
      await call({ code: emptyOpenid });
      const later = await call({ code: emptyOpenid });
      assert.equal(later.isNewUser, false);
      assert.equal((await report(later.accessToken, 1007, 403)).message, 'SOURCE_SCENE_NOT_NEW_USER');
      assert.equal((await stored(emptyOpenid)).source_scene, null);
    });

    await t.test('storage failures roll back the scene with registration, session and daily login', async () => {
      const sessionsBefore = (await admin.keys('minigame:session:*')).sort();
      const openid = 'scene_rollback_' + suffix;
      await owner.query(`REVOKE INSERT ON game_daily_logins FROM ${role}`);
      try {
        const failure = await call({ code: openid, scene: 1007 }, 503);
        assert.equal(failure.message, 'LOGIN_STORAGE_UNAVAILABLE');
        assert.equal(failure.accessToken, undefined);
        assert.doesNotMatch(JSON.stringify(failure), /game_daily_logins|permission|postgres|private-login-scene/);
      } finally {
        await owner.query(`GRANT INSERT ON game_daily_logins TO ${role}`);
      }
      // Nothing may survive: no user row (so no scene), no session key.
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_users WHERE app_id=$1 AND open_id=$2',
        [appId, openid])).rows[0].n, 0);
      assert.deepEqual((await admin.keys('minigame:session:*')).sort(), sessionsBefore);
      // The retry is still a first registration and may record the scene.
      const retry = await call({ code: openid, scene: 1007 });
      assert.equal(retry.isNewUser, true);
      assert.equal((await stored(openid)).source_scene, 1007);
      // A failed re-login of an already-registered user keeps the original scene/timestamp.
      const original = await stored(openid);
      await owner.query(`REVOKE INSERT ON game_daily_logins FROM ${role}`);
      try { await call({ code: openid, scene: 1008 }, 503); } finally {
        await owner.query(`GRANT INSERT ON game_daily_logins TO ${role}`);
      }
      assert.deepEqual(await stored(openid), original);
    });

    await t.test('concurrent logins with different scenes register once and keep the winning scene', async () => {
      const openid = 'scene_race_' + suffix;
      const scenes = [1007, 1008, 1009, 1010];
      const results = await Promise.all(scenes.map(scene => call({ code: openid, scene })));
      assert.equal(new Set(results.map(result => result.user.id)).size, 1);
      const winners = results.map((result, index) => result.isNewUser ? index : -1).filter(index => index >= 0);
      assert.equal(winners.length, 1, 'exactly one concurrent login may complete first registration');
      // The stored scene belongs to the login that won first registration, not to a loser.
      assert.equal((await stored(openid)).source_scene, scenes[winners[0]!]);

      const sameOpenid = 'scene_race_same_' + suffix;
      const parallel = await Promise.all(Array.from({ length: 6 }, () => call({ code: sameOpenid, scene: 2000 })));
      assert.equal(parallel.filter(result => result.isNewUser).length, 1);
      assert.equal(new Set(parallel.map(result => result.user.id)).size, 1);
      assert.equal((await stored(sameOpenid)).source_scene, 2000);
    });

    await t.test('a login scene writes only the current app row, never a foreign app with the same openid', async () => {
      const foreignApp = 'wx' + randomBytes(8).toString('hex');
      appIds.push(foreignApp);
      const openid = 'scene_crossapp_' + suffix;
      await owner.query(
        `INSERT INTO game_users(app_id,open_id,first_login_completed,source_scene,source_scene_reported_at)
         VALUES($1,$2,true,555,clock_timestamp())`, [foreignApp, openid]);
      const foreignBefore = await full(openid, foreignApp);
      const local = await call({ code: openid, scene: 1007 });
      assert.equal(local.isNewUser, true);
      assert.equal((await stored(openid)).source_scene, 1007);
      assert.deepEqual(await full(openid, foreignApp), foreignBefore);
    });

    await t.test('the existing 004 write-once trigger and constraints remain the only scene schema', async () => {
      const openid = 'scene_immutable_' + suffix;
      const created = await call({ code: openid, scene: 1007 });
      const uid = created.user.id;
      for (const sql of [
        'UPDATE game_users SET source_scene=1008 WHERE id=$1',
        'UPDATE game_users SET source_scene_reported_at=clock_timestamp() WHERE id=$1',
        'UPDATE game_users SET source_scene=NULL, source_scene_reported_at=NULL WHERE id=$1',
      ]) {
        await assert.rejects(() => owner.query(sql, [uid]), /Source scene is immutable/);
      }
      assert.equal((await stored(openid)).source_scene, 1007);
      const trigger = (await owner.query(
        `SELECT tgname FROM pg_trigger WHERE tgrelid='game_users'::regclass AND NOT tgisinternal
           AND tgname='game_users_source_scene_write_once'`)).rows;
      assert.deepEqual(trigger, [{ tgname: 'game_users_source_scene_write_once' }]);
      const constraints = (await owner.query(
        `SELECT conname FROM pg_constraint WHERE conrelid='game_users'::regclass AND contype='c'
           AND conname LIKE 'game_users_source_scene%' ORDER BY conname`)).rows.map(row => row.conname);
      assert.deepEqual(constraints, ['game_users_source_scene_pair', 'game_users_source_scene_positive']);
      const migrations = (await readdir('migrations')).filter(file => /scene/i.test(file));
      assert.deepEqual(migrations, ['004_source_scene.sql'], 'no new migration may be added for the login scene');
    });

    await t.test('the runtime role stays least privilege and the suite stays inside the login rate budget', async () => {
      const privileges = (await owner.query(
        `SELECT has_table_privilege($1,'game_users','SELECT') AS s, has_table_privilege($1,'game_users','INSERT') AS i,
                has_table_privilege($1,'game_users','UPDATE') AS u, has_table_privilege($1,'game_users','DELETE') AS d,
                has_table_privilege($1,'game_users','TRUNCATE') AS t`, [role])).rows[0];
      assert.deepEqual(privileges, { s: true, i: true, u: true, d: false, t: false });
      assert.ok(loginCalls <= RATE_LIMIT, `login calls ${loginCalls} exceeded the ${RATE_LIMIT}/min budget`);
      console.log(`login-scene: ${loginCalls} login requests used of ${RATE_LIMIT}/min budget, ${upstreamCalls} WeChat exchanges`);
    });
  } finally {
    if (app) await app.close();
    for (const token of tokens) await admin.del('minigame:session:' + createHash('sha256').update(token).digest('hex')).catch(() => {});
    if (admin.isOpen) await admin.quit();
    await owner.query('DELETE FROM game_daily_logins WHERE app_id=$1', [appId]).catch(() => {});
    await owner.query('DELETE FROM game_users WHERE app_id=$1', [appId]).catch(() => {});
    for (const extra of appIds.slice(1)) {
      await owner.query('DELETE FROM game_daily_logins WHERE app_id=$1', [extra]).catch(() => {});
      await owner.query('DELETE FROM game_users WHERE app_id=$1', [extra]).catch(() => {});
    }
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE ${role}`).catch(() => {});
    await owner.end();
  }
});
