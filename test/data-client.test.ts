import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const path = '/h5login/api/data/save';
const token = Buffer.alloc(32, 7).toString('base64url');
const salt = Buffer.from('minigame-data-v1');
const key = (direction: string) => Buffer.from(hkdfSync('sha256', Buffer.from(token, 'base64url'), salt, Buffer.from(direction), 32));
const aad = (direction: string, ts: number, nonce: string, requestNonce?: string) => Buffer.from(
  direction === 'request' ? ['minigame-data-v1', direction, 'POST', path, String(ts), nonce].join('\n') :
    ['minigame-data-v1', direction, 'POST', path, '200', requestNonce, String(ts), nonce].join('\n'));

test('client pure-JS request cipher interoperates with independent Node AES-GCM and HKDF', async () => {
  // @ts-expect-error Client source is JavaScript distributed independently of server TS.
  const { encodeRequest } = await import('../client/data-client.mjs');
  const nonce = new Uint8Array(12).fill(3);
  const ts = Date.now();
  const payload = { version: 0, data: '{ "emoji": "中文🚀", "big": 9007199254740993123 }\n' };
  const envelope = encodeRequest(token, path, payload, nonce, ts);
  assert.equal(envelope.v, 1);
  const decipher = createDecipheriv('aes-256-gcm', key('c2s'), nonce);
  decipher.setAAD(aad('request', ts, envelope.nonce));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const clear = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
  assert.deepEqual(JSON.parse(clear.toString()), payload);
  assert.ok(!JSON.stringify(envelope).includes('emoji'));
  assert.throws(() => encodeRequest(token, path, payload, new Uint8Array(11), ts));
});

