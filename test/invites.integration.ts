import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { migrate } from '../src/database/migrate.js';
import { WechatClient } from '../src/auth/wechat.client.js';
import { Infrastructure } from '../src/infrastructure.js';

const config = loadConfig({ WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_APP_SECRET: 'explicit-invite-test-stub',
  DATABASE_URL: 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test',
  REDIS_URL: 'redis://127.0.0.1:16389/15', LOGIN_RATE_LIMIT: '200' });
const prefix = '/h5login/api/';

test('referral safety, races and failure boundaries with real isolated PostgreSQL/Redis', async t => {
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
  async function call(operation: string, token: string, body: unknown, status = 200) {
    const response = await request(app.getHttpServer()).post(prefix + operation)
      .set('Authorization', 'Bearer ' + token).send(body as object).expect(status);
    assert.equal(response.headers['cache-control'], 'no-store');
    return response.body;
  }
  async function login(code: string) {
    return (await request(app.getHttpServer()).post(prefix + 'auth/wechat-login').send({ code }).expect(200)).body;
  }
  async function quotaFixture(code: string, claimed: number, total = 54) {
    const owner = await login(code);
    const ids = Array.from({ length: total }, () => randomUUID());
    await pool.query(`INSERT INTO game_users(id,app_id,open_id)
      SELECT id,$1,'quota_'||id FROM unnest($2::uuid[]) AS id`, [config.appId, ids]);
    await pool.query(`INSERT INTO game_invitations(app_id,inviter_user_id,invitee_user_id,claim_id,reward_claimed_at)
      SELECT $1,$2,id,CASE WHEN n<=$4 THEN gen_random_uuid() END,CASE WHEN n<=$4 THEN clock_timestamp() END
      FROM unnest($3::uuid[]) WITH ORDINALITY AS f(id,n)`, [config.appId, owner.user.id, ids, claimed]);
    return { owner, ids };
  }

  const a = await login('inviter_a'); const other = await login('inviter_other');
  let race: any;
  let raceWinner: any;

  await t.test('concurrent first logins yield exactly one new-registration session; subsequent sessions cannot bind', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => login('parallel_new_registration')));
    assert.equal(responses.filter(r => r.isNewUser).length, 1);
    assert.equal(new Set(responses.map(r => r.user.id)).size, 1);
    assert.equal(new Set(responses.map(r => r.accessToken)).size, 8);
    const oldSession = responses.find(r => !r.isNewUser)!;
    assert.equal((await call('invites/report', oldSession.accessToken, { inviterUid: a.user.id })).reason, 'NOT_NEW_USER');
    const first = responses.find(r => r.isNewUser)!;
    assert.equal((await call('invites/report', first.accessToken, { inviterUid: a.user.id })).accepted, true);
    assert.equal((await call('invites/report', oldSession.accessToken, { inviterUid: a.user.id })).alreadyBound, true);
  });

  await t.test('competing inviters produce one relation; UID is only source metadata, not acting identity', async () => {
    race = await login('competing_invitee');
    const inviters = [a, other];
    const reports = await Promise.all(inviters.map(inviter => call('invites/report', race.accessToken, { inviterUid: inviter.user.id })));
    assert.equal(reports.filter(r => r.accepted).length, 1);
    assert.equal(reports.filter(r => r.reason === 'ALREADY_ATTRIBUTED').length, 1);
    raceWinner = inviters[reports.findIndex(r => r.accepted)];
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_invitations WHERE invitee_user_id=$1', [race.user.id])).rows[0].n, 1);
    await call('invites/claim', race.accessToken, { inviteeUid: race.user.id }, 404);
    await call('invites/list', race.accessToken, { inviterUid: raceWinner.user.id }, 400);
    assert.equal((await call('invites/list', race.accessToken, {})).summary.total, 0);
  });

  await t.test('legacy accounts and sessions remain valid but cannot obtain new-user attribution', async () => {
    await pool.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2)', [config.appId, 'legacy_before_referrals']);
    const old = await login('legacy_before_referrals');
    assert.equal(old.isNewUser, false);
    const key = 'minigame:session:' + createHash('sha256').update(old.accessToken).digest('hex');
    const value = JSON.parse((await redis.get(key))!); delete value.isNewUser;
    await redis.set(key, JSON.stringify(value), { EX: 60 });
    assert.equal((await call('invites/report', old.accessToken, { inviterUid: a.user.id })).reason, 'NOT_NEW_USER');
    assert.deepEqual((await call('invites/list', old.accessToken, {})).summary, { total: 0, claimed: 0, unclaimed: 0 });
  });

  await t.test('unknown, cross-app and postdated inviters cannot consume a legitimate registration', async () => {
    const fresh = await login('source_validation_invitee');
    const foreign = await pool.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id', ['wx1111111111111111', 'foreign_inviter']);
    const later = await login('postdated_inviter');
    for (const uid of ['11111111-1111-1111-1111-111111111111', foreign.rows[0].id, later.user.id]) {
      assert.equal((await call('invites/report', fresh.accessToken, { inviterUid: uid }, 404)).message, 'INVITER_NOT_FOUND');
    }
    assert.equal((await call('invites/report', fresh.accessToken, { inviterUid: fresh.user.id.toUpperCase() })).reason, 'SELF_INVITE');
    assert.equal((await call('invites/report', fresh.accessToken, { inviterUid: a.user.id })).accepted, true);
  });

  await t.test('profile Unicode boundaries, consent-independent defaults, URL validation and strict schemas', async () => {
    const fresh = await login('profile_boundary_user');
    await call('invites/report', fresh.accessToken, { inviterUid: other.user.id });
    let item = (await call('invites/list', other.accessToken, {})).items.find((row: any) => row.inviteeUid === fresh.user.id);
    assert.equal(item.nickname, null); assert.equal(item.avatarUrl, null);
    const maxNickname = '🚀'.repeat(64);
    await call('users/profile', fresh.accessToken, { nickname: maxNickname, avatarUrl: 'https://example.com/avatar.png' });
    item = (await call('invites/list', other.accessToken, {})).items.find((row: any) => row.inviteeUid === fresh.user.id);
    assert.equal(item.nickname, maxNickname);
    for (const nickname of ['', '   ', '🚀'.repeat(65), '\u0000bad', 'bad\nname', String.fromCharCode(0xd800)]) {
      await call('users/profile', fresh.accessToken, { nickname, avatarUrl: 'https://example.com/avatar.png' }, 400);
    }
    for (const avatarUrl of ['http://example.com/a', 'javascript:alert(1)', 'https://user:pass@example.com/a',
      ' https://example.com/a', 'https://example.com/\nabc', 'https://example.com/' + 'x'.repeat(2048), String.fromCharCode(0xd800)]) {
      await call('users/profile', fresh.accessToken, { nickname: 'valid', avatarUrl }, 400);
    }
    const nicknameOnly = await call('users/profile', fresh.accessToken, { nickname: 'only' });
    assert.equal(nicknameOnly.user.avatarUrl, 'https://example.com/avatar.png');
    await call('users/profile', fresh.accessToken, { nickname: '空头像昵称', avatarUrl: '' });
    item = (await call('invites/list', other.accessToken, {})).items.find((row: any) => row.inviteeUid === fresh.user.id);
    assert.equal(item.nickname, '空头像昵称'); assert.equal(item.avatarUrl, null);
    for (const payload of [[], {}, { avatarUrl: null }, { nickname: 'valid', avatarUrl: 'https://example.com/a', openid: 'forged' }]) {
      await call('users/profile', fresh.accessToken, payload, 400);
    }
  });

  await t.test('strict request schemas and cursor parsing reject injection without mutating attribution', async () => {
    const fresh = await login('schema_invitee');
    for (const payload of [{}, [], { inviterUid: 1 }, { inviterUid: 'not-a-uuid' },
      { inviterUid: a.user.id, inviteeUid: race.user.id }, { inviterUid: a.user.id, isNewUser: true }]) {
      await call('invites/report', fresh.accessToken, payload, 400);
    }
    for (const payload of [{ invitationId: race.user.id }, { inviteeUid: race.user.id, claimed: true }, { inviteeUid: 'bad' }]) {
      await call('invites/claim', fresh.accessToken, payload, 400);
    }
    const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const badTimestamp = encodeCursor([false, '2026-02-31T00:00:00.000000Z', fresh.user.id]);
    const invalidCursors = [
      encodeCursor(['2026-10-17T04:00:00.000000Z', fresh.user.id]), // Pre-sort legacy cursor.
      ...[null, 0, 1, 'false', {}, []].map(state => encodeCursor([state, '2026-10-17T04:00:00.000000Z', fresh.user.id])),
      encodeCursor([false, '2026-10-17T04:00:00.000000Z', 'invalid-uid']),
    ];
    for (const payload of [[], { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '1' }, { cursor: 'not-json' },
      ...invalidCursors.map(cursor => ({ cursor })),
      { cursor: badTimestamp }, { cursor: 'x'.repeat(513) }, { cursor: 5 }, { inviterUid: a.user.id }]) {
      await call('invites/list', fresh.accessToken, payload, 400);
    }
    for (const operation of ['users/profile', 'invites/report', 'invites/list', 'invites/claim']) {
      await request(app.getHttpServer()).post(prefix + operation + '?userId=' + a.user.id)
        .set('Authorization', 'Bearer ' + fresh.accessToken).send({}).expect(400);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_invitations WHERE invitee_user_id=$1', [fresh.user.id])).rows[0].n, 0);
  });

  await t.test('opaque pagination retains PostgreSQL microseconds and does not skip equal-millisecond records', async () => {
    const owner = await login('microsecond_inviter');
    const one = await login('microsecond_one'); const two = await login('microsecond_two');
    await call('invites/report', one.accessToken, { inviterUid: owner.user.id });
    await call('invites/report', two.accessToken, { inviterUid: owner.user.id });
    await pool.query('UPDATE game_invitations SET invited_at=$1 WHERE invitee_user_id=$2', ['2026-10-17T04:00:00.123456Z', one.user.id]);
    await pool.query('UPDATE game_invitations SET invited_at=$1 WHERE invitee_user_id=$2', ['2026-10-17T04:00:00.123789Z', two.user.id]);
    const first = await call('invites/list', owner.accessToken, { limit: 1 });
    const second = await call('invites/list', owner.accessToken, { limit: 1, cursor: first.nextCursor });
    assert.deepEqual(new Set([first.items[0].inviteeUid, second.items[0].inviteeUid]), new Set([one.user.id, two.user.id]));
    assert.equal(second.nextCursor, null); assert.deepEqual(second.summary, { total: 2, claimed: 0, unclaimed: 2 });
  });

  await t.test('unclaimed-first pagination covers over 100 mixed records, timestamp ties and group boundaries', async () => {
    const owner = await login('unclaimed_first_owner');
    const fixtures = Array.from({ length: 135 }, (_, index) => ({
      id: randomUUID(), index, claimed: index >= 110,
      time: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 3))).toISOString(),
    }));
    await pool.query(`INSERT INTO game_users(id,app_id,open_id)
      SELECT id,$1,'sorting_' || id FROM jsonb_to_recordset($2::jsonb) AS f(id uuid)`, [config.appId, JSON.stringify(fixtures)]);
    await pool.query(`INSERT INTO game_invitations(app_id,inviter_user_id,invitee_user_id,invited_at,claim_id,reward_claimed_at)
      SELECT $1,$2,id,time,CASE WHEN claimed THEN gen_random_uuid() END,CASE WHEN claimed THEN now() END
      FROM jsonb_to_recordset($3::jsonb) AS f(id uuid,time timestamptz,claimed boolean)`,
    [config.appId, owner.user.id, JSON.stringify(fixtures)]);
    const expected = [...fixtures].sort((a, b) => Number(a.claimed) - Number(b.claimed)
      || b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
    const collected: any[] = [];
    let cursor = null;
    const lengths: number[] = [];
    do {
      const page = await call('invites/list', owner.accessToken, { limit: 100, cursor });
      assert.deepEqual(page.summary, { total: 135, claimed: 25, unclaimed: 110 });
      lengths.push(page.items.length); collected.push(...page.items); cursor = page.nextCursor;
      assert.ok(lengths.length <= 2, 'pagination must terminate');
    } while (cursor);
    assert.deepEqual(lengths, [100, 35]);
    assert.deepEqual(collected.map(item => item.inviteeUid), expected.map(item => item.id));
    assert.deepEqual(collected.map(item => item.rewardClaimed), expected.map(item => item.claimed));
    // Page 2 traverses both groups; a cursor inside the claimed group must also work.
    const first = await call('invites/list', owner.accessToken, { limit: 100 });
    const crossing = await call('invites/list', owner.accessToken, { limit: 20, cursor: first.nextCursor });
    const last = await call('invites/list', owner.accessToken, { limit: 100, cursor: crossing.nextCursor });
    assert.deepEqual(last.items.map((item: any) => item.inviteeUid), expected.slice(120).map(item => item.id));
    assert.equal(last.nextCursor, null);
  });

  await t.test('claiming a cursor row cannot skip remaining unclaimed records; refreshing reorders groups', async () => {
    const owner = await login('moving_cursor_owner');
    const one = await login('moving_cursor_one'); const two = await login('moving_cursor_two');
    for (const player of [one, two]) await call('invites/report', player.accessToken, { inviterUid: owner.user.id });
    const first = await call('invites/list', owner.accessToken, { limit: 1 });
    const claimedUid = first.items[0].inviteeUid;
    const remainingUid = [one.user.id, two.user.id].find(uid => uid !== claimedUid);
    await call('invites/claim', owner.accessToken, { inviteeUid: claimedUid });
    const second = await call('invites/list', owner.accessToken, { limit: 1, cursor: first.nextCursor });
    assert.equal(second.items[0].inviteeUid, remainingUid);
    assert.equal(second.items[0].rewardClaimed, false);
    const fresh = await call('invites/list', owner.accessToken, {});
    assert.deepEqual(fresh.items.map((item: any) => item.inviteeUid), [remainingUid, claimedUid]);
    assert.deepEqual(fresh.summary, { total: 2, claimed: 1, unclaimed: 1 });
    // A live traversal may see the moved record again in the claimed group; never skip pending rewards.
    const third = await call('invites/list', owner.accessToken, { limit: 1, cursor: second.nextCursor });
    assert.equal(third.items[0].inviteeUid, claimedUid); assert.equal(third.nextCursor, null);
  });

  await t.test('daily reward claims stop at 50 but retries remain idempotent and denied rows remain pending', async () => {
    const { owner, ids } = await quotaFixture('daily_quota_owner', 49);
    const fiftieth = await call('invites/claim', owner.accessToken, { inviteeUid: ids[49] });
    assert.equal(fiftieth.rewardClaimed, true);
    const denied = await call('invites/claim', owner.accessToken, { inviteeUid: ids[50] }, 409);
    assert.equal(denied.message, 'INVITE_DAILY_CLAIM_LIMIT');
    assert.deepEqual(await call('invites/claim', owner.accessToken, { inviteeUid: ids[49] }), fiftieth);
    await call('invites/claim', other.accessToken, { inviteeUid: ids[49] }, 404);
    await call('invites/claim', owner.accessToken, { inviteeUid: randomUUID() }, 404);
    const stored = (await pool.query('SELECT claim_id,reward_claimed_at FROM game_invitations WHERE invitee_user_id=$1', [ids[50]])).rows[0];
    assert.deepEqual(stored, { claim_id: null, reward_claimed_at: null });
    assert.deepEqual((await call('invites/list', owner.accessToken, {})).summary, { total: 54, claimed: 50, unclaimed: 4 });
  });

  await t.test('concurrent claims across API instances and tokens cannot exceed the last daily slot', async () => {
    const { owner, ids } = await quotaFixture('daily_concurrent_owner', 49);
    const secondToken = (await login('daily_concurrent_owner')).accessToken;
    const secondApp = await createApplication(config, { wechat });
    await secondApp.listen(0, '127.0.0.1');
    try {
      const results = await Promise.all(ids.slice(49).map((id, index) => request((index % 2 ? secondApp : app).getHttpServer())
        .post(prefix + 'invites/claim').set('Authorization', 'Bearer ' + (index % 2 ? secondToken : owner.accessToken))
        .send({ inviteeUid: id })));
      assert.equal(results.filter(r => r.status === 200).length, 1);
      assert.equal(results.filter(r => r.status === 409 && r.body.message === 'INVITE_DAILY_CLAIM_LIMIT').length, 4);
      assert.equal((await pool.query('SELECT count(claim_id)::int AS n FROM game_invitations WHERE inviter_user_id=$1', [owner.user.id])).rows[0].n, 50);
      const winner = results.findIndex(r => r.status === 200);
      assert.deepEqual(await call('invites/claim', secondToken, { inviteeUid: ids[49 + winner] }), results[winner]!.body);
    } finally { await secondApp.close(); }
    // Another inviter has an independent daily allowance.
    const independent = await quotaFixture('daily_independent_owner', 0, 1);
    assert.equal((await call('invites/claim', independent.owner.accessToken, { inviteeUid: independent.ids[0] })).rewardClaimed, true);
  });

  await t.test('daily quota uses Beijing midnight inclusive and next midnight exclusive, not UTC midnight', async () => {
    const { owner, ids } = await quotaFixture('daily_timezone_owner', 50);
    await pool.query(`UPDATE game_invitations SET reward_claimed_at=
      ((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai'
      WHERE inviter_user_id=$1 AND claim_id IS NOT NULL`, [owner.user.id]);
    await pool.query(`UPDATE game_invitations SET reward_claimed_at=reward_claimed_at - interval '1 microsecond' WHERE invitee_user_id=$1`, [ids[48]]);
    await pool.query(`UPDATE game_invitations SET reward_claimed_at=reward_claimed_at + interval '1 day' WHERE invitee_user_id=$1`, [ids[49]]);
    // 48 at today's Beijing midnight count; the previous/next day records do not.
    await call('invites/claim', owner.accessToken, { inviteeUid: ids[50] });
    await call('invites/claim', owner.accessToken, { inviteeUid: ids[51] });
    assert.equal((await call('invites/claim', owner.accessToken, { inviteeUid: ids[52] }, 409)).message, 'INVITE_DAILY_CLAIM_LIMIT');
    assert.equal((await call('invites/claim', owner.accessToken, { inviteeUid: ids[48] })).rewardClaimed, true);
  });

  await t.test('50 previous-day claims leave today free for pending rewards without resetting old receipts', async () => {
    const { owner, ids } = await quotaFixture('daily_next_day_owner', 50);
    await pool.query(`UPDATE game_invitations SET reward_claimed_at=
      (((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai') - interval '1 microsecond'
      WHERE inviter_user_id=$1 AND claim_id IS NOT NULL`, [owner.user.id]);
    const previous = (await pool.query('SELECT claim_id,reward_claimed_at FROM game_invitations WHERE invitee_user_id=$1', [ids[0]])).rows[0];
    const pending = await call('invites/claim', owner.accessToken, { inviteeUid: ids[50] });
    assert.equal(pending.rewardClaimed, true);
    const retry = await call('invites/claim', owner.accessToken, { inviteeUid: ids[0] });
    assert.equal(retry.claimId, previous.claim_id); assert.equal(retry.rewardClaimedAt, previous.reward_claimed_at.toISOString());
  });

  await t.test('DB constraints enforce single inviter, cross-app isolation and coherent claim state', async () => {
    const foreign = (await pool.query('SELECT id FROM game_users WHERE app_id=$1 LIMIT 1', ['wx1111111111111111'])).rows[0].id;
    await assert.rejects(pool.query('INSERT INTO game_invitations(app_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3)',
      [config.appId, a.user.id, a.user.id]), (error: any) => error.code === '23514');
    await assert.rejects(pool.query('INSERT INTO game_invitations(app_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3)',
      [config.appId, foreign, other.user.id]), (error: any) => error.code === '23503');
    await assert.rejects(pool.query('INSERT INTO game_invitations(app_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3)',
      [config.appId, a.user.id, race.user.id]), (error: any) => error.code === '23505');
    await assert.rejects(pool.query('UPDATE game_invitations SET claim_id=gen_random_uuid() WHERE invitee_user_id=$1', [race.user.id]),
      (error: any) => error.code === '23514');
  });

  await t.test('missing, expired, malformed and cross-app sessions fail closed, without accepting request identity', async () => {
    for (const operation of ['users/profile', 'invites/report', 'invites/list', 'invites/claim']) {
      await request(app.getHttpServer()).post(prefix + operation).send({}).expect(401);
    }
    await call('invites/list', 'bad-token', {}, 401);
    await call('invites/list', 'a'.repeat(43), {}, 401);
    const actor = await login('session_boundary_user');
    const key = 'minigame:session:' + createHash('sha256').update(actor.accessToken).digest('hex');
    const raw = (await redis.get(key))!; const session = JSON.parse(raw);
    await redis.set(key, JSON.stringify({ ...session, appId: 'wx1111111111111111' }), { EX: 60 });
    await call('invites/list', actor.accessToken, {}, 401);
    await redis.set(key, JSON.stringify({ ...session, isNewUser: 'true' }), { EX: 60 });
    await call('invites/list', actor.accessToken, {}, 401);
    await redis.del(key); await call('invites/list', actor.accessToken, {}, 401);
  });

  await t.test('claim storage failure is sanitized and cannot mark a reward claimed', async () => {
    await pool.query('ALTER TABLE game_invitations RENAME TO game_invitations_unavailable');
    try {
      for (const [operation, payload] of [['invites/list', {}], ['invites/claim', { inviteeUid: race.user.id }]] as const) {
        const failure = await call(operation, raceWinner.accessToken, payload, 503);
        assert.equal(failure.message, 'INVITE_STORAGE_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(failure), /SELECT|UPDATE|postgres|stack|password|token/);
      }
    } finally { await pool.query('ALTER TABLE game_invitations_unavailable RENAME TO game_invitations'); }
    const row = (await pool.query('SELECT claim_id,reward_claimed_at FROM game_invitations WHERE invitee_user_id=$1', [race.user.id])).rows[0];
    assert.deepEqual(row, { claim_id: null, reward_claimed_at: null });
  });

  await t.test('a refused NX session reservation never deletes an existing session key', async () => {
    const client: any = app.get(Infrastructure).redis;
    const previous = client.withCommandOptions;
    let reservedKey: string | undefined;
    client.withCommandOptions = function (options: unknown) {
      const commands = previous.call(this, options);
      return new Proxy(commands, {
        get(target, name) {
          if (name === 'set') return async (...args: any[]) => {
            reservedKey = args[0] as string;
            await redis.set(reservedKey, 'existing-session-reservation', { EX: 60 });
            return commands.set(...args);
          };
          const value = Reflect.get(target, name);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    try {
      const response = await request(app.getHttpServer()).post(prefix + 'auth/wechat-login').send({ code: 'nx_collision_user' }).expect(503);
      assert.equal(response.body.accessToken, undefined);
      assert.ok(reservedKey);
      assert.equal(await redis.get(reservedKey), 'existing-session-reservation');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_users WHERE open_id=$1', ['nx_collision_user'])).rows[0].n, 0);
    } finally {
      client.withCommandOptions = previous;
      if (reservedKey) await redis.del(reservedKey);
    }
  });

  await t.test('Redis write failure rolls back registration, so a successful retry still qualifies as new', async () => {
    let broken: Awaited<ReturnType<typeof createApplication>>;
    const failing = new WechatClient(config, async () => {
      broken.get(Infrastructure).redis.destroy();
      return Response.json({ openid: 'registration_recovery_user', session_key: 'explicit-stub' });
    });
    broken = await createApplication(config, { wechat: failing }); await broken.init();
    try {
      const failure = await request(broken.getHttpServer()).post(prefix + 'auth/wechat-login').send({ code: 'fresh-code' }).expect(503);
      assert.equal(failure.body.accessToken, undefined);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_users WHERE open_id=$1', ['registration_recovery_user'])).rows[0].n, 0);
    } finally { await broken.close(); }
    const recovered = await login('registration_recovery_user');
    assert.equal(recovered.isNewUser, true);
    assert.equal((await call('invites/report', recovered.accessToken, { inviterUid: a.user.id })).accepted, true);
  });

  await t.test('feature rate limit is atomic across tokens, separate from save quota, and expires', async () => {
    const one = await login('feature_rate_user'); const two = await login('feature_rate_user');
    const responses = await Promise.all(Array.from({ length: 65 }, (_, index) => request(app.getHttpServer()).post(prefix + 'invites/list')
      .set('Authorization', 'Bearer ' + (index % 2 ? one.accessToken : two.accessToken)).send({})));
    assert.equal(responses.filter(response => response.status === 200).length, 60);
    assert.equal(responses.filter(response => response.status === 429).length, 5);
    assert.ok(responses.filter(response => response.status === 429).every(response => response.body.message === 'INVITE_RATE_LIMITED' && Number(response.headers['retry-after']) >= 1));
    assert.equal((await request(app.getHttpServer()).post(prefix + 'data/get').set('Authorization', 'Bearer ' + one.accessToken).send({}).expect(200)).body.exists, false);
    const key = `minigame:invite-rate:${config.appId}:${one.user.id}`;
    await redis.expire(key, 1); await new Promise(resolve => setTimeout(resolve, 1100));
    await call('invites/list', one.accessToken, {});
  });
});
