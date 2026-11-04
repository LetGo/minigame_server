import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createClient} from 'redis';
import request from 'supertest';
import {migrate} from '../src/database/migrate.js';

// Test-only PostgreSQL 15439 / Redis 16389 (compose.test.yaml). Never production/staging.
const OWNER = 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';

type Player = {uid: string; openid: string; nickname: string | null; completed: boolean};
type Ev = {app: string; uid: string; at: Date; openid: string; nickname: string | null; completed: boolean};

test('dashboard video ranking is a read-only app-scoped top 20 of one Beijing day with cumulative totals', async t => {
  const pool = new Pool({connectionString: OWNER});
  const suffix = randomBytes(3).toString('hex');
  const appId = 'vr_' + suffix, foreignApp = 'vrf_' + suffix, emptyApp = 'vre_' + suffix;
  const apps = [appId, foreignApp, emptyApp];
  t.after(async () => {
    await pool.query('DELETE FROM game_users WHERE app_id=ANY($1::varchar[])', [apps]);
    await pool.end();
  });
  await migrate(pool);
  const {videoRanking} = await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
  assert.equal(typeof videoRanking, 'function', 'dashboard video ranking query must be exported');

  const clock = (await pool.query(`SELECT (m.at AT TIME ZONE 'Asia/Shanghai')::date::text AS today,
      (m.at AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS midnight
    FROM (SELECT clock_timestamp() AS at) m`)).rows[0];
  const today = clock.today as string;
  const midnight = new Date(clock.midnight).getTime();
  const day = (offset: number) => new Date(midnight + offset * 86400000);
  const at = (offset: number, hours = 9) => new Date(day(offset).getTime() + hours * 3600000);
  const bjDate = (stamp: number) => new Date(stamp + 8 * 3600000).toISOString().slice(0, 10);

  // Deterministic canonical UUIDs (shared per-run prefix) so tie ordering is explicit.
  const pad = (n: number) => n.toString(16).padStart(6, '0');
  const uid = (n: number) => `00000000-0000-4000-8000-${suffix}${pad(n)}`;
  const counts = [50, 40, 40, 30, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 10, 9, 8, 7, 6];
  const players: (Player & {daily: number})[] = counts.map((daily, i) => ({
    uid: uid(i), openid: `vr_player_${i}`, nickname: i === 0 ? '<b>玩家一</b>' : i === 1 ? null : `昵称${i}`,
    completed: true, daily
  }));
  const zero: Player = {uid: uid(25), openid: 'vr_zero', nickname: '零次', completed: true};
  const incomplete: Player = {uid: uid(26), openid: 'vr_incomplete', nickname: '未完成', completed: false};
  const foreign: Player = {uid: uid(27), openid: 'vr_foreign', nickname: '外域', completed: true};
  const empty: Player = {uid: uid(28), openid: 'vr_empty_app', nickname: null, completed: true};
  const all = [...players, zero, incomplete, foreign, empty];

  await pool.query(`INSERT INTO game_users(id,app_id,open_id,first_login_completed)
      SELECT u.id,u.app,u.openid,u.completed FROM unnest($1::uuid[],$2::varchar[],$3::varchar[],$4::boolean[]) u(id,app,openid,completed)`,
    [all.map(p => p.uid), all.map(p => p.uid === foreign.uid ? foreignApp : p.uid === empty.uid ? emptyApp : appId),
      all.map(p => p.openid), all.map(p => p.completed)]);
  await pool.query(`INSERT INTO game_profiles(user_id,nickname,avatar_url)
      SELECT u.id,u.nickname,'https://example.test/a.png' FROM unnest($1::uuid[],$2::varchar[]) u(id,nickname)`,
    [all.filter(p => p.nickname !== null).map(p => p.uid), all.filter(p => p.nickname !== null).map(p => p.nickname)]);

  const events: Ev[] = [];
  const add = (app: string, p: Player, at: Date) => events.push({app, uid: p.uid, at, openid: p.openid, nickname: p.nickname, completed: p.completed});
  for (const p of players) for (let n = 0; n < p.daily; n++) add(appId, p, at(0, 9));
  for (let n = 0; n < 100; n++) add(appId, incomplete, at(0, 10));
  for (let n = 0; n < 200; n++) add(foreignApp, foreign, at(0, 10));
  // Historical events: cumulative totals ignore the selected day; day boundaries are microsecond exact.
  for (let n = 0; n < 7; n++) add(appId, players[0]!, at(-35, 12));
  add(appId, players[0]!, new Date(midnight - 1));                 // 1 millisecond before today's midnight
  add(appId, players[1]!, new Date(midnight + 86400000));          // exactly next midnight
  add(appId, players[2]!, at(-1, 12));
  add(appId, players[2]!, at(-1, 13));

  async function seed(rows: Ev[]) {
    await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at)
        SELECT r.app,r.uid,gen_random_uuid(),'level_clear',r.at
        FROM unnest($1::varchar[],$2::uuid[],$3::timestamptz[]) r(app,uid,at)`,
      [rows.map(r => r.app), rows.map(r => r.uid), rows.map(r => r.at)]);
  }
  await seed(events);

  // Independent JS oracle: same documented ranking rules, no SQL reuse.
  function expected(app: string, start: number) {
    const daily = new Map<string, number>(), total = new Map<string, number>(), meta = new Map<string, Ev>();
    for (const e of events) {
      if (e.app !== app) continue;
      meta.set(e.uid, e);
      total.set(e.uid, (total.get(e.uid) ?? 0) + 1);
      if (e.at.getTime() >= start && e.at.getTime() < start + 86400000) daily.set(e.uid, (daily.get(e.uid) ?? 0) + 1);
    }
    return [...daily.entries()].filter(([id, n]) => n > 0 && meta.get(id)!.completed)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)).slice(0, 20)
      .map(([id, n], i) => ({rank: i + 1, userId: id, openid: meta.get(id)!.openid, nickname: meta.get(id)!.nickname,
        dailyCount: n, totalCount: total.get(id)!}));
  }

  await t.test('no events yields an empty ranking and a database-supplied day', async () => {
    const result = await videoRanking(pool, emptyApp);
    assert.deepEqual(result.items, []);
    assert.equal(result.limit, 20);
    assert.equal(result.timezone, 'Asia/Shanghai');
    assert.equal(result.today, today);
    assert.equal(result.date, today, 'omitted date defaults to the database Beijing today, not the caller clock');
    assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, 'generatedAt is ISO-8601 UTC');
    assert.equal(Number.isFinite(Date.parse(result.generatedAt)), true);
  });

  await t.test('ranks the daily top 20 with stable UID ties at the cutoff and cumulative totals', async () => {
    const result = await videoRanking(pool, appId) as any;
    assert.deepEqual(result.items, expected(appId, midnight));
    assert.equal(result.items.length, 20, 'only the top 20 are returned');
    assert.deepEqual(result.items.map((x: any) => x.rank), Array.from({length: 20}, (_x, i) => i + 1));
    const byId = new Map<string, any>(result.items.map((x: any) => [x.userId as string, x] as [string, any]));
    const top = byId.get(players[0]!.uid)! as any;
    assert.equal(top.dailyCount, 50);
    assert.equal(top.totalCount, 58, 'cumulative counts include 7 historical events and the pre-midnight event');
    assert.equal(top.nickname, '<b>玩家一</b>', 'nicknames are returned verbatim; escaping is a rendering concern');
    assert.equal(byId.get(players[1]!.uid)!.nickname, null, 'a player without a profile keeps a null nickname');
    assert.equal(byId.get(players[1]!.uid)!.totalCount, 41, 'the exact next-midnight event is cumulative but not today');
    assert.ok((byId.get(players[2]!.uid)!.userId as string) > (byId.get(players[1]!.uid)!.userId as string),
      'equal daily counts are ordered by canonical user id descending');
    assert.equal(result.items[19]!.userId, players[20]!.uid, 'the higher UUID wins the tied last slot');
    assert.equal(byId.has(players[19]!.uid), false, 'the tied lower UUID is cut off at 20');
    for (const p of players.slice(21)) assert.equal(byId.has(p.uid), false, 'positive counts below the cutoff stay out');
    assert.equal(byId.has(zero.uid), false, 'players without events are absent, never zero-filled');
    assert.equal(byId.has(incomplete.uid), false, 'only completed registrations are ranked');
    assert.equal(byId.has(foreign.uid), false, 'other apps never leak into the ranking');
    assert.equal(result.items.every((x: any) => x.dailyCount > 0), true);
  });

  await t.test('the selected date picks its own Beijing day window', async () => {
    const previous = bjDate(day(-1).getTime());
    const next = bjDate(day(1).getTime());
    const yesterday = await videoRanking(pool, appId, previous);
    assert.equal(yesterday.date, previous);
    assert.equal(yesterday.today, today, 'today is independent of the selected date');
    assert.deepEqual(yesterday.items, expected(appId, day(-1).getTime()));
    assert.deepEqual(yesterday.items.map((x: any) => [x.rank, x.openid, x.dailyCount]), [[1, 'vr_player_2', 2], [2, 'vr_player_0', 1]]);
    assert.equal(yesterday.items[1]!.totalCount, 58, 'cumulative totals do not depend on the selected day');

    const tomorrow = await videoRanking(pool, appId, next);
    assert.deepEqual(tomorrow.items.map((x: any) => [x.rank, x.openid, x.dailyCount, x.totalCount]), [[1, 'vr_player_1', 1, 41]]);
    assert.equal(tomorrow.date, next);

    const far = await videoRanking(pool, appId, '2000-01-01');
    assert.equal(far.date, '2000-01-01');
    assert.deepEqual(far.items, []);
    for (const edge of ['0001-01-01', '9999-12-31']) {
      const bounded = await videoRanking(pool, appId, edge);
      assert.equal(bounded.date, edge, 'the supported canonical year range stays queryable');
      assert.deepEqual(bounded.items, []);
      assert.equal(bounded.today, today);
    }
  });

  await t.test('is one parameterized aggregate query that never loads event payloads or leaks the app id', async () => {
    const seen: {sql: string; params: unknown[]}[] = [];
    const spy = {query: async (sql: string, params: unknown[]) => {
      seen.push({sql, params});
      return pool.query(sql, params as any[]);
    }} as any;
    const result = await videoRanking(spy, appId, '2026-01-02');
    assert.equal(seen.length, 1, 'the ranking must stay a single database round trip');
    const {sql, params} = seen[0]!;
    assert.deepEqual(params, [appId, '2026-01-02'], 'only app and date are bound');
    assert.equal(sql.includes(appId), false, 'app id must be parameterized');
    assert.equal(sql.includes('2026-01-02'), false, 'date must be parameterized');
    assert.equal((sql.match(/clock_timestamp\(\)/g) ?? []).length, 1, 'one materialized DB clock drives every day boundary');
    assert.match(sql, /MATERIALIZED/);
    assert.match(sql, /Asia\/Shanghai/);
    assert.match(sql, /LIMIT 20/i);
    assert.match(sql, /first_login_completed/);
    assert.match(sql, /count\(\*\)/i, 'daily and cumulative counts are aggregated in SQL');
    assert.doesNotMatch(sql, /client_info/i, 'event payloads are never read');
    assert.equal(result.date, '2026-01-02');
  });

  await t.test('duplicate event ids are deduplicated by the primary key and never inflate counts', async () => {
    const before = await videoRanking(pool, appId);
    const eventId = randomUUID();
    const stamp = at(0, 11);
    await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at)
      VALUES($1,$2,$3,'level_clear',$4)`, [appId, players[3]!.uid, eventId, stamp]);
    await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at)
      VALUES($1,$2,$3,'level_clear',$4) ON CONFLICT DO NOTHING`, [appId, players[3]!.uid, eventId, stamp]);
    const after = await videoRanking(pool, appId);
    assert.equal(after.items.find((x: any) => x.userId === players[3]!.uid).dailyCount,
      before.items.find((x: any) => x.userId === players[3]!.uid).dailyCount + 1);
    assert.equal(after.items.find((x: any) => x.userId === players[3]!.uid).totalCount,
      before.items.find((x: any) => x.userId === players[3]!.uid).totalCount + 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',
      [appId, players[3]!.uid, eventId])).rows[0].n, 1);
  });

  await t.test('SQL microsecond-before midnight is excluded, exact midnight included, next midnight excluded',async()=>{
    await pool.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at)
      SELECT $1,$2,gen_random_uuid(),'precise_boundary',stamp FROM (VALUES
        ($3::timestamptz-interval '1 microsecond'),($3::timestamptz),($3::timestamptz+interval '1 day')
      ) edge(stamp)`,[emptyApp,empty.uid,day(0)]);
    const current=await videoRanking(pool,emptyApp);
    assert.deepEqual(current.items,[{rank:1,userId:empty.uid,openid:empty.openid,nickname:null,dailyCount:1,totalCount:3}]);
    const before=await videoRanking(pool,emptyApp,bjDate(day(-1).getTime()));assert.equal(before.items[0].dailyCount,1);
    const next=await videoRanking(pool,emptyApp,bjDate(day(1).getTime()));assert.equal(next.items[0].dailyCount,1);
  });
});

