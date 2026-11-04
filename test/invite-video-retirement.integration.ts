import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/database/migrate.js';

// Explicit disposable Compose targets only; do not inherit DATABASE_URL/REDIS_URL or read .env.
const databaseUrl = 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
const redisUrl = 'redis://127.0.0.1:16389/15';

test('retired friend-video rewards stay unavailable over compiled real HTTP', async t => {
  const owner = new Pool({ connectionString: databaseUrl });
  const redis = createClient({ url: redisUrl });
  redis.on('error', () => {});
  const suffix = randomBytes(6).toString('hex');
  const role = 'retired_video_' + suffix;
  const appId = 'wx' + randomBytes(8).toString('hex');
  const buildDir = resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist');
  const tokens: string[] = [];
  const users: string[] = [];
  let app: any;
  let roleCreated = false;
  try {
    await redis.connect();
    await migrate(owner);
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-retirement-only'`);
    roleCreated = true;
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE ON game_users,game_saves,game_profiles,game_invitations TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT ON game_daily_logins,game_rewarded_video_events,game_invite_video_reward_claims TO ${role}`);
    await owner.query(`GRANT INSERT ON game_login_events TO ${role}`);
    const { createApplication } = await import(pathToFileURL(resolve(buildDir, 'application.js')).href);
    const { WechatClient } = await import(pathToFileURL(resolve(buildDir, 'auth/wechat.client.js')).href);
    const config = loadConfig({ WECHAT_APP_ID: appId, WECHAT_APP_SECRET: 'explicit-retirement-test-stub',
      DATABASE_URL: `postgresql://${role}:isolated-retirement-only@127.0.0.1:15439/minigame_test`,
      REDIS_URL: redisUrl, LOGIN_RATE_LIMIT: '10000' });
    const wechat = new WechatClient(config, async (input: URL | RequestInfo) => Response.json({
      openid: new URL(String(input)).searchParams.get('js_code'), session_key: 'explicit-retirement-session-stub',
    }));
    app = await createApplication(config, { wechat });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/h5login/api/`;
    async function call(operation: string, payload: unknown, token?: string, expected = 200) {
      const response = await fetch(base + operation, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, expected, operation);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response.json() as Promise<any>;
    }
    async function login(name: string) {
      const result = await call('auth/wechat-login', { code: `${name}_${suffix}` });
      tokens.push(result.accessToken);
      users.push(result.user.id);
      return result;
    }
    const inviter = await login('retirement_inviter');
    const friend = await login('retirement_friend');
    assert.deepEqual(await call('invites/report', { inviterUid: inviter.user.id }, friend.accessToken),
      { accepted: true, alreadyBound: false, rewardClaimed: false });
    const yesterday = (await owner.query(`SELECT to_char((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-1,'YYYY-MM-DD') AS day`)).rows[0].day;
    await owner.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at)
      VALUES($1,$2,gen_random_uuid(),'retirement_history',($3::date::timestamp AT TIME ZONE 'Asia/Shanghai'))`,
    [appId, friend.user.id, yesterday]);
    const payload = { inviteeUid: friend.user.id, rewardDate: yesterday };

    await t.test('anonymous retired claim returns route-level 404 instead of authentication 401', async () => {
      await call('invites/video-rewards/claim', payload, undefined, 404);
    });
    await t.test('valid Bearer retired claim returns route-level 404 even with yesterday video events', async () => {
      await call('invites/video-rewards/claim', payload, inviter.accessToken, 404);
    });
    await t.test('list exposes only ordinary invitations even for friends with historical video receipts', async () => {
      await owner.query(`INSERT INTO game_invite_video_reward_claims(app_id,inviter_user_id,invitee_user_id,reward_date,video_count)
        VALUES($1,$2,$3,$4::date,1) ON CONFLICT DO NOTHING`, [appId, inviter.user.id, friend.user.id, yesterday]);
      const before = (await owner.query('SELECT * FROM game_invite_video_reward_claims WHERE app_id=$1', [appId])).rows;
      const list = await call('invites/list', {}, inviter.accessToken);
      assert.deepEqual(Object.keys(list).sort(), ['items', 'nextCursor', 'summary']);
      assert.deepEqual(list.summary, { total: 1, claimed: 0, unclaimed: 1 });
      assert.equal(list.nextCursor, null);
      assert.deepEqual(Object.keys(list.items[0]).sort(),
        ['avatarUrl', 'claimId', 'invitedAt', 'inviteeUid', 'nickname', 'rewardClaimed', 'rewardClaimedAt']);
      assert.equal(list.items[0].inviteeUid, friend.user.id);
      assert.deepEqual(await call('invites/list', {}, friend.accessToken),
        { items: [], summary: { total: 0, claimed: 0, unclaimed: 0 }, nextCursor: null });
      assert.deepEqual((await owner.query('SELECT * FROM game_invite_video_reward_claims WHERE app_id=$1', [appId])).rows, before);
    });
    await t.test('ordinary list needs neither friend-video events nor retired receipt privileges', async () => {
      await owner.query(`REVOKE ALL ON game_invite_video_reward_claims,game_rewarded_video_events FROM ${role}`);
      const list = await call('invites/list', {}, inviter.accessToken);
      assert.equal(list.items[0].inviteeUid, friend.user.id);
      assert.deepEqual(list.summary, { total: 1, claimed: 0, unclaimed: 1 });
      // Player-own analytics still require their original privileges, not retired receipt privileges.
      await owner.query(`GRANT SELECT, INSERT ON game_rewarded_video_events TO ${role}`);
    });
    await t.test('ordinary report, profile, source scene, claims and unclaimed-first pagination remain', async () => {
      assert.equal((await call('invites/report', { inviterUid: inviter.user.id }, friend.accessToken)).alreadyBound, true);
      const profile = await call('users/profile', { nickname: '保留资料' }, friend.accessToken);
      assert.equal(profile.user.nickname, '保留资料');
      const scene = await call('users/source-scene', { scene: 1007 }, friend.accessToken);
      assert.equal(scene.alreadyRecorded, false);
      assert.deepEqual(await call('users/source-scene', { scene: 1007 }, friend.accessToken), { ...scene, alreadyRecorded: true });
      const receipt = await call('invites/claim', { inviteeUid: friend.user.id }, inviter.accessToken);
      assert.deepEqual(Object.keys(receipt).sort(), ['claimId', 'rewardClaimed', 'rewardClaimedAt']);
      assert.equal(receipt.rewardClaimed, true);
      assert.deepEqual(await call('invites/claim', { inviteeUid: friend.user.id }, inviter.accessToken), receipt);
      const second = await login('retirement_second_friend');
      await call('invites/report', { inviterUid: inviter.user.id }, second.accessToken);
      const firstPage = await call('invites/list', { limit: 1 }, inviter.accessToken);
      assert.equal(firstPage.items[0].inviteeUid, second.user.id);
      assert.equal(firstPage.items[0].rewardClaimed, false);
      assert.deepEqual(firstPage.summary, { total: 2, claimed: 1, unclaimed: 1 });
      const next = await call('invites/list', { limit: 1, cursor: firstPage.nextCursor }, inviter.accessToken);
      assert.equal(next.items[0].inviteeUid, friend.user.id);
      assert.equal(next.items[0].nickname, '保留资料');
      assert.equal(next.items[0].claimId, receipt.claimId);
      assert.equal(next.nextCursor, null);
    });
    await t.test('player-own video analytics remain idempotent and cloud saves retain original text', async () => {
      const eventId = randomUUID();
      const event = { eventId, placement: 'player_own_retirement_regression', clientInfo: { isEnded: true } };
      const receipt = await call('analytics/rewarded-video/completed', event, friend.accessToken);
      assert.equal(receipt.alreadyRecorded, false);
      assert.deepEqual(await call('analytics/rewarded-video/completed', event, friend.accessToken), { ...receipt, alreadyRecorded: true });
      const original = '{ "RewardAdWatchCount": 2, "large":9007199254740993123 }\n';
      assert.equal((await call('data/save', { version: 0, data: original }, friend.accessToken)).version, 1);
      assert.equal((await call('data/get', {}, friend.accessToken)).data, original);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',
        [appId, friend.user.id, eventId])).rows[0].n, 1);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_invite_video_reward_claims WHERE app_id=$1', [appId])).rows[0].n, 1);
    });
  } finally {
    if (app) await app.close();
    await owner.query('DELETE FROM game_users WHERE app_id=$1', [appId]);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM game_users WHERE app_id=$1', [appId])).rows[0].n, 0);
    if (redis.isReady) {
      const keys = [`minigame:login-rate:${appId}:${createHash('sha256').update('127.0.0.1').digest('hex')}`,
        ...tokens.map(token => `minigame:session:${createHash('sha256').update(token).digest('hex')}`),
        ...users.flatMap(id => ['invite-rate', 'rewarded-video-rate', 'data-rate'].map(rate => `minigame:${rate}:${appId}:${id}`))];
      if (keys.length) {
        await redis.del(keys);
        assert.deepEqual(await redis.mGet(keys), keys.map(() => null));
      }
      await redis.quit();
    }
    if (roleCreated) {
      await owner.query(`DROP OWNED BY ${role}`);
      await owner.query(`DROP ROLE ${role}`);
    }
    await owner.end();
  }
});
