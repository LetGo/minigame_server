import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { migrate } from '../src/database/migrate.js';
import { WechatClient } from '../src/auth/wechat.client.js';
import { Infrastructure } from '../src/infrastructure.js';

const config = loadConfig({ WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_APP_SECRET: 'integration-test-only',
  DATABASE_URL: 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test', REDIS_URL: 'redis://127.0.0.1:16389/15' });
const prefix = '/h5login/api/data/';

test('JSON cloud saves with real isolated PostgreSQL/Redis', async t => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const redis = createClient({ url: config.redisUrl }); redis.on('error', () => {}); await redis.connect();
  t.after(async () => { await redis.quit(); await pool.end(); });
  await migrate(pool); await pool.query('TRUNCATE game_users CASCADE'); await redis.flushDb();
  const wechat = new WechatClient(config, async input => Response.json({ openid: new URL(String(input)).searchParams.get('js_code'), session_key: 'stubbed-key' }));
  const app = await createApplication(config, { wechat }); await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  async function login(code: string) { return (await request(app.getHttpServer()).post('/h5login/api/auth/wechat-login').send({ code }).expect(200)).body; }
  const one = await login('player_one'); const two = await login('player_two');
  async function call(token: string, operation: string, payload: unknown, status = 200) {
    const r = await request(app.getHttpServer()).post(prefix + operation).set('Authorization', 'Bearer '+token).send(payload as object).expect(status);
    assert.equal(r.headers['cache-control'], 'no-store');
    return r;
  }
  await t.test('authenticated get accepts ordinary JSON and returns ordinary JSON without crypto fields', async () => {
    const r = await call(one.accessToken, 'get', {});
    assert.deepEqual(r.body, { exists: false, version: 0, data: null, updatedAt: null });
    for (const field of ['nonce','ciphertext','tag','ts','v']) assert.equal(Object.hasOwn(r.body, field), false);
  });
  await t.test('save accepts direct version/data JSON and preserves original text across get', async () => {
    const text = '{ "big":9007199254740993123, "text":"'+'中🚀'.repeat(1400)+'" }\n';
    const saved = await call(one.accessToken, 'save', { version: 0, data: text });
    assert.equal(saved.body.version, 1);
    assert.match(saved.body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(saved.body).sort(), ['updatedAt','version']);
    const loaded = await call(one.accessToken, 'get', {});
    assert.equal(loaded.body.data, text); assert.equal(loaded.body.version, 1);
    assert.equal((await pool.query('SELECT data FROM game_saves WHERE user_id=$1',[one.user.id])).rows[0].data,text);
    assert.equal((await call(two.accessToken,'get',{})).body.exists,false);
  });
  await t.test('atomic versions allow one concurrent writer and block repeated same-version saves', async () => {
    const attempts = await Promise.all(['first','second'].map(data =>
      request(app.getHttpServer()).post(prefix+'save').set('Authorization','Bearer '+one.accessToken)
        .send({version:1,data:JSON.stringify({data})})));
    assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
    assert.equal(attempts.find(r=>r.status===409)!.body.message,'SAVE_VERSION_CONFLICT');
    assert.equal((await call(one.accessToken,'get',{})).body.version,2);
    for (let i=0;i<2;i++) assert.equal((await call(one.accessToken,'save',{version:0,data:'{}'},409)).body.message,'SAVE_VERSION_CONFLICT');
    await call(two.accessToken,'save',{version:1,data:'{}'},409);
    // Reads need no timestamps/nonces and can be repeated normally.
    await call(one.accessToken,'get',{}); await call(one.accessToken,'get',{});
    assert.deepEqual(await redis.keys('minigame:data-nonce:*'),[]);
  });
  await t.test('strict JSON schemas reject identity injection, legacy crypto envelopes and query parameters', async () => {
    const oldEnvelope={v:1,ts:Date.now(),nonce:'old',ciphertext:'old',tag:'old'};
    for (const payload of [{version:2,data:'not-json'}, {version:2,data:'"'+String.fromCharCode(0xd800)+'"'},
      {version:-1,data:'{}'}, {version:'2',data:'{}'}, {version:2147483647,data:'{}'},
      {version:2,data:'{}',userId:two.user.id}, {version:2,data:{}}, {data:'{}'}, oldEnvelope, []]) {
      assert.equal((await call(one.accessToken,'save',payload,400)).body.message,'INVALID_SAVE_DATA');
    }
    for (const payload of [{userId:two.user.id},oldEnvelope,[],{version:0,data:'{}'}]) {
      assert.equal((await call(one.accessToken,'get',payload,400)).body.message,'INVALID_DATA_REQUEST');
    }
    const query=await request(app.getHttpServer()).post(prefix+'get?userId='+two.user.id)
      .set('Authorization','Bearer '+one.accessToken).send({}).expect(400);
    assert.equal(query.body.message,'INVALID_DATA_REQUEST');
    const malformed=await request(app.getHttpServer()).post(prefix+'save').set('Authorization','Bearer '+one.accessToken)
      .set('Content-Type','application/json').send('{bad-sensitive-content').expect(400);
    assert.equal(malformed.body.message,'INVALID_JSON');
    assert.doesNotMatch(JSON.stringify(malformed.body),/bad-sensitive-content/);
  });
  await t.test('64KiB original files including worst-case escaping round trip, larger UTF8 files fail', async () => {
    const text='{'+'\t'.repeat(65534)+'}';
    assert.equal(Buffer.byteLength(text),65536);
    assert.equal((await call(two.accessToken,'save',{version:0,data:text})).body.version,1);
    assert.equal((await call(two.accessToken,'get',{})).body.data,text);
    for (const data of ['{'+'\t'.repeat(65535)+'}',JSON.stringify('中'.repeat(21845))]) {
      assert.equal((await call(two.accessToken,'save',{version:1,data},400)).body.message,'INVALID_SAVE_DATA');
    }
    await request(app.getHttpServer()).post(prefix+'save').set('Authorization','Bearer '+two.accessToken)
      .send({version:1,data:'x'.repeat(270000)}).expect(413);
    await request(app.getHttpServer()).post('/h5login/api/auth/wechat-login').send({code:'x'.repeat(20000)}).expect(413);
  });
  await t.test('per-user rate limit stays atomic across tokens, sets Retry-After and expires', async () => {
    const a=await login('rate_player'); const b=await login('rate_player');
    const responses=await Promise.all(Array.from({length:65},(_,i)=>
      request(app.getHttpServer()).post(prefix+'get').set('Authorization','Bearer '+(i%2?a.accessToken:b.accessToken)).send({})));
    assert.equal(responses.filter(r=>r.status===200).length,60);
    assert.equal(responses.filter(r=>r.status===429).length,5);
    assert.ok(responses.filter(r=>r.status===429).every(r=>r.body.message==='DATA_RATE_LIMITED' && Number(r.headers['retry-after'])>=1));
    await call(two.accessToken,'get',{});
    const rateKey=`minigame:data-rate:${config.appId}:${a.user.id}`;
    assert.ok((await redis.ttl(rateKey))>0);
    await redis.expire(rateKey,1); await new Promise(resolve=>setTimeout(resolve,1100));
    await call(a.accessToken,'get',{});
  });
  await t.test('initial-save races and final integer version remain atomic without overflow', async () => {
    const player=await login('version_edge_player');
    const attempts=await Promise.all([1,2].map(i=>request(app.getHttpServer()).post(prefix+'save')
      .set('Authorization','Bearer '+player.accessToken).send({version:0,data:JSON.stringify({i})})));
    assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
    await pool.query('UPDATE game_saves SET version=2147483646 WHERE user_id=$1',[player.user.id]);
    assert.equal((await call(player.accessToken,'save',{version:2147483646,data:'{}'})).body.version,2147483647);
    await call(player.accessToken,'save',{version:2147483647,data:'{}'},400);
    await call(player.accessToken,'save',{version:2147483646,data:'{}'},409);
  });
  await t.test('authentication rejects missing, expired, malformed and cross-app sessions', async () => {
    await request(app.getHttpServer()).post(prefix+'get').send({}).expect(401);
    await call(randomBytes(32).toString('base64url'),'get',{},401);
    for (const token of ['bad','a'.repeat(43)+'x',' '.repeat(43)]) {
      await call(token,'get',{},401);
    }
    const digest=createHash('sha256').update(two.accessToken).digest('hex'); const key=`minigame:session:${digest}`;
    const original=(await redis.get(key))!;
    try {
      for (const value of ['broken',JSON.stringify({userId:one.user.id,appId:'wx1111111111111111'}),JSON.stringify({userId:'bad',appId:config.appId})]) {
        await redis.set(key,value,{EX:60}); assert.equal((await call(two.accessToken,'get',{},401)).body.message,'SESSION_INVALID');
      }
    } finally { await redis.set(key,original,{EX:60}); }
    const temporary=randomBytes(32).toString('base64url'); const tempDigest=createHash('sha256').update(temporary).digest('hex');
    await redis.set(`minigame:session:${tempDigest}`,original,{EX:1}); await new Promise(resolve=>setTimeout(resolve,1100));
    await call(temporary,'get',{},401);
  });
  await t.test('storage failures are sanitized and do not modify saved data', async () => {
    await pool.query('ALTER TABLE game_saves RENAME TO game_saves_unavailable');
    try {
      for (const [operation,payload] of [['get',{}],['save',{version:1,data:'{}'}]] as const) {
        const r=await call(two.accessToken,operation,payload,503);
        assert.equal(r.body.message,'DATA_STORAGE_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(r.body),/postgres|SELECT|INSERT|UPDATE|stack|game_saves/);
      }
    } finally { await pool.query('ALTER TABLE game_saves_unavailable RENAME TO game_saves'); }
    app.get(Infrastructure).redis.destroy();
    for (const [operation,payload] of [['get',{}],['save',{version:1,data:'{}'}]] as const) {
      assert.equal((await call(two.accessToken,operation,payload,503)).body.message,'DATA_STORAGE_UNAVAILABLE');
    }
    assert.equal((await pool.query('SELECT version FROM game_saves WHERE user_id=$1',[two.user.id])).rows[0].version,1);
  });
});
