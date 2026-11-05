import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/database/migrate.js';

// Hard-coded disposable Compose targets; never read live credentials or inherited DB URLs.
const databaseUrl = 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
const redisUrl = 'redis://127.0.0.1:16389/15';
const shareId = 'diapig_invite';

test('daily share assists over compiled HTTP with restricted runtime permissions', async t => {
  const owner = new Pool({ connectionString: databaseUrl });
  const redis = createClient({ url: redisUrl });
  redis.on('error', () => {});
  const role = 'share_assist_' + randomBytes(6).toString('hex');
  const appId = 'wx' + randomBytes(8).toString('hex');
  const foreignAppId = 'wx' + randomBytes(8).toString('hex');
  const keys: string[] = [];
  const apps: any[] = [];
  let roleCreated = false;
  try {
    await redis.connect();
    await migrate(owner);
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-share-assists-only'`);
    roleCreated = true;
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT ON game_users TO ${role}`);
    if ((await owner.query("SELECT to_regclass('game_share_assists') AS name")).rows[0].name) {
      await owner.query(`GRANT SELECT, INSERT ON game_share_assists TO ${role}`);
    }
    const { createApplication } = await import(pathToFileURL(resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist', 'application.js')).href);
    const config = loadConfig({ WECHAT_APP_ID: appId, WECHAT_APP_SECRET: 'isolated-share-test-only',
      DATABASE_URL: `postgresql://${role}:isolated-share-assists-only@127.0.0.1:15439/minigame_test`, REDIS_URL: redisUrl });
    for (let n = 0; n < 2; n++) {
      const app = await createApplication(config);
      apps.push(app);
      await app.listen(0, '127.0.0.1');
    }
    const bases = apps.map(app => `http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/`);
    async function call(operation: string, payload: unknown, token?: string, expected = 200, instance = 0) {
      const response = await fetch(bases[instance] + operation, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
      const body = await response.json() as any;
      assert.equal(response.status, expected, operation + ': ' + JSON.stringify(body));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return body;
    }
    async function session(uid: string, application = appId, isNewUser = false) {
      const token = randomBytes(32).toString('base64url');
      const key = 'minigame:session:' + createHash('sha256').update(token).digest('hex');
      assert.equal(await redis.set(key, JSON.stringify({ userId: uid, appId: application, isNewUser }), { NX: true, EX: 600 }), 'OK');
      keys.push(key);
      return token;
    }
    async function user(isNewUser = false, application = appId, completed = true) {
      const uid = randomUUID();
      await owner.query('INSERT INTO game_users(id,app_id,open_id,first_login_completed) VALUES($1,$2,$3,$4)',
        [uid, application, 'share_test_' + randomUUID(), completed]);
      if (application === appId) keys.push(`minigame:share-assist-rate:${appId}:${uid}`);
      return { uid, token: await session(uid, application, isNewUser) };
    }
    const inviter = await user();

    await t.test('today summary starts at zero and reports the next Beijing midnight', async () => {
      const before = (await owner.query('SELECT clock_timestamp() AS at')).rows[0].at;
      const result = await call('share-assists/summary', { shareId }, inviter.token);
      const after = (await owner.query('SELECT clock_timestamp() AS at')).rows[0].at;
      assert.deepEqual(Object.keys(result).sort(), ['assistUserCount', 'date', 'resetAt', 'shareId']);
      assert.equal(result.shareId, shareId);
      assert.equal(result.assistUserCount, 0);
      const expected = (await owner.query(`SELECT to_char($1::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
        (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS reset`, [before])).rows[0];
      assert.equal(result.date, expected.day);
      assert.equal(result.resetAt, expected.reset.toISOString());
      assert.ok(after >= before);
    });
    await t.test('new and existing users both help without creating ordinary referral bindings', async () => {
      const fresh = await user(true), existing = await user(false);
      for (const helper of [fresh, existing]) {
        const receipt = await call('share-assists/report', { shareId, inviterUid: inviter.uid }, helper.token);
        assert.deepEqual(Object.keys(receipt).sort(), ['accepted', 'alreadyRecorded', 'date', 'recordedAt', 'shareId']);
        assert.equal(receipt.accepted, true);
        assert.equal(receipt.alreadyRecorded, false);
        assert.equal(receipt.shareId, shareId);
        const duplicate = await call('share-assists/report', { shareId, inviterUid: inviter.uid.toUpperCase() }, helper.token, 200, 1);
        assert.deepEqual(duplicate, { ...receipt, alreadyRecorded: true });
      }
      assert.equal((await call('share-assists/summary', { shareId }, inviter.token)).assistUserCount, 2);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_invitations WHERE app_id=$1', [appId])).rows[0].n, 0);
    });
    await t.test('parallel requests across two tokens and API instances count one helper', async () => {
      const source = await user(), helper = await user();
      const otherToken = await session(helper.uid);
      const responses = await Promise.all(Array.from({ length: 12 }, (_, n) =>
        call('share-assists/report', { shareId, inviterUid: source.uid }, n % 2 ? otherToken : helper.token, 200, n % 2)));
      assert.equal(responses.filter(r => !r.alreadyRecorded).length, 1);
      assert.equal(new Set(responses.map(r => r.recordedAt)).size, 1);
      assert.equal((await call('share-assists/summary', { shareId }, source.token)).assistUserCount, 1);
      assert.equal((await call('share-assists/summary', { shareId }, helper.token)).assistUserCount, 0);
      // Helping another source is independent, not a permanent one-inviter attribution.
      await call('share-assists/report', { shareId, inviterUid: inviter.uid }, helper.token);
      assert.equal((await call('share-assists/summary', { shareId }, inviter.token)).assistUserCount, 3);
    });
    await t.test('Beijing midnight excludes yesterday and next day, includes exact today midnight', async () => {
      const source = await user(), helper = await user();
      const midnight = `(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai'`;
      await owner.query(`INSERT INTO game_share_assists(app_id,share_id,inviter_user_id,helper_user_id,recorded_at)
        VALUES($1,$2,$3,$4,(${midnight})-interval '1 microsecond')`, [appId, shareId, source.uid, helper.uid]);
      assert.equal((await call('share-assists/summary', { shareId }, source.token)).assistUserCount, 0);
      const receipt = await call('share-assists/report', { shareId, inviterUid: source.uid }, helper.token);
      assert.equal(receipt.alreadyRecorded, false);
      const atStart = await user(), nextDay = await user();
      await owner.query(`INSERT INTO game_share_assists(app_id,share_id,inviter_user_id,helper_user_id,recorded_at)
        VALUES($1,$2,$3,$4,(${midnight})),($1,$2,$3,$5,(${midnight})+interval '1 day')`,
        [appId, shareId, source.uid, atStart.uid, nextDay.uid]);
      assert.equal((await call('share-assists/summary', { shareId }, source.token)).assistUserCount, 2);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_share_assists WHERE app_id=$1 AND inviter_user_id=$2', [appId, source.uid])).rows[0].n, 4);
      // CHECK/FK/generated date protect against direct malformed writes, too.
      await assert.rejects(owner.query(`INSERT INTO game_share_assists(app_id,share_id,inviter_user_id,helper_user_id) VALUES($1,$2,$3,$3)`,
        [appId, shareId, source.uid]), { code: '23514' });
      await assert.rejects(owner.query(`INSERT INTO game_share_assists(app_id,share_id,inviter_user_id,helper_user_id) VALUES($1,'other',$2,$3)`,
        [appId, source.uid, helper.uid]), { code: '23514' });
    });
    await t.test('the same helper counts again immediately after Beijing midnight with database-derived date', async () => {
      const { Infrastructure } = await import(pathToFileURL(resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist', 'infrastructure.js')).href);
      const pool = apps[0].get(Infrastructure).pool, originalConnect = pool.connect;
      const source = await user(), helper = await user();
      let fixedTime = '2026-11-05T15:59:59.999999Z';
      pool.connect = function (...args: any[]) {
        if (args.length) return originalConnect.apply(this, args);
        return originalConnect.call(this).then((client: any) => {
          const query = client.query, release = client.release;
          client.query = function (...queryArgs: any[]) {
            if (typeof queryArgs[0] === 'string' && queryArgs[0].includes('SELECT at::text,to_char')) {
              return query.call(this, `SELECT $1::timestamptz::text AS at,to_char($1::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date`, [fixedTime]);
            }
            return query.apply(this, queryArgs);
          };
          client.release = function (...releaseArgs: any[]) { client.query = query; client.release = release; return release.apply(this, releaseArgs); };
          return client;
        });
      };
      try {
        const yesterday = await call('share-assists/report', { shareId, inviterUid: source.uid }, helper.token);
        assert.equal(yesterday.date, '2026-11-05');
        assert.equal(yesterday.alreadyRecorded, false);
        fixedTime = '2026-11-05T16:00:00.000000Z';
        const today = await call('share-assists/report', { shareId, inviterUid: source.uid }, helper.token);
        assert.equal(today.date, '2026-11-06');
        assert.equal(today.alreadyRecorded, false);
        assert.deepEqual(await call('share-assists/report', { shareId, inviterUid: source.uid }, helper.token), { ...today, alreadyRecorded: true });
      } finally { pool.connect = originalConnect; }
      assert.deepEqual((await owner.query(`SELECT to_char(activity_date,'YYYY-MM-DD') AS date,count(*)::int AS n
        FROM game_share_assists WHERE app_id=$1 AND inviter_user_id=$2 GROUP BY activity_date ORDER BY activity_date`, [appId, source.uid])).rows,
        [{ date: '2026-11-05', n: 1 }, { date: '2026-11-06', n: 1 }]);
    });
    await t.test('self assist is not counted; foreign, absent and unfinished inviters are hidden', async () => {
      const foreign = await user(false, foreignAppId), unfinished = await user(false, appId, false);
      assert.deepEqual(await call('share-assists/report', { shareId, inviterUid: inviter.uid.toUpperCase() }, inviter.token),
        { shareId, accepted: false, reason: 'SELF_ASSIST' });
      for (const uid of [foreign.uid, randomUUID(), unfinished.uid]) {
        assert.equal((await call('share-assists/report', { shareId, inviterUid: uid }, inviter.token, 404)).message, 'SHARE_ASSIST_INVITER_NOT_FOUND');
      }
      for (const token of [undefined, 'invalid', foreign.token, unfinished.token, await session(randomUUID())]) {
        assert.equal((await call('share-assists/summary', { shareId }, token, 401)).message, 'SESSION_INVALID');
        await call('share-assists/report', { shareId, inviterUid: inviter.uid }, token, 401);
      }
    });
    await t.test('strict bodies and fixed share point prevent identity, date and placement overrides', async () => {
      const helper = await user();
      for (const body of [null, [], {}, { shareId: 'diapig_invite ' }, { shareId: 'DIAPIG_INVITE' }, { shareId, inviterUid: inviter.uid }, { shareId, date: '2026-01-01' }]) {
        assert.equal((await call('share-assists/summary', body, helper.token, 400)).message,
          body === null ? 'INVALID_JSON' : 'INVALID_SHARE_ASSIST_REQUEST');
      }
      for (const body of [{ shareId }, { shareId, inviterUid: 'bad' }, { shareId, inviterUid: null },
        { shareId: 'other', inviterUid: inviter.uid }, { shareId, inviterUid: inviter.uid, helperUid: helper.uid },
        { shareId, inviterUid: inviter.uid, appId }, { shareId, inviterUid: inviter.uid, date: '2026-01-01' }]) {
        assert.equal((await call('share-assists/report', body, helper.token, 400)).message, 'INVALID_SHARE_ASSIST_REQUEST');
      }
      await call('share-assists/summary?inviterUid=' + inviter.uid, { shareId }, helper.token, 400);
      await call('share-assists/report?shareId=diapig_invite', { shareId, inviterUid: inviter.uid }, helper.token, 400);
    });
    await t.test('rate limit is shared across tokens and instances but separate from ordinary invitation quota', async () => {
      const helper = await user(), token2 = await session(helper.uid);
      const key = `minigame:share-assist-rate:${appId}:${helper.uid}`;
      assert.equal(await redis.set(key, '59', { NX: true, EX: 60 }), 'OK');
      await call('share-assists/summary', { shareId }, helper.token);
      assert.equal((await call('share-assists/report', { shareId, inviterUid: inviter.uid }, token2, 429, 1)).message, 'SHARE_ASSIST_RATE_LIMITED');
      assert.equal(await redis.get(`minigame:invite-rate:${appId}:${helper.uid}`), null);
    });
    await t.test('lost commit acknowledgement yields safe 503 and retry preserves the durable receipt', async () => {
      const { Infrastructure } = await import(pathToFileURL(resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist', 'infrastructure.js')).href);
      const infrastructure = apps[0].get(Infrastructure);
      const pool = infrastructure.pool;
      const originalConnect = pool.connect;
      const source = await user(), helper = await user();
      let injected = false;
      pool.connect = function (...args: any[]) {
        if (args.length) return originalConnect.apply(this, args);
        return originalConnect.call(this).then((client: any) => {
          const query = client.query;
          client.query = async function (...queryArgs: any[]) {
            if (queryArgs[0] === 'COMMIT') {
              const result = await query.apply(this, queryArgs);
              client.query = query;
              injected = true;
              throw new Error('isolated hidden connection detail');
            }
            return query.apply(this, queryArgs);
          };
          return client;
        });
      };
      try {
        assert.equal((await call('share-assists/report', { shareId, inviterUid: source.uid }, helper.token, 503)).message, 'SHARE_ASSIST_STORAGE_UNAVAILABLE');
        assert.ok(injected);
      } finally { pool.connect = originalConnect; }
      const retry = await call('share-assists/report', { shareId, inviterUid: source.uid }, helper.token);
      assert.equal(retry.alreadyRecorded, true);
      assert.equal((await call('share-assists/summary', { shareId }, source.token)).assistUserCount, 1);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_share_assists WHERE app_id=$1 AND inviter_user_id=$2', [appId, source.uid])).rows[0].n, 1);
    });
    await t.test('database permission failures and Redis outages fail closed with sanitized errors', async () => {
      const helper = await user();
      await owner.query(`REVOKE INSERT ON game_share_assists FROM ${role}`);
      try {
        assert.equal((await call('share-assists/report', { shareId, inviterUid: inviter.uid }, helper.token, 503)).message, 'SHARE_ASSIST_STORAGE_UNAVAILABLE');
      } finally { await owner.query(`GRANT INSERT ON game_share_assists TO ${role}`); }
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_share_assists WHERE helper_user_id=$1', [helper.uid])).rows[0].n, 0);
      const { Infrastructure } = await import(pathToFileURL(resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist', 'infrastructure.js')).href);
      const infrastructure = apps[0].get(Infrastructure), original = infrastructure.redis.withCommandOptions;
      infrastructure.redis.withCommandOptions = () => { throw new Error('isolated hidden Redis detail'); };
      try {
        assert.equal((await call('share-assists/summary', { shareId }, helper.token, 503)).message, 'SHARE_ASSIST_STORAGE_UNAVAILABLE');
      } finally { infrastructure.redis.withCommandOptions = original; }
    });
  } finally {
    for (const app of apps) await app.close();
    await owner.query('DELETE FROM game_users WHERE app_id=ANY($1::text[])', [[appId, foreignAppId]]);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_users WHERE app_id=ANY($1::text[])', [[appId, foreignAppId]])).rows[0].n, 0);
    if (redis.isReady) {
      if (keys.length) { await redis.del(keys); assert.deepEqual(await redis.mGet(keys), keys.map(() => null)); }
      await redis.quit();
    }
    if (roleCreated) { await owner.query(`DROP OWNED BY ${role}`); await owner.query(`DROP ROLE ${role}`); }
    await owner.end();
  }
});