test('video ranking HTTP stays authenticated, origin-checked and readonly on real PostgreSQL', async t => {
  const owner = new Pool({connectionString: OWNER});
  await migrate(owner);
  const suffix = randomBytes(5).toString('hex'), appId = 'vrh_' + suffix;
  const role = 'vr_http_' + suffix, password = 'isolated-video-ranking-test-only';
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query('GRANT SELECT ON game_users,game_profiles,game_rewarded_video_events TO ' + role);
  await owner.query(`ALTER ROLE ${role} SET default_transaction_read_only=on`);
  const {createDashboardPool} = await import(pathToFileURL(resolve('dashboard/server.mjs')).href);
  const pool = createDashboardPool(`postgresql://${role}:${password}@127.0.0.1:15439/minigame_test`);
  const redis = createClient({url: 'redis://127.0.0.1:16389/13'});
  redis.on('error', () => {});
  await redis.connect();
  await redis.flushDb();
  const queries = await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
  const {createDashboardServer} = await import(pathToFileURL(resolve('dashboard/backend.js')).href);
  const salt = '11223344556677889900112233445566';
  const config = {username: 'vrtest', passwordHash: salt + ':' + scryptSync(password, salt, 64).toString('hex'),
    appId, origin: 'https://dashboard.example.com', basePath: '/h5dashboard/', environment: 'production'};
  const server = createDashboardServer({pool, redis, config, queries});
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const strict = createDashboardServer({pool, redis, config, queries: {...queries, videoRanking: async () => {
    throw new Error('sensitive upstream detail');
  }}});
  await new Promise<void>(r => strict.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise<void>(r => server.close(r));
    await new Promise<void>(r => strict.close(r));
    await redis.quit();
    await pool.end();
    await owner.query('DELETE FROM game_users WHERE app_id=$1', [appId]);
    await owner.query(`DROP OWNED BY ${role}`);
    await owner.query(`DROP ROLE ${role}`);
    await owner.end();
  });

  const clock = (await owner.query(`SELECT (m.at AT TIME ZONE 'Asia/Shanghai')::date::text AS today,
      (m.at AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS midnight
    FROM (SELECT clock_timestamp() AS at) m`)).rows[0];
  const today = clock.today as string, midnight = new Date(clock.midnight).getTime();
  const ids = [randomUUID(), randomUUID()];
  await owner.query('INSERT INTO game_users(id,app_id,open_id) SELECT u,$1,\'vrh_\'||u::text FROM unnest($2::uuid[]) AS u', [appId, ids]);
  await owner.query(`INSERT INTO game_profiles(user_id,nickname,avatar_url) VALUES($1,'HTTP 玩家','https://example.test/a.png')`, [ids[0]]);
  await owner.query(`INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,recorded_at)
      SELECT $1,u,gen_random_uuid(),'level_clear',x.at FROM unnest($2::uuid[],$3::timestamptz[]) AS x(u,at)`,
    [appId, [ids[0], ids[0], ids[0], ids[1]],
      [new Date(midnight + 3600000), new Date(midnight + 3600001), new Date(midnight + 3600002), new Date(midnight + 7200000)]]);

  assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
  await assert.rejects(() => pool.query('UPDATE game_users SET last_login_at=clock_timestamp() WHERE id=$1', [ids[0]]));
  await assert.rejects(() => pool.query("INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement) VALUES($1,$2,gen_random_uuid(),'x')", [appId, ids[0]]));

  const api = request(server);
  await api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin).send({}).expect(401);
  const login = await api.post('/h5dashboard/api/login').set('Origin', config.origin)
    .send({username: config.username, password}).expect(200);
  const cookie = String((login.headers['set-cookie'] as unknown as string[])[0]).split(';')[0]!;
  await api.post('/h5dashboard/api/video-ranking').set('Cookie', cookie).send({}).expect(403);
  await api.get('/h5dashboard/api/video-ranking').set('Cookie', cookie).expect(404);
  await api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin).set('Cookie', cookie).send({date: null}).expect(400);
  await api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin).set('Cookie', cookie)
    .send({date: '2026-02-30'}).expect(400);
  await api.post('/h5dashboard/api/video-ranking?limit=1').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(404);

  const ranked = await api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin)
    .set('Cookie', cookie).send({}).expect(200);
  assert.equal(ranked.headers['cache-control'], 'no-store');
  assert.equal(ranked.body.today, today);
  assert.equal(ranked.body.date, today);
  assert.equal(ranked.body.limit, 20);
  assert.deepEqual(ranked.body.items, [
    {rank: 1, userId: ids[0], openid: 'vrh_' + ids[0], nickname: 'HTTP 玩家', dailyCount: 3, totalCount: 3},
    {rank: 2, userId: ids[1], openid: 'vrh_' + ids[1], nickname: null, dailyCount: 1, totalCount: 1}
  ]);

  const historical = await api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin)
    .set('Cookie', cookie).send({date: '2001-02-03'}).expect(200);
  assert.equal(historical.body.date, '2001-02-03');
  assert.equal(historical.body.today, today);
  assert.deepEqual(historical.body.items, []);

  await request(strict).post('/h5dashboard/api/video-ranking').set('Origin', config.origin)
    .set('Cookie', cookie).send({}).expect(503).then(r => {
      assert.equal(r.body.message, 'DASHBOARD_UNAVAILABLE');
      assert.equal(r.text.includes('sensitive'), false, 'dependency errors stay generic');
      assert.equal(r.text.includes(appId), false);
    });
});