test('client high-level wrapper uses WeChat CSPRNG, sends only encrypted data and decrypts get/save', async () => {
  // @ts-expect-error Client JavaScript is bundled separately.
  const { createDataClient } = await import('../client/data-client.mjs');
  let randomCounter = 0; const sentNonces: string[] = [];
  const wx = {
    getUserCryptoManager() { return { getRandomValues(options: any) {
      options.success({ randomValues: new Uint8Array(options.length).fill(++randomCounter).buffer });
    } }; },
    request(options: any) {
      assert.equal(options.header.Authorization, `Bearer ${token}`);
      assert.equal(options.method, 'POST');
      assert.ok(options.url.startsWith('https://'));
      assert.equal(options.data.data, undefined);
      sentNonces.push(options.data.nonce);
      const requestPath = new URL(options.url).pathname;
      const iv = randomBytes(12), nonce = iv.toString('base64url'), ts = Date.now();
      const cipher = createCipheriv('aes-256-gcm', key('s2c'), iv);
      cipher.setAAD(Buffer.from(['minigame-data-v1', 'response', 'POST', requestPath, '200', options.data.nonce, String(ts), nonce].join('\n')));
      const result = requestPath.endsWith('/get') ? { exists: false, version: 0, data: null, updatedAt: null } :
        { version: 1, updatedAt: '2026-10-16T00:00:00.000Z' };
      const bytes = Buffer.concat([cipher.update(JSON.stringify(result)), cipher.final()]);
      options.success({ statusCode: 200, data: { v: 1, ts, nonce, ciphertext: bytes.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') } });
    }
  };
  const client = createDataClient({ wx, accessToken: token });
  assert.deepEqual(await client.get(), { exists: false, version: 0, data: null, updatedAt: null });
  assert.equal((await client.save('{ "中文": "🚀" }', 0)).version, 1);
  assert.equal(new Set(sentNonces).size, 2);
  assert.throws(() => createDataClient({ wx, accessToken: token, baseUrl: 'http://unsafe.example' }));
  await assert.rejects(client.save('not-json', 0));
  await assert.rejects(client.save('{}', -1));
  await assert.rejects(client.save(JSON.stringify('中'.repeat(22000)), 0));
});

test('client fails closed without secure randomness and surfaces errors without automatic replay', async () => {
  // @ts-expect-error Client JavaScript is bundled separately.
  const { createDataClient } = await import('../client/data-client.mjs');
  let calls = 0;
  const insecure = createDataClient({ wx: { request() { calls++; } }, accessToken: token });
  await assert.rejects(insecure.get(), /SECURE_RANDOM_UNAVAILABLE/);
  assert.equal(calls, 0);
  const wx = {
    getRandomValues(options: any) { options.success({ randomValues: randomBytes(12).buffer.slice(0, 12) }); },
    request(options: any) { calls++; options.success({ statusCode: 409, data: { message: 'SAVE_VERSION_CONFLICT' }, header: {} }); }
  };
  const client = createDataClient({ wx, accessToken: token });
  await assert.rejects(client.save('{}', 0), (err: any) => err.statusCode === 409 && err.apiMessage === 'SAVE_VERSION_CONFLICT');
  assert.equal(calls, 1);
});

test('bundled CommonJS SDK works without Node globals, TextEncoder or WebCrypto', async () => {
  const bundle = await build({ entryPoints: ['client/data-client.mjs'], bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', write: false });
  const module = { exports: {} as any };
  const context: any = { module, exports: module.exports, TextEncoder: undefined, TextDecoder: undefined, Buffer: undefined, crypto: undefined, process: undefined };
  runInNewContext(bundle.outputFiles[0]!.text, context);
  assert.equal(typeof module.exports.createDataClient, 'function');
  const wx = {
    getRandomValues(options: any) {
      const bytes = new Uint8Array(12).fill(5);
      options.success({ randomValues: bytes.buffer });
    },
    request(options: any) {
      assert.equal(options.data.v, 1);
      const decipher = createDecipheriv('aes-256-gcm', key('c2s'), Buffer.from(options.data.nonce, 'base64url'));
      decipher.setAAD(aad('request', options.data.ts, options.data.nonce));
      decipher.setAuthTag(Buffer.from(options.data.tag, 'base64url'));
      const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(options.data.ciphertext, 'base64url')), decipher.final()]).toString());
      assert.equal(data.data, '{"中文":"🚀"}');
      options.success({ statusCode: 503, data: { message: 'DATA_STORAGE_UNAVAILABLE' } });
    }
  };
  const client = module.exports.createDataClient({ wx, accessToken: token });
  await assert.rejects(client.save('{"中文":"🚀"}', 0), (err: any) => err.statusCode === 503);
});

test('client decrypts Node response and rejects tampering, stale clocks and wrong request binding', async () => {
  // @ts-expect-error Client JavaScript is bundled separately.
  const { decodeResponse } = await import('../client/data-client.mjs');
  const requestNonce = Buffer.alloc(12, 2).toString('base64url');
  const iv = randomBytes(12); const nonce = iv.toString('base64url'); const ts = Date.now();
  const cipher = createCipheriv('aes-256-gcm', key('s2c'), iv);
  cipher.setAAD(aad('response', ts, nonce, requestNonce));
  const plaintext = { version: 1, updatedAt: '2026-10-16T00:00:00.000Z' };
  const bytes = Buffer.concat([cipher.update(JSON.stringify(plaintext)), cipher.final()]);
  const envelope = { v: 1, ts, nonce, ciphertext: bytes.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  assert.deepEqual(decodeResponse(token, path, envelope, requestNonce), plaintext);
  assert.throws(() => decodeResponse(token, path, { ...envelope, tag: Buffer.alloc(16).toString('base64url') }, requestNonce));
  assert.throws(() => decodeResponse(token, path, envelope, Buffer.alloc(12, 9).toString('base64url')));
  assert.throws(() => decodeResponse(token, path, { ...envelope, ts: ts - 121000 }, requestNonce));
  assert.throws(() => decodeResponse(token, path, { ...envelope, extra: 1 }, requestNonce));
});
