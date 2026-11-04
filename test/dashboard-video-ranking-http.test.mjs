import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scryptSync} from 'node:crypto';
import request from 'supertest';
import {createDashboardServer} from '../dashboard/backend.js';

class FakeRedis {
  map = new Map();
  withCommandOptions() { return this; }
  async eval(_script, {keys}) { const n = Number(this.map.get(keys[0]) ?? 0) + 1; this.map.set(keys[0], String(n)); return n; }
  async set(k, v) { this.map.set(k, v); return 'OK'; }
  async get(k) { return this.map.get(k) ?? null; }
  async del(k) { const keys = Array.isArray(k) ? k : [k]; let n = 0; for (const x of keys) n += this.map.delete(x) ? 1 : 0; return n; }
}
const password = 'explicit-test-dashboard-password', salt = '0123456789abcdef0123456789abcdef';
const config = {username: 'admin', passwordHash: salt + ':' + scryptSync(password, salt, 64).toString('hex'),
  appId: 'wx1111111111111111', origin: 'https://dashboard.example.com', basePath: '/h5dashboard/', environment: 'production'};
const ranking = {today: '2026-10-22', date: '2026-10-22', timezone: 'Asia/Shanghai',
  generatedAt: '2026-10-22T00:00:00.000000Z', limit: 20,
  items: [{rank: 1, userId: '11111111-1111-4111-8111-111111111111', openid: 'o1', nickname: null, dailyCount: 3, totalCount: 9}]};

async function start(t, {videoRanking = async () => ranking} = {}) {
  const redis = new FakeRedis(), pool = {tag: 'pool'};
  const beijingToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const queries = {overview: async () => ({today: beijingToday, generatedAt: new Date().toISOString(), metrics: {}}), player: async () => null};
  if (videoRanking !== null) queries.videoRanking = videoRanking;
  const server = createDashboardServer({pool, redis, config, queries, loginRateLimit: 50});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const api = request(server);
  const login = await api.post('/h5dashboard/api/login').set('Origin', config.origin).send({username: 'admin', password}).expect(200);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  return {api, cookie, pool, redis};
}

test('video ranking route is POST-only, authenticated and origin-checked', async t => {
  const {api, cookie} = await start(t);
  const post = () => api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin);
  await api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin).send({}).expect(401);
  await post().send({}).expect(401);
  await api.post('/h5dashboard/api/video-ranking').set('Origin', 'https://evil.example.com').set('Cookie', cookie).send({}).expect(403);
  await api.get('/h5dashboard/api/video-ranking').set('Cookie', cookie).expect(404);
  await api.put('/h5dashboard/api/video-ranking').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(404);
  await api.post('/h5dashboard/api/video-ranking?limit=1').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(404);
  await api.post('/h5dashboard/api/video-ranking/').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(404);
  const ok = await post().set('Cookie', cookie).send({}).expect(200);
  assert.deepEqual(ok.body, ranking);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.match(ok.headers['content-security-policy'], /script-src 'self'/);
});

test('video ranking forwards only the validated optional date, defaulting to the database clock', async t => {
  const calls = [];
  const {api, cookie, pool} = await start(t, {videoRanking: async (...args) => { calls.push(args); return ranking; }});
  const post = () => api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin).set('Cookie', cookie);
  await post().send({}).expect(200);
  await post().send({date: '2026-10-22'}).expect(200);
  await post().send({date: '9999-12-31'}).expect(200);
  assert.deepEqual(calls.map(([, appId, date]) => [appId, date]), [
    [config.appId, null], [config.appId, '2026-10-22'], [config.appId, '9999-12-31']
  ]);
  assert.equal(calls.every(([p]) => p === pool), true, 'the route uses the dashboard pool');
});

test('video ranking rejects non-canonical dates and any client overrides', async t => {
  const seen = [];
  const {api, cookie} = await start(t, {videoRanking: async (_p, _a, date) => { seen.push(date); return ranking; }});
  const post = () => api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin).set('Cookie', cookie);
  for (const body of [
    {date: null}, {date: ''}, {date: '2026-2-03'}, {date: '2026-02-30'}, {date: '2026-13-01'},
    {date: '0000-01-01'}, {date: 20261022}, {date: ['2026-10-22']}, {date: '2026-10-22T00:00:00Z'},
    {date: '2026-10-22', limit: 1}, {date: '2026-10-22', appId: 'wx9999999999999999'},
    {limit: 20}, {appId: 'wx9999999999999999'}, {days: 7}
  ]) await post().send(body).expect(400).then(r => assert.equal(r.body.message, 'INVALID_REQUEST'));
  await post().set('Content-Type', 'application/json').send('null').expect(400);
  await post().set('Content-Type', 'application/json').send('[{"date":"2026-10-22"}]').expect(400);
  await post().set('Content-Type', 'application/json').send('{bad').expect(400);
  await api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin).set('Cookie', cookie).expect(415);
  assert.deepEqual(seen, [], 'invalid requests never reach the query');
});

test('an absent or failing video ranking loader fails closed with a generic 503', async t => {
  const missing = await start(t, {videoRanking: null});
  const absent = await missing.api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin)
    .set('Cookie', missing.cookie).send({}).expect(503);
  assert.equal(absent.body.message, 'VIDEO_RANKING_UNAVAILABLE');

  const failing = await start(t, {videoRanking: async () => { throw new Error('private SQL detail wx1111111111111111'); }});
  const broken = await failing.api.post('/h5dashboard/api/video-ranking').set('Origin', config.origin)
    .set('Cookie', failing.cookie).send({}).expect(503);
  assert.equal(broken.body.message, 'DASHBOARD_UNAVAILABLE');
  assert.equal(broken.text.includes('private'), false);
  assert.equal(broken.text.includes(config.appId), false);
  assert.equal(broken.headers['cache-control'], 'no-store');
  assert.equal(missing.redis.map.size > 0, true);
});

test('existing routes keep working when the ranking loader is absent', async t => {
  const {api, cookie} = await start(t, {videoRanking: null});
  await api.get('/h5dashboard/api/overview').set('Cookie', cookie).expect(200);
  await api.get('/h5dashboard/api/me').set('Cookie', cookie).expect(200);
  await api.post('/h5dashboard/api/logout').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(200);
  await api.get('/h5dashboard/api/me').set('Cookie', cookie).expect(401);
});
