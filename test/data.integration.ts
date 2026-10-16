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
// @ts-expect-error Independent client-side implementation.
import { encodeRequest, decodeResponse } from '../client/data-client.mjs';

const config = loadConfig({ WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_APP_SECRET: 'integration-test-only',
  DATABASE_URL: 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test', REDIS_URL: 'redis://127.0.0.1:16389/15' });
const prefix = '/h5login/api/data/';

test('encrypted saves with real isolated PostgreSQL/Redis and independent client crypto', async t => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const redis = createClient({ url: config.redisUrl }); redis.on('error', () => {}); await redis.connect();
  t.after(async () => { await redis.quit(); await pool.end(); });
  await migrate(pool); await pool.query('TRUNCATE game_users CASCADE'); await redis.flushDb();
  const wechat = new WechatClient(config, async input => Response.json({ openid: new URL(String(input)).searchParams.get('js_code'), session_key: 'stubbed-key' }));
  const app = await createApplication(config, { wechat }); await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  async function login(code: string) { return (await request(app.getHttpServer()).post('/h5login/api/auth/wechat-login').send({ code }).expect(200)).body; }
  const one = await login('player_one'); const two = await login('player_two');
  async function call(token: string, operation: string, payload: unknown, status = 200) {
    const path = prefix + operation;
    const envelope = encodeRequest(token, path, payload, randomBytes(12));
    const r = await request(app.getHttpServer()).post(path).set('Authorization', 'Bearer '+token).send(envelope).expect(status);
    assert.equal(r.headers['cache-control'], 'no-store');
    return { raw: r, envelope, body: status === 200 ? decodeResponse(token, path, r.body, envelope.nonce) : r.body };
  }
  await t.test('authenticated encrypted get returns empty version zero without leaking plaintext', async () => {
    const r = await call(one.accessToken, 'get', {});
    assert.deepEqual(r.body, { exists: false, version: 0, data: null, updatedAt: null });
    assert.equal(r.raw.body.exists, undefined);
  });
  await t.test('save preserves original JSON bytes and large numbers, then get isolates users', async () => {
    const text = '{ "big": 9007199254740993123, "text":"'+'中🚀'.repeat(1400)+'" }\n';
    const saved = await call(one.accessToken, 'save', { version: 0, data: text });
    assert.equal(saved.body.version, 1);
    assert.match(saved.body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    const loaded = await call(one.accessToken, 'get', {});
    assert.equal(loaded.body.data, text); assert.equal(loaded.body.version, 1);
    assert.equal((await pool.query('SELECT data FROM game_saves WHERE user_id=$1', [one.user.id])).rows[0].data, text);
    assert.equal((await call(two.accessToken, 'get', {})).body.exists, false);
  });
  await t.test('atomic versions allow one concurrent writer and reject stale or missing versions', async () => {
    const attempts = await Promise.all(['first','second'].map(data => {
      const path = prefix+'save';
      return request(app.getHttpServer()).post(path).set('Authorization', 'Bearer '+one.accessToken)
        .send(encodeRequest(one.accessToken, path, { version: 1, data: JSON.stringify({ data }) }, randomBytes(12)));
    }));
    assert.deepEqual(attempts.map(r => r.status).sort(), [200,409]);
    assert.equal(attempts.find(r=>r.status===409)!.body.message, 'SAVE_VERSION_CONFLICT');
    assert.equal((await call(one.accessToken, 'get', {})).body.version, 2);
    assert.equal((await call(one.accessToken, 'save', {version:0,data:'{}'},409)).body.message,'SAVE_VERSION_CONFLICT');
    assert.equal((await call(two.accessToken, 'save', {version:1,data:'{}'},409)).body.message,'SAVE_VERSION_CONFLICT');
  });
  await t.test('replay protection is atomic and invalid GCM tags cannot burn a legitimate nonce', async () => {
    const path = prefix+'get';
    const envelope = encodeRequest(one.accessToken, path, {}, randomBytes(12));
    const send = (body: object) => request(app.getHttpServer()).post(path).set('Authorization','Bearer '+one.accessToken).send(body);
    await send({ ...envelope, tag: randomBytes(16).toString('base64url') }).expect(400);
    const responses = await Promise.all([send(envelope), send(envelope)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200,409]);
    assert.equal(responses.find(r => r.status===409)!.body.message, 'REQUEST_REPLAYED');
    const digest=createHash('sha256').update(one.accessToken).digest('hex');
    const ttl=await redis.ttl(`minigame:data-nonce:${digest}:${envelope.nonce}`);
    assert.ok(ttl >= 295 && ttl <= 300);
  });
  await t.test('decrypted schemas reject invalid JSON/version, identity injection and query parameters', async () => {
    for (const payload of [{version:2,data:'not-json'}, {version:2,data:'"'+String.fromCharCode(0xd800)+'"'}, {version:-1,data:'{}'}, {version:'2',data:'{}'}, {version:2147483647,data:'{}'}, {version:2,data:'{}',userId:two.user.id}, null, []]) {
      assert.equal((await call(one.accessToken,'save',payload,400)).body.message,'INVALID_SAVE_DATA');
    }
    await call(one.accessToken,'get',{userId:two.user.id},400);
    const path=prefix+'get';
    await request(app.getHttpServer()).post(path+'?userId='+two.user.id).set('Authorization','Bearer '+one.accessToken)
      .send(encodeRequest(one.accessToken,path,{},randomBytes(12))).expect(400);
  });
  await t.test('64KiB original files including worst-case escaping round trip, larger UTF8 files fail', async () => {
    const text = '{'+'\t'.repeat(65534)+'}';
    assert.equal(Buffer.byteLength(text),65536);
    const saved = await call(two.accessToken,'save',{version:0,data:text}); assert.equal(saved.body.version,1);
    assert.equal((await call(two.accessToken,'get',{})).body.data,text);
    for (const data of ['{'+'\t'.repeat(65535)+'}', JSON.stringify('中'.repeat(21845))]) {
      assert.equal((await call(two.accessToken,'save',{version:1,data},400)).body.message,'INVALID_SAVE_DATA');
    }
    await request(app.getHttpServer()).post(prefix+'save').set('Authorization','Bearer '+two.accessToken).send({ciphertext:'x'.repeat(270000)}).expect(413);
    await request(app.getHttpServer()).post('/h5login/api/auth/wechat-login').send({code:'x'.repeat(20000)}).expect(413);
  });
  await t.test('per-user rate limit is atomic across tokens, sets Retry-After and expires', async () => {
    const a=await login('rate_player'); const b=await login('rate_player'); const path=prefix+'get';
    const responses=await Promise.all(Array.from({length:65},(_,i)=> {
      const token=i%2?a.accessToken:b.accessToken;
      return request(app.getHttpServer()).post(path).set('Authorization','Bearer '+token).send(encodeRequest(token,path,{},randomBytes(12)));
    }));
    assert.equal(responses.filter(r=>r.status===200).length,60);
    assert.equal(responses.filter(r=>r.status===429).length,5);
    assert.ok(responses.filter(r=>r.status===429).every(r=>r.body.message==='DATA_RATE_LIMITED' && Number(r.headers['retry-after'])>=1));
    const rateKey=`minigame:data-rate:${config.appId}:${a.user.id}`;
    assert.ok((await redis.ttl(rateKey))>0);
    await redis.expire(rateKey,1); await new Promise(resolve=>setTimeout(resolve,1100));
    await call(a.accessToken,'get',{});
  });
  await t.test('initial-save races and final integer version remain atomic without overflow', async () => {
    const player=await login('version_edge_player'); const path=prefix+'save';
    const attempts=await Promise.all([1,2].map(i=>request(app.getHttpServer()).post(path).set('Authorization','Bearer '+player.accessToken)
      .send(encodeRequest(player.accessToken,path,{version:0,data:JSON.stringify({i})},randomBytes(12)))));
    assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
    await pool.query('UPDATE game_saves SET version=2147483646 WHERE user_id=$1',[player.user.id]);
    assert.equal((await call(player.accessToken,'save',{version:2147483646,data:'{}'})).body.version,2147483647);
    await call(player.accessToken,'save',{version:2147483647,data:'{}'},400);
    await call(player.accessToken,'save',{version:2147483646,data:'{}'},409);
  });
  await t.test('authentication rejects missing, expired, malformed and cross-app sessions plus plaintext/path swapping', async () => {
    const path=prefix+'get';
    await request(app.getHttpServer()).post(path).send({}).expect(401);
    await call(randomBytes(32).toString('base64url'),'get',{},401);
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
    await request(app.getHttpServer()).post(path).set('Authorization','Bearer '+two.accessToken).send({version:0,data:'{}'}).expect(400);
    await request(app.getHttpServer()).post(path).set('Authorization','Bearer '+two.accessToken)
      .send(encodeRequest(two.accessToken,prefix+'save',{version:1,data:'{}'},randomBytes(12))).expect(400);
  });
  await t.test('failed save attempts also consume replay nonce, and storage failures are sanitized', async () => {
    const path=prefix+'save'; const envelope=encodeRequest(two.accessToken,path,{version:0,data:'{}'},randomBytes(12));
    const send=()=>request(app.getHttpServer()).post(path).set('Authorization','Bearer '+two.accessToken).send(envelope);
    assert.equal((await send().expect(409)).body.message,'SAVE_VERSION_CONFLICT');
    assert.equal((await send().expect(409)).body.message,'REQUEST_REPLAYED');
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
