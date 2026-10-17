import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/database/migrate.js';

test('compiled referral APIs over real HTTP with least-privilege PG, real Redis and explicit WeChat stub', async t => {
  const owner = new Pool({ connectionString: 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test' });
  const role = 'invite_compiled_' + randomBytes(6).toString('hex');
  const appId = 'wx' + randomBytes(8).toString('hex');
  const otherAppId = 'wx' + randomBytes(8).toString('hex');
  let app: any;
  let roleCreated = false;
  try {
    await migrate(owner);
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-invite-compiled-only'`);
    roleCreated = true;
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE ON game_users, game_saves, game_profiles, game_invitations TO ${role}`);
    const buildDir = resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist');
    const { createApplication } = await import(pathToFileURL(resolve(buildDir, 'application.js')).href);
    const { WechatClient } = await import(pathToFileURL(resolve(buildDir, 'auth/wechat.client.js')).href);
    const config = loadConfig({ WECHAT_APP_ID: appId, WECHAT_APP_SECRET: 'explicit-invite-compiled-stub',
      DATABASE_URL: `postgresql://${role}:isolated-invite-compiled-only@127.0.0.1:15439/minigame_test`,
      REDIS_URL: 'redis://127.0.0.1:16389/15' });
    const wechat = new WechatClient(config, async (input: URL | RequestInfo) => Response.json({
      openid: new URL(String(input)).searchParams.get('js_code'), session_key: 'never-disclose-this-compiled-session-key',
    }));
    app = await createApplication(config, { wechat });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const base = `http://127.0.0.1:${address.port}/h5login/api/`;
    async function call(operation: string, payload: unknown, token?: string, expected = 200) {
      const response = await fetch(base + operation, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(payload) });
      assert.equal(response.status, expected, operation);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response.json() as Promise<any>;
    }
    async function login(openid: string) {
      const auth = await call('auth/wechat-login', { code: openid });
      assert.equal(auth.user.openid, openid);
      assert.equal(typeof auth.isNewUser, 'boolean');
      assert.doesNotMatch(JSON.stringify(auth), /session_key|never-disclose-this-compiled-session-key|explicit-invite-compiled-stub/);
      return auth;
    }
    const a = await login('inviter_' + role);
    const b = await login('invitee_one_' + role);
    const c = await login('invitee_two_' + role);
    assert.equal(a.isNewUser, true);
    assert.equal(b.isNewUser, true);
    assert.equal(c.isNewUser, true);

    await t.test('first-registration eligibility is server-side; legacy and repeated logins are not new', async () => {
      const repeat = await login('invitee_one_' + role);
      assert.equal(repeat.isNewUser, false);
      assert.equal(repeat.user.id, b.user.id);
      const rejected = await call('invites/report', { inviterUid: a.user.id }, repeat.accessToken);
      assert.equal(rejected.accepted, false);
      assert.equal(rejected.reason, 'NOT_NEW_USER');
      await owner.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2)', [appId, 'legacy_' + role]);
      const old = await login('legacy_' + role);
      assert.equal(old.isNewUser, false);
      assert.equal((await call('invites/report', { inviterUid: a.user.id }, old.accessToken)).reason, 'NOT_NEW_USER');
    });

    await t.test('plain inviter UID binds once and unapproved fields cannot forge identity', async () => {
      const accepted = await call('invites/report', { inviterUid: a.user.id }, b.accessToken);
      assert.equal(accepted.accepted, true);
      assert.equal(accepted.alreadyBound, false);
      assert.equal(accepted.rewardClaimed, false);
      assert.equal(Object.hasOwn(accepted, 'id'), false);
      assert.equal(Object.hasOwn(accepted, 'invitationId'), false);
      assert.equal((await call('invites/report', { inviterUid: a.user.id }, b.accessToken)).alreadyBound, true);
      assert.equal((await call('invites/report', { inviterUid: c.user.id }, b.accessToken)).reason, 'ALREADY_ATTRIBUTED');
      assert.equal((await call('invites/report', { inviterUid: c.user.id }, c.accessToken)).reason, 'SELF_INVITE');
      await call('invites/report', { inviterUid: a.user.id, isNewUser: true }, c.accessToken, 400);
      await call('invites/report', { inviterUid: a.user.id, inviteeUid: b.user.id }, c.accessToken, 400);
      await call('invites/report', { inviterUid: a.user.id }, undefined, 401);
      await call('invites/report', { inviterUid: a.user.id }, c.accessToken);
    });

    await t.test('profile updates only self; list shows current profile, nullable defaults and no record ID', async () => {
      const before = await call('invites/list', {}, a.accessToken);
      const emptyProfile = before.items.find((item: any) => item.inviteeUid === c.user.id);
      assert.equal(emptyProfile.nickname, null);
      assert.equal(emptyProfile.avatarUrl, null);
      const profile = await call('users/profile', { nickname: '受邀玩家🚀', avatarUrl: 'https://example.com/head.png' }, b.accessToken);
      assert.deepEqual(profile.user, { id: b.user.id, nickname: '受邀玩家🚀', avatarUrl: 'https://example.com/head.png' });
      await call('users/profile', { nickname: '冒充', avatarUrl: 'https://example.com/head.png', userId: a.user.id }, b.accessToken, 400);
      await call('users/profile', { nickname: '错误协议', avatarUrl: 'http://example.com/head.png' }, b.accessToken, 400);
      const list = await call('invites/list', {}, a.accessToken);
      assert.deepEqual(list.summary, { total: 2, claimed: 0, unclaimed: 2 });
      assert.equal(list.items.length, 2);
      const invited = list.items.find((item: any) => item.inviteeUid === b.user.id);
      assert.equal(invited.nickname, '受邀玩家🚀');
      assert.equal(invited.avatarUrl, 'https://example.com/head.png');
      for (const item of list.items) {
        assert.deepEqual(Object.keys(item).sort(), ['avatarUrl', 'claimId', 'invitedAt', 'inviteeUid', 'nickname', 'rewardClaimed', 'rewardClaimedAt']);
        assert.equal(item.claimId, null);
      }
      assert.deepEqual((await call('invites/list', {}, b.accessToken)).items, []);
    });

    await t.test('stable cursor pages preserve own-user isolation and whole-list summary', async () => {
      const first = await call('invites/list', { cursor: null, limit: 1 }, a.accessToken);
      assert.equal(first.items.length, 1);
      assert.equal(typeof first.nextCursor, 'string');
      const second = await call('invites/list', { cursor: first.nextCursor, limit: 1 }, a.accessToken);
      assert.equal(second.items.length, 1);
      assert.notEqual(first.items[0].inviteeUid, second.items[0].inviteeUid);
      assert.equal(second.nextCursor, null);
      assert.deepEqual(first.summary, { total: 2, claimed: 0, unclaimed: 2 });
      assert.deepEqual(second.summary, first.summary);
      await call('invites/list', { cursor: 'not-a-cursor', limit: 1 }, a.accessToken, 400);
      await call('invites/list', { limit: 101 }, a.accessToken, 400);
    });

    await t.test('claim via invitee UID is atomic and stable under retries, without server reward payload', async () => {
      await call('invites/claim', { inviteeUid: b.user.id }, c.accessToken, 404);
      const results = await Promise.all(Array.from({ length: 5 }, () => call('invites/claim', { inviteeUid: b.user.id }, a.accessToken)));
      for (const result of results) {
        assert.deepEqual(Object.keys(result).sort(), ['claimId', 'rewardClaimed', 'rewardClaimedAt']);
        assert.equal(result.rewardClaimed, true);
        assert.match(result.claimId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(result, results[0]);
      }
      assert.deepEqual(await call('invites/claim', { inviteeUid: b.user.id }, a.accessToken), results[0]);
      const list = await call('invites/list', {}, a.accessToken);
      assert.deepEqual(list.summary, { total: 2, claimed: 1, unclaimed: 1 });
      const item = list.items.find((row: any) => row.inviteeUid === b.user.id);
      assert.equal(item.claimId, results[0].claimId);
      assert.equal(item.rewardClaimedAt, results[0].rewardClaimedAt);
      assert.equal((await call('invites/report', { inviterUid: a.user.id }, b.accessToken)).rewardClaimed, true);
    });

    await t.test('cross-app UID cannot become inviter and cloud-save API remains compatible', async () => {
      const foreign = await owner.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id', [otherAppId, 'foreign_' + role]);
      const d = await login('invitee_three_' + role);
      await call('invites/report', { inviterUid: foreign.rows[0].id }, d.accessToken, 404);
      await call('invites/report', { inviterUid: a.user.id }, d.accessToken);
      const original = '{ "large":9007199254740993123,"text":"邀请存档" }\n';
      assert.equal((await call('data/save', { version: 0, data: original }, b.accessToken)).version, 1);
      assert.equal((await call('data/get', {}, b.accessToken)).data, original);
      assert.equal((await call('data/get', {}, c.accessToken)).exists, false);
    });
  } finally {
    if (app) await app.close();
    await owner.query('DELETE FROM game_users WHERE app_id = ANY($1::text[])', [[appId, otherAppId]]);
    if (roleCreated) {
      await owner.query(`DROP OWNED BY ${role}`);
      await owner.query(`DROP ROLE ${role}`);
    }
    await owner.end();
  }
});
