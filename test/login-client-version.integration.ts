import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, copyFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/database/migrate.js';

// Disposable test PostgreSQL/Redis only (compose.test.yaml, project minigame-login-test).
const TEST_URL = 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
const TEST_REDIS = 'redis://127.0.0.1:16389/15';
const BUILD_DIR = resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist');
const RATE_LIMIT_PER_MINUTE = 120;

test('login accepts an optional clientVersion, persists only the latest supplied value and rolls it back with failed logins', async () => {
  const owner = new Pool({ connectionString: TEST_URL });
  const admin = createClient({ url: TEST_REDIS });
  admin.on('error', () => {});
  const suffix = randomBytes(6).toString('hex');
  const role = 'login_version_' + suffix;
  const appId = 'wx' + randomBytes(8).toString('hex');
  const foreignApp = 'wx' + randomBytes(8).toString('hex');
  const tokens: string[] = [];
  let upstreamCalls = 0;
  let loginCalls = 0;
  let app: any;

  const config = loadConfig({
    WECHAT_APP_ID: appId,
    WECHAT_APP_SECRET: 'explicit-client-version-stub',
    DATABASE_URL: `postgresql://${role}:isolated-client-version-only@127.0.0.1:15439/minigame_test`,
    REDIS_URL: TEST_REDIS,
  });

  try {
    await migrate(owner);
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-client-version-only'`);
    // Least privilege: the runtime role may not delete or truncate players.
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE ON game_users,game_profiles TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT ON game_daily_logins TO ${role}`);
    await owner.query(`GRANT INSERT ON game_login_events TO ${role}`);
    await admin.connect();

    const { createApplication } = await import(pathToFileURL(resolve(BUILD_DIR, 'application.js')).href);
    const { WechatClient } = await import(pathToFileURL(resolve(BUILD_DIR, 'auth/wechat.client.js')).href);
    const { Infrastructure } = await import(pathToFileURL(resolve(BUILD_DIR, 'infrastructure.js')).href);
    // The code is only an openid here; no real WeChat transport or production credential is used.
    const wechat = new WechatClient(config, async (input: URL | RequestInfo) => {
      upstreamCalls++;
      return Response.json({ openid: new URL(String(input)).searchParams.get('js_code'), session_key: 'private-client-version-key' });
    });
    app = await createApplication(config, { wechat });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/`;

    async function call(body: unknown, status = 200) {
      loginCalls++;
      const response = await fetch(base + 'auth/wechat-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      assert.equal(response.status, status, `unexpected status for ${JSON.stringify(body)}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const data = await response.json() as any;
      if (data.accessToken) tokens.push(data.accessToken);
      assert.doesNotMatch(JSON.stringify(data), /private-client-version-key|explicit-client-version-stub|session_key/);
      return data;
    }
    async function storedVersion(openid: string, app = appId) {
      const rows = (await owner.query('SELECT last_client_version FROM game_users WHERE app_id=$1 AND open_id=$2', [app, openid])).rows;
      assert.equal(rows.length, 1, `expected exactly one ${app}/${openid} row`);
      return rows[0].last_client_version;
    }

    await test('a new user stores the reported version and the login response shape is unchanged', async () => {
      const openid = 'version_new_' + suffix;
      const body = await call({ code: openid, clientVersion: '1.0.0' });
      assert.equal(body.isNewUser, true);
      assert.deepEqual(Object.keys(body).sort(), ['accessToken', 'expiresIn', 'isNewUser', 'tokenType', 'user']);
      assert.deepEqual(Object.keys(body.user).sort(), ['avatarUrl', 'id', 'nickname', 'openid']);
      assert.equal(body.clientVersion, undefined);
      assert.equal(body.lastClientVersion, undefined);
      assert.equal(await storedVersion(openid), '1.0.0');
      // Session payload stays server-owned: adding a version must not leak into tokens.
      const session = JSON.parse((await admin.get('minigame:session:' + createHash('sha256').update(body.accessToken).digest('hex')))!);
      assert.deepEqual(Object.keys(session).sort(), ['appId', 'isNewUser', 'issuedAt', 'userId']);
      assert.equal(session.userId, body.user.id);
    });

    await test('omitting the field keeps a previously reported version and legacy {code} login still works', async () => {
      const openid = 'version_new_' + suffix;
      const omitted = await call({ code: openid });
      assert.equal(omitted.isNewUser, false);
      assert.equal(await storedVersion(openid), '1.0.0');
      const legacyAgain = await call({ code: openid });
      assert.equal(legacyAgain.isNewUser, false);
      assert.equal(await storedVersion(openid), '1.0.0');
      assert.equal(legacyAgain.user.id, omitted.user.id);
    });

    await test('a brand new user may still log in with only the legacy code field', async () => {
      const openid = 'version_legacy_' + suffix;
      const body = await call({ code: openid });
      assert.equal(body.isNewUser, true);
      assert.equal(await storedVersion(openid), null);
    });

    await test('explicit null, empty, padded and non-string versions are rejected before contacting WeChat', async () => {
      const openid = 'version_new_' + suffix;
      const before = upstreamCalls;
      for (const clientVersion of [null, '', ' ', ' 1.0.0', '1.0.0 ', '\t1.0.0', '\n', 1, 0, 1.5, true, false, [], {}, ['1.0.0'], { version: '1.0.0' }]) {
        const rejected = await call({ code: openid, clientVersion }, 400);
        assert.equal(rejected.accessToken, undefined);
        assert.equal(rejected.isNewUser, undefined);
        assert.doesNotMatch(JSON.stringify(rejected), /version_new_|private-client-version/);
      }
      assert.equal(upstreamCalls, before, 'invalid versions must not trigger a WeChat exchange');
      assert.equal(await storedVersion(openid), '1.0.0');
    });

    await test('the version grammar accepts boundaries and rejects lookalikes', async () => {
      const openid = 'version_grammar_' + suffix;
      const accepted = ['1', '0', '9.9.9-beta.1+build.5', 'a.b_c+d-e', 'A' + 'b'.repeat(63)];
      for (const clientVersion of accepted) {
        const body = await call({ code: openid, clientVersion });
        assert.equal(body.isNewUser, accepted.indexOf(clientVersion) === 0);
        assert.equal(await storedVersion(openid), clientVersion);
      }
      const rejected = ['A' + 'b'.repeat(64), '.1.0', '-1.0', '_1.0', '+1.0', '1 0', '1.0.0\n', '1.0.0\nx',
        '1.0.0/x', '1,0', '版本1.0', '１.０', 'v1.0.0'.repeat(12)];
      for (const clientVersion of rejected) {
        await call({ code: openid, clientVersion }, 400);
        assert.equal(await storedVersion(openid), 'A' + 'b'.repeat(63));
      }
    });

    await test('unknown keys and client-supplied identity are still rejected', async () => {
      const openid = 'version_new_' + suffix;
      const userId = (await owner.query('SELECT id FROM game_users WHERE app_id=$1 AND open_id=$2', [appId, openid])).rows[0].id;
      for (const body of [
        { code: openid, clientVersion: '2.0.0', lastClientVersion: '9.9.9' },
        { code: openid, clientVersion: '2.0.0', client_version: '9.9.9' },
        { code: openid, clientVersion: '2.0.0', version: '2.0.0' },
        { code: openid, clientVersion: '2.0.0', userId, appId },
      ]) {
        await call(body, 400);
      }
      assert.equal(await storedVersion(openid), '1.0.0');
    });

    await test('the same openid in another app keeps an independent version', async () => {
      const openid = 'version_foreign_' + suffix;
      const foreignId = (await owner.query('INSERT INTO game_users(app_id,open_id,last_client_version) VALUES($1,$2,$3) RETURNING id',
        [foreignApp, openid, 'foreign-9.9'])).rows[0].id;
      const local = await call({ code: openid, clientVersion: '1.2.3' });
      assert.notEqual(local.user.id, foreignId);
      assert.equal(local.isNewUser, true);
      assert.equal(await storedVersion(openid), '1.2.3');
      assert.equal(await storedVersion(openid, foreignApp), 'foreign-9.9');
      await call({ code: openid });
      assert.equal(await storedVersion(openid), '1.2.3');
      assert.equal(await storedVersion(openid, foreignApp), 'foreign-9.9');
    });

    await test('concurrent supplied and omitted logins converge on the supplied version', async () => {
      const openid = 'version_race_' + suffix;
      const bodies = Array.from({ length: 8 }, (_, i) => i % 2 === 0 ? { code: openid, clientVersion: 'race-2.0' } : { code: openid });
      const results = await Promise.all(bodies.map(body => call(body)));
      assert.equal(new Set(results.map(result => result.user.id)).size, 1);
      assert.equal(results.filter(result => result.isNewUser).length, 1);
      assert.equal(await storedVersion(openid), 'race-2.0');
    });

    await test('a failed profile read rolls back the version and issues no session', async () => {
      const openid = 'version_profile_failure_' + suffix;
      await call({ code: openid, clientVersion: 'keep-1.0' });
      const sessionsBefore = (await admin.keys('minigame:session:*')).sort();
      await owner.query(`REVOKE SELECT ON game_profiles FROM ${role}`);
      try {
        const failure = await call({ code: openid, clientVersion: 'poison-2.0' }, 503);
        assert.equal(failure.message, 'LOGIN_STORAGE_UNAVAILABLE');
        assert.equal(failure.accessToken, undefined);
        assert.doesNotMatch(JSON.stringify(failure), /game_profiles|permission|SELECT|postgres/);
      } finally {
        await owner.query(`GRANT SELECT ON game_profiles TO ${role}`);
      }
      assert.equal(await storedVersion(openid), 'keep-1.0');
      assert.deepEqual((await admin.keys('minigame:session:*')).sort(), sessionsBefore);
    });

    await test('a failed session write rolls back the version of an existing user', async () => {
      const openid = 'version_redis_failure_' + suffix;
      await call({ code: openid, clientVersion: 'keep-1.0' });
      let broken: any;
      const failAfterExchange = new WechatClient(config, async () => {
        broken.get(Infrastructure).redis.destroy();
        return Response.json({ openid, session_key: 'private-client-version-key' });
      });
      broken = await createApplication(config, { wechat: failAfterExchange });
      try {
        await broken.listen(0, '127.0.0.1');
        loginCalls++;
        const response = await fetch(`http://127.0.0.1:${broken.getHttpServer().address().port}/h5login/api/auth/wechat-login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'unused-code', clientVersion: 'poison-2.0' }), signal: AbortSignal.timeout(8000),
        });
        assert.equal(response.status, 503);
        const failure = await response.json() as any;
        assert.equal(failure.message, 'LOGIN_STORAGE_UNAVAILABLE');
        assert.equal(failure.accessToken, undefined);
      } finally {
        await broken.close();
      }
      assert.equal(await storedVersion(openid), 'keep-1.0');
    });

    await test('an overlong version is rejected by the database instead of being silently truncated', async () => {
      const { AuthService } = await import(pathToFileURL(resolve(BUILD_DIR, 'auth/auth.service.js')).href);
      const openid = 'version_overlong_' + suffix;
      const service = app.get(AuthService);
      await assert.rejects(() => service.login(openid, 'a'.repeat(65)), 'overlong versions must not be stored truncated');
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_users WHERE app_id=$1 AND open_id=$2', [appId, openid])).rows[0].n, 0);
    });

    await test('the runtime role stays least privilege and this suite stays inside the login rate budget', async () => {
      const privileges = (await owner.query(
        `SELECT has_table_privilege($1,'game_users','SELECT') AS s, has_table_privilege($1,'game_users','INSERT') AS i,
                has_table_privilege($1,'game_users','UPDATE') AS u, has_table_privilege($1,'game_users','DELETE') AS d,
                has_table_privilege($1,'game_users','TRUNCATE') AS t`, [role])).rows[0];
      assert.deepEqual(privileges, { s: true, i: true, u: true, d: false, t: false });
      assert.ok(loginCalls <= RATE_LIMIT_PER_MINUTE, `login calls ${loginCalls} exceeded the ${RATE_LIMIT_PER_MINUTE}/min budget`);
      console.log(`login-client-version: ${loginCalls} login requests used of ${RATE_LIMIT_PER_MINUTE}/min budget`);
    });
  } finally {
    if (app) await app.close();
    for (const token of tokens) await admin.del('minigame:session:' + createHash('sha256').update(token).digest('hex')).catch(() => {});
    if (admin.isOpen) await admin.quit();
    await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])', [[appId, foreignApp]]);
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE ${role}`).catch(() => {});
    await owner.end();
  }
});

test('the client version migration preserves legacy rows, constrains new values and is idempotent', async t => {
  const admin = new Pool({ connectionString: TEST_URL });
  const name = 'login_version_upgrade_' + randomBytes(6).toString('hex');
  const previous = await mkdtemp(join(tmpdir(), 'minigame-pre-client-version-'));
  let target: Pool | undefined;
  let created = false;
  try {
    for (const file of (await readdir('migrations')).filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file) && Number(file.slice(0, 3)) < 11)) {
      await copyFile(join('migrations', file), join(previous, file));
    }
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const url = new URL(TEST_URL); url.pathname = '/' + name;
    target = new Pool({ connectionString: url.href });
    const db = target;
    await migrate(db, previous);
    const legacy = (await db.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',
      ['wx2222222222222222', 'pre_client_version_legacy'])).rows[0].id;
    const save = '{"kept":9007199254740993123}\n';
    await db.query("INSERT INTO game_saves(user_id,data,version) VALUES($1,$2,4)", [legacy, save]);
    const history = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;

    await migrate(db);

    await t.test('legacy rows stay unknown instead of being given a fabricated version', async () => {
      const columns = await db.query(`SELECT data_type,character_maximum_length,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='game_users' AND column_name='last_client_version'`);
      assert.deepEqual(columns.rows, [{ data_type: 'character varying', character_maximum_length: 64, is_nullable: 'YES' }]);
      const row = (await db.query('SELECT last_client_version,first_login_completed FROM game_users WHERE id=$1', [legacy])).rows[0];
      assert.deepEqual(row, { last_client_version: null, first_login_completed: true });
      assert.deepEqual((await db.query('SELECT data,version FROM game_saves WHERE user_id=$1', [legacy])).rows[0], { data: save, version: 4 });
      const prior = await db.query('SELECT name,checksum FROM schema_migrations WHERE name=ANY($1::text[]) ORDER BY name', [history.map(row => row.name)]);
      assert.deepEqual(prior.rows, history);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='011_login_client_version.sql'")).rows[0].n, 1);
    });

    await t.test('the database enforces the same version grammar as the API', async () => {
      const accepted = ['1', '9.9.9-beta.1+build.5', 'a.b_c+d-e', 'A' + 'b'.repeat(63)];
      for (const version of accepted) {
        await db.query('UPDATE game_users SET last_client_version=$1 WHERE id=$2', [version, legacy]);
        assert.equal((await db.query('SELECT last_client_version FROM game_users WHERE id=$1', [legacy])).rows[0].last_client_version, version);
      }
      const rejected = ['', ' 1.0.0', '1.0.0 ', '.1.0', '-1.0', '_1.0', '+1.0', '1 0', '1.0.0\n', '1.0.0/x', '版本1.0', 'A' + 'b'.repeat(64)];
      for (const version of rejected) {
        await assert.rejects(() => db.query('UPDATE game_users SET last_client_version=$1 WHERE id=$2', [version, legacy]),
          `database must reject ${JSON.stringify(version)}`);
      }
      assert.equal((await db.query('SELECT last_client_version FROM game_users WHERE id=$1', [legacy])).rows[0].last_client_version, 'A' + 'b'.repeat(63));
      const constraints = (await db.query(`SELECT conname FROM pg_constraint WHERE conrelid='game_users'::regclass AND contype='c' AND conname='game_users_last_client_version_format'`)).rows;
      assert.equal(constraints.length, 1);
    });

    await t.test('the migration file and the migration runner are both re-runnable', async () => {
      const sql = await readFile(join('migrations', '011_login_client_version.sql'), 'utf8');
      await db.query(sql);
      await db.query(sql);
      await migrate(db);
      await migrate(db);
      const rows = (await db.query('SELECT last_client_version FROM game_users WHERE id=$1', [legacy])).rows;
      assert.deepEqual(rows, [{ last_client_version: 'A' + 'b'.repeat(63) }]);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='game_users'::regclass AND conname='game_users_last_client_version_format'")).rows[0].n, 1);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='011_login_client_version.sql'")).rows[0].n, 1);
      const fresh = (await db.query("INSERT INTO game_users(app_id,open_id) VALUES('wx2222222222222222','post_migration_user') RETURNING last_client_version")).rows[0];
      assert.deepEqual(fresh, { last_client_version: null });
    });
  } finally {
    if (target) await target.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    await rm(previous, { recursive: true, force: true });
  }
});
