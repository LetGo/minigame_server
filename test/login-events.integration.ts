import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
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
const RATE_LIMIT = 500;
const ROLE_PASSWORD = 'isolated-login-events-only';

// Every successful login must append one scene event, inside the SAME transaction that
// writes today's DAU row and (for new users) the first source. The event carries the exact
// last_login_at the transaction assigned, never a client- or application-clock value.
// All assertions run against compiled JS + real storage with a least-privilege runtime role.
test('login events: every successful login appends one scene event in the login transaction', async t => {
  const owner = new Pool({ connectionString: TEST_URL });
  const admin = createClient({ url: TEST_REDIS });
  admin.on('error', () => {});
  const suffix = randomBytes(6).toString('hex');
  const role = 'login_events_' + suffix;
  const appId = 'wx' + randomBytes(8).toString('hex');
  const appIds = [appId];
  const tokens: string[] = [];
  let app: any;
  let loginCalls = 0;
  let upstreamCalls = 0;

  const config = loadConfig({
    WECHAT_APP_ID: appId,
    WECHAT_APP_SECRET: 'explicit-login-events-stub',
    DATABASE_URL: `postgresql://${role}:${ROLE_PASSWORD}@127.0.0.1:15439/minigame_test`,
    REDIS_URL: TEST_REDIS,
    LOGIN_RATE_LIMIT: String(RATE_LIMIT),
  });

  try {
    await migrate(owner);
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${ROLE_PASSWORD}'`);
    // Least privilege: the login path only needs to append. No SELECT/UPDATE/DELETE here;
    // because `id` is GENERATED ALWAYS AS IDENTITY, appending must not require sequence
    // privileges either (asserted explicitly below).
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
        openid: new URL(String(input)).searchParams.get('js_code'), session_key: 'private-login-events-key',
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
      assert.doesNotMatch(JSON.stringify(data), /private-login-events-key|explicit-login-events-stub|session_key/);
      return data;
    }
    async function dbNow(): Promise<Date> {
      return (await owner.query('SELECT clock_timestamp() AS now')).rows[0].now;
    }
    // Exact microsecond value of the login timestamp, plus the user's locked last_login_at,
    // so equality is checked without JavaScript Date's millisecond rounding.
    async function eventRows(openid: string, app = appId) {
      return (await owner.query(
        `SELECT e.id, e.app_id::text AS app_id, e.user_id, e.scene, e.login_at::text AS login_at_text,
                (extract(epoch FROM e.login_at) * 1000000)::bigint AS epoch_us,
                u.open_id, u.last_login_at::text AS user_last_login_at_text
         FROM game_login_events e
         JOIN game_users u ON u.app_id = e.app_id AND u.id = e.user_id
         WHERE e.app_id = $1 AND u.open_id = $2
         ORDER BY e.id`, [app, openid])).rows;
    }
    async function userRow(openid: string, app = appId) {
      const rows = (await owner.query(
        `SELECT id, first_login_completed, last_login_at::text AS last_login_at_text,
                source_scene, source_scene_reported_at::text AS source_scene_reported_at
         FROM game_users WHERE app_id=$1 AND open_id=$2`, [app, openid])).rows;
      assert.equal(rows.length, 1, `expected exactly one ${app}/${openid} row`);
      return rows[0];
    }
    async function dailyRows(openid: string) {
      return (await owner.query(
        `SELECT l.activity_date::text AS activity_date, l.first_login_at::text AS first_login_at_text
         FROM game_daily_logins l JOIN game_users u ON u.app_id=l.app_id AND u.id=l.user_id
         WHERE l.app_id=$1 AND u.open_id=$2 ORDER BY l.activity_date`, [appId, openid])).rows;
    }

    await t.test('a new registration appends its scene event with the exact login timestamp', async () => {
      const openid = 'ev_new_' + suffix;
      const before = await dbNow();
      const body = await call({ code: openid, scene: 1007 });
      const after = await dbNow();
      assert.equal(body.isNewUser, true);
      // The public response contract is unchanged: the event is server-side only.
      assert.deepEqual(Object.keys(body).sort(), ['accessToken', 'expiresIn', 'isNewUser', 'tokenType', 'user']);

      const events = await eventRows(openid);
      assert.equal(events.length, 1, 'a successful login must append exactly one event');
      assert.equal(events[0].scene, 1007);
      assert.ok(events[0].login_at_text, 'login_at must be a stored timestamp');
      const user = await userRow(openid);
      assert.equal(events[0].login_at_text, user.last_login_at_text,
        'the event timestamp must be the exact last_login_at assigned by the login transaction');
      const loginAt: Date = new Date(events[0].login_at_text);
      assert.ok(loginAt >= before && loginAt <= after, 'login_at must come from the database clock');
      const daily = await dailyRows(openid);
      assert.equal(daily.length, 1);
      assert.equal(daily[0].first_login_at_text, events[0].login_at_text,
        'the daily and event rows must share one clock reading from the same transaction');
    });

    await t.test('every later login appends its own event and keeps a single daily row', async () => {
      const openid = 'ev_repeat_' + suffix;
      const scenes: (number | undefined)[] = [1007, 1008, undefined, 2001, 1007];
      const times: string[] = [];
      for (const scene of scenes) {
        const body = await call(scene === undefined ? { code: openid } : { code: openid, scene });
        assert.ok(body.accessToken);
        const events = await eventRows(openid);
        const user = await userRow(openid);
        const latest = events[events.length - 1];
        // Each successful login is recorded, including repeats of the same scene value.
        assert.equal(events.length, times.length + 1);
        assert.equal(latest.scene, scene ?? null, 'an omitted scene must be stored as NULL, not invented');
        assert.equal(latest.login_at_text, user.last_login_at_text);
        times.push(latest.login_at_text);
      }
      // Distinct visits are ordered, not collapsed or overwritten.
      assert.deepEqual((await eventRows(openid)).map(row => row.scene), [1007, 1008, null, 2001, 1007]);
      const epochs = (await eventRows(openid)).map(row => BigInt(row.epoch_us));
      for (let i = 1; i < epochs.length; i++) assert.ok(epochs[i]! > epochs[i - 1]!, 'login timestamps must increase');
      assert.equal(new Set(times).size, times.length, 'each login owns a distinct timestamp');
      // Daily DAU dedupe is untouched by the extra rows.
      const daily = await dailyRows(openid);
      assert.equal(daily.length, 1, 'repeat logins on one day must still collapse to one DAU row');
      assert.equal(daily[0].first_login_at_text, times[0]);
    });

    await t.test('historical users accumulate events without any first-source rewrite', async () => {
      const legacyOpenid = 'ev_legacy_' + suffix;
      await owner.query(
        `INSERT INTO game_users(app_id,open_id,first_login_completed,last_login_at,source_scene,source_scene_reported_at)
         VALUES($1,$2,true,'2026-01-01T00:00:00Z',555,'2026-01-01T00:00:00Z')`, [appId, legacyOpenid]);
      const before = await userRow(legacyOpenid);
      for (const scene of [1007, undefined, 2147483647]) {
        const body = await call(scene === undefined ? { code: legacyOpenid } : { code: legacyOpenid, scene });
        assert.equal(body.isNewUser, false);
      }
      const events = await eventRows(legacyOpenid);
      assert.deepEqual(events.map(row => row.scene), [1007, null, 2147483647],
        'historical users are recorded on every login even though their source stays unknown');
      const after = await userRow(legacyOpenid);
      assert.deepEqual(
        { source_scene: after.source_scene, source_scene_reported_at: after.source_scene_reported_at },
        { source_scene: before.source_scene, source_scene_reported_at: before.source_scene_reported_at },
        'per-login events must never rewrite the immutable first source');
      const daily = await dailyRows(legacyOpenid);
      assert.equal(daily.length, 1);

      // A user registered without a scene keeps an unknown source, while later visits are recorded.
      const omittedOpenid = 'ev_omitted_' + suffix;
      assert.equal((await call({ code: omittedOpenid })).isNewUser, true);
      assert.equal((await call({ code: omittedOpenid, scene: 1008 })).isNewUser, false);
      assert.equal((await userRow(omittedOpenid)).source_scene, null);
      assert.deepEqual((await eventRows(omittedOpenid)).map(row => row.scene), [null, 1008]);
    });

    await t.test('invalid scenes are rejected before any exchange, user or event is written', async () => {
      const exchangesBefore = upstreamCalls;
      const rejected = [0, -1, 2147483648, -2147483649, 1007.5, '1007', true, false, '', ' ', ' 1007', [], {}, null];
      for (const [index, scene] of rejected.entries()) {
        const openid = `ev_invalid_${index}_` + suffix;
        const body = await call({ code: openid, scene }, 400);
        assert.equal(body.accessToken, undefined);
      }
      for (const body of [
        { code: 'ev_alias_' + suffix, scene: 1007, loginAt: '2026-10-31T00:00:00.000Z' },
        { code: 'ev_alias_' + suffix, scene: 1007, eventScene: 1007 },
        { code: 'ev_alias_' + suffix, scene: 1007, userId: '00000000-0000-0000-0000-000000000000' },
      ]) await call(body, 400);
      assert.equal(upstreamCalls, exchangesBefore, 'rejected payloads must not consume the one-use code');
      const written = (await owner.query(
        'SELECT count(*)::int AS n FROM game_users WHERE app_id=$1 AND (open_id LIKE $2 OR open_id LIKE $3)',
        [appId, 'ev_invalid_%_' + suffix, 'ev_alias_%' + suffix])).rows[0].n;
      assert.equal(written, 0);
      const events = (await owner.query('SELECT count(*)::int AS n FROM game_login_events WHERE app_id=$1', [appId]))
        .rows[0].n;
      // Only the events from the successful subtests above may exist.
      const successfulOpenids = 1 + 5 + 3 + 2;
      assert.equal(events, successfulOpenids, 'rejected payloads must not append events');
    });

    await t.test('a failed event insert rolls the login back and deletes its own session', async () => {
      const sessionsBefore = (await admin.keys('minigame:session:*')).sort();
      const openid = 'ev_fail_' + suffix;
      await owner.query(`REVOKE INSERT ON game_login_events FROM ${role}`);
      try {
        const failure = await call({ code: openid, scene: 1007 }, 503);
        assert.equal(failure.message, 'LOGIN_STORAGE_UNAVAILABLE');
        assert.equal(failure.accessToken, undefined);
        assert.doesNotMatch(JSON.stringify(failure),
          /game_login_events|game_daily_logins|permission|postgres|private-login-events/);
      } finally {
        await owner.query(`GRANT INSERT ON game_login_events TO ${role}`);
      }
      // Nothing survives: no user, no event, no daily row and no session reserved by this attempt.
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_users WHERE app_id=$1 AND open_id=$2',
        [appId, openid])).rows[0].n, 0);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_daily_logins WHERE app_id=$1 AND user_id IN (SELECT id FROM game_users WHERE open_id=$2)',
        [appId, openid])).rows[0].n, 0);
      assert.deepEqual((await admin.keys('minigame:session:*')).sort(), sessionsBefore,
        'the owned session of the failed login must be removed');

      // The retry is still a first registration and records its event exactly once.
      const retry = await call({ code: openid, scene: 1007 });
      assert.equal(retry.isNewUser, true);
      assert.equal((await eventRows(openid)).length, 1);

      // An already-registered user's failed login must not advance login_at, DAU or events.
      const userBefore = await userRow(openid);
      const eventsBefore = (await eventRows(openid)).length;
      const sessionsMid = (await admin.keys('minigame:session:*')).sort();
      await owner.query(`REVOKE INSERT ON game_login_events FROM ${role}`);
      try { await call({ code: openid, scene: 1008 }, 503); } finally {
        await owner.query(`GRANT INSERT ON game_login_events TO ${role}`);
      }
      const userAfter = await userRow(openid);
      assert.equal(userAfter.last_login_at_text, userBefore.last_login_at_text,
        'the rolled-back transaction must not leave a new last_login_at');
      assert.equal((await eventRows(openid)).length, eventsBefore);
      assert.equal((await dailyRows(openid)).length, 1);
      assert.deepEqual((await admin.keys('minigame:session:*')).sort(), sessionsMid);
    });

    await t.test('concurrent logins append one event per successful login', async () => {
      const openid = 'ev_race_' + suffix;
      const results = await Promise.all(Array.from({ length: 6 }, () => call({ code: openid, scene: 2000 })));
      assert.equal(new Set(results.map(result => result.user.id)).size, 1);
      const events = await eventRows(openid);
      assert.equal(events.length, 6, 'each successful concurrent login owns one event');
      assert.deepEqual(new Set(events.map(row => row.scene)), new Set([2000]));
      assert.equal(new Set(events.map(row => row.id)).size, 6);
      assert.equal(new Set(events.map(row => row.login_at_text)).size, 6);
      assert.equal((await dailyRows(openid)).length, 1);

      // Different scenes racing for one new registration: every winner/ loser is recorded
      // individually, while the first source follows the existing single-winner rule.
      const raceOpenid = 'ev_race_scene_' + suffix;
      const scenes = [1007, 1008, 1009, 1010];
      const raced = await Promise.all(scenes.map(scene => call({ code: raceOpenid, scene })));
      const winners = raced.map((result, index) => result.isNewUser ? index : -1).filter(index => index >= 0);
      assert.equal(winners.length, 1);
      assert.equal((await userRow(raceOpenid)).source_scene, scenes[winners[0]!]);
      assert.deepEqual((await eventRows(raceOpenid)).map(row => row.scene).sort((a, b) => a - b), scenes);
    });

    await t.test('the events table is append-only, app-scoped and least privilege', async () => {
      const privileges = (await owner.query(
        `SELECT has_table_privilege($1,'game_login_events','SELECT') AS s,
                has_table_privilege($1,'game_login_events','INSERT') AS i,
                has_table_privilege($1,'game_login_events','UPDATE') AS u,
                has_table_privilege($1,'game_login_events','DELETE') AS d,
                has_table_privilege($1,'game_login_events','TRUNCATE') AS t,
                pg_get_serial_sequence('game_login_events','id') AS sequence`, [role])).rows[0];
      assert.deepEqual({ s: privileges.s, i: privileges.i, u: privileges.u, d: privileges.d, t: privileges.t },
        { s: false, i: true, u: false, d: false, t: false });
      // GENERATED ALWAYS AS IDENTITY does not require a separate sequence grant for INSERT.
      assert.equal((await owner.query('SELECT has_sequence_privilege($1,$2,\'USAGE\') AS usage', [role, privileges.sequence]))
        .rows[0].usage, false);
      assert.ok((await owner.query('SELECT count(*)::int AS n FROM game_login_events WHERE app_id=$1', [appId]))
        .rows[0].n > 0, 'inserts above succeeded without any sequence privilege');

      const columns = (await owner.query(
        `SELECT column_name, data_type, character_maximum_length, is_nullable, is_identity, identity_generation
         FROM information_schema.columns WHERE table_schema='public' AND table_name='game_login_events'
         ORDER BY ordinal_position`)).rows;
      assert.deepEqual(columns, [
        { column_name: 'id', data_type: 'bigint', character_maximum_length: null, is_nullable: 'NO', is_identity: 'YES', identity_generation: 'ALWAYS' },
        { column_name: 'app_id', data_type: 'character varying', character_maximum_length: 32, is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
        { column_name: 'user_id', data_type: 'uuid', character_maximum_length: null, is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
        { column_name: 'login_at', data_type: 'timestamp with time zone', character_maximum_length: null, is_nullable: 'NO', is_identity: 'NO', identity_generation: null },
        { column_name: 'scene', data_type: 'integer', character_maximum_length: null, is_nullable: 'YES', is_identity: 'NO', identity_generation: null },
        { column_name: 'client_instance_id', data_type: 'character varying', character_maximum_length: 159, is_nullable: 'YES', is_identity: 'NO', identity_generation: null },
        { column_name: 'session_id', data_type: 'uuid', character_maximum_length: null, is_nullable: 'YES', is_identity: 'NO', identity_generation: null },
        { column_name: 'client_version', data_type: 'character varying', character_maximum_length: 64, is_nullable: 'YES', is_identity: 'NO', identity_generation: null },
      ]);

      const indexed = (await owner.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='game_login_events' ORDER BY indexname`)).rows
        .map(row => row.indexdef.replace(/\s+/g, ' '));
      assert.equal(indexed.length, 4, 'primary key plus the two historical-union indexes');
      assert.ok(indexed.some(def => /\(app_id, login_at DESC, id DESC\)/.test(def)), 'missing (app_id, login_at DESC, id DESC)');
      assert.ok(indexed.some(def => /\(app_id, user_id, login_at\)/.test(def)), 'missing (app_id, user_id, login_at)');

      const { rows: [existing] } = await owner.query('SELECT id, user_id FROM game_login_events WHERE app_id=$1 LIMIT 1', [appId]);
      // Explicit identity values are refused, so ids stay server-generated and monotonic.
      await assert.rejects(() => owner.query(
        `INSERT INTO game_login_events(id,app_id,user_id,login_at,scene) VALUES(1,$1,$2,clock_timestamp(),NULL)`,
        [appId, existing.user_id]), /GENERATED ALWAYS|non-DEFAULT value/);
      // Positive scenes only; NULL means "no scene reported".
      await assert.rejects(() => owner.query(
        `INSERT INTO game_login_events(app_id,user_id,login_at,scene) VALUES($1,$2,clock_timestamp(),0)`,
        [appId, existing.user_id]), /game_login_events_scene_positive|violates check constraint/);
      await assert.rejects(() => owner.query(
        `INSERT INTO game_login_events(app_id,user_id,login_at,scene) VALUES($1,$2,clock_timestamp(),-1)`,
        [appId, existing.user_id]));

      // Same-game foreign key: an event may not mix another app with this app's user.
      const foreignApp = 'wx' + randomBytes(8).toString('hex');
      appIds.push(foreignApp);
      await assert.rejects(() => owner.query(
        `INSERT INTO game_login_events(app_id,user_id,login_at,scene) VALUES($1,$2,clock_timestamp(),1007)`,
        [foreignApp, existing.user_id]), /foreign key|game_login_events/i);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_login_events WHERE app_id=$1', [foreignApp]))
        .rows[0].n, 0);

      const applied = (await owner.query(
        `SELECT count(*)::int AS n FROM schema_migrations WHERE name='013_login_events.sql'`)).rows[0].n;
      assert.equal(applied, 1, 'the events table must come from one recorded migration');
    });

    await t.test('the runtime role stays least privilege and the suite stays inside the login rate budget', async () => {
      assert.ok(loginCalls <= RATE_LIMIT, `login calls ${loginCalls} exceeded the ${RATE_LIMIT}/min budget`);
      assert.ok(upstreamCalls > 0);
      console.log(`login-events: ${loginCalls} login requests used of ${RATE_LIMIT}/min budget`);
    });
  } finally {
    if (app) await app.close();
    for (const token of tokens) {
      await admin.del('minigame:session:' + createHash('sha256').update(token).digest('hex')).catch(() => {});
    }
    if (admin.isOpen) await admin.quit();
    await owner.query('DELETE FROM game_login_events WHERE app_id=ANY($1::varchar[])', [appIds]).catch(() => {});
    await owner.query('DELETE FROM game_daily_logins WHERE app_id=ANY($1::varchar[])', [appIds]).catch(() => {});
    await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])', [appIds]).catch(() => {});
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE ${role}`).catch(() => {});
    await owner.end();
  }
});
