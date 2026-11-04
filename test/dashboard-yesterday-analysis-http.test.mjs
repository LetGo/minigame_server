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
const analysis = {today: '2026-10-22', cohortDate: '2026-10-21', timezone: 'Asia/Shanghai',
  generatedAt: '2026-10-22T00:00:00.000000Z', loginCoverage: true,
  registrations: {total: 3, items: [{scene: 1001, value: 2}, {scene: null, value: 1}]},
  rewardedVideos: {total: 4, items: [{scene: 1001, value: 4}]},
  returnedUsers: {total: 1, items: [{scene: 1001, value: 1}]}};

async function start(t, {yesterdayAnalysis = async () => analysis} = {}) {
  const redis = new FakeRedis(), pool = {tag: 'pool'};
  const beijingToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const queries = {overview: async () => ({today: beijingToday, generatedAt: new Date().toISOString(), metrics: {}}), player: async () => null};
  if (yesterdayAnalysis !== null) queries.yesterdayAnalysis = yesterdayAnalysis;
  const server = createDashboardServer({pool, redis, config, queries, loginRateLimit: 50});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const api = request(server);
  const login = await api.post('/h5dashboard/api/login').set('Origin', config.origin).send({username: 'admin', password}).expect(200);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  return {api, cookie, pool, redis};
}

test('yesterday analysis route is POST-only, authenticated and origin-checked', async t => {
  const {api, cookie, pool} = await start(t);
  const post = () => api.post('/h5dashboard/api/yesterday-analysis').set('Origin', config.origin);
  await api.post('/h5dashboard/api/yesterday-analysis').set('Origin', config.origin).send({}).expect(401);
  await api.post('/h5dashboard/api/yesterday-analysis').set('Origin', 'https://evil.example.com').set('Cookie', cookie).send({}).expect(403);
  await api.get('/h5dashboard/api/yesterday-analysis').set('Cookie', cookie).expect(404);
  await api.put('/h5dashboard/api/yesterday-analysis').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(404);
  await api.post('/h5dashboard/api/yesterday-analysis?appId=wx9999999999999999').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(404);
  await api.post('/h5dashboard/api/yesterday-analysis/').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(404);
  const ok = await post().set('Cookie', cookie).send({}).expect(200);
  assert.deepEqual(ok.body, analysis);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.match(ok.headers['content-type'], /^application\/json/);
  assert.match(ok.headers['content-security-policy'], /script-src 'self'/);
  assert.deepEqual(pool, {tag: 'pool'}, 'the dashboard pool is only read from');
});

test('yesterday analysis is app-scoped from server config and rejects client overrides', async t => {
  const calls = [];
  const {api, cookie, pool} = await start(t, {yesterdayAnalysis: async (...args) => { calls.push(args); return analysis; }});
  const post = () => api.post('/h5dashboard/api/yesterday-analysis').set('Origin', config.origin).set('Cookie', cookie);
  await post().send({}).expect(200);
  assert.deepEqual(calls.map(([, appId]) => appId), [config.appId], 'the route passes only the configured game');
  assert.equal(calls[0][0], pool, 'the route uses the dashboard pool');
  for (const body of [{date: '2026-10-21'}, {appId: 'wx9999999999999999'}, {days: 1}, {scene: 1001}, {timezone: 'UTC'}]) {
    await post().send(body).expect(400).then(r => assert.equal(r.body.message, 'INVALID_REQUEST'));
  }
  await post().set('Content-Type', 'application/json').send('null').expect(400);
  await post().set('Content-Type', 'application/json').send('[]').expect(400);
  await post().set('Content-Type', 'application/json').send('{bad').expect(400);
  await api.post('/h5dashboard/api/yesterday-analysis').set('Origin', config.origin).set('Cookie', cookie).expect(415);
  assert.equal(calls.length, 1, 'invalid requests never reach the query');
});

test('an absent or failing yesterday analysis loader fails closed with a generic 503', async t => {
  const missing = await start(t, {yesterdayAnalysis: null});
  const absent = await missing.api.post('/h5dashboard/api/yesterday-analysis').set('Origin', config.origin)
    .set('Cookie', missing.cookie).send({}).expect(503);
  assert.equal(absent.body.message, 'YESTERDAY_ANALYSIS_UNAVAILABLE');
  assert.equal(absent.headers['cache-control'], 'no-store');

  const failing = await start(t, {yesterdayAnalysis: async () => { throw new Error('private SQL detail wx1111111111111111'); }});
  const broken = await failing.api.post('/h5dashboard/api/yesterday-analysis').set('Origin', config.origin)
    .set('Cookie', failing.cookie).send({}).expect(503);
  assert.equal(broken.body.message, 'DASHBOARD_UNAVAILABLE');
  assert.equal(broken.text.includes('private'), false);
  assert.equal(broken.text.includes(config.appId), false);

  const nulled = await start(t, {yesterdayAnalysis: async () => null});
  const empty = await nulled.api.post('/h5dashboard/api/yesterday-analysis').set('Origin', config.origin)
    .set('Cookie', nulled.cookie).send({}).expect(503);
  assert.equal(empty.body.message, 'YESTERDAY_ANALYSIS_UNAVAILABLE', 'an empty snapshot is not served as a valid analysis');
});

test('existing routes keep working when the analysis loader is absent', async t => {
  const {api, cookie} = await start(t, {yesterdayAnalysis: null});
  await api.get('/h5dashboard/api/overview').set('Cookie', cookie).expect(200);
  await api.get('/h5dashboard/api/me').set('Cookie', cookie).expect(200);
  await api.post('/h5dashboard/api/logout').set('Origin', config.origin).set('Cookie', cookie).send({}).expect(200);
  await api.get('/h5dashboard/api/me').set('Cookie', cookie).expect(401);
});
