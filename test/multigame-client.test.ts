import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
// @ts-expect-error JavaScript distributable source has no TypeScript declarations.
import { createDataClient } from '../client/data-client.mjs';

const token = Buffer.alloc(32, 7).toString('base64url');
const appId = 'wx0123456789abcdef';
const baseUrl = 'https://sub2api.wdaveh5game.com/minigame';
const empty = { exists: false, version: 0, data: null, updatedAt: null };
const saved = { version: 1, updatedAt: '2026-11-05T00:00:00.000Z' };
const mod = { exports: {} as any };
// Exercise the shipped artifact, not an in-memory substitute for build:client.
runInNewContext('Math.random = () => { throw new Error("CSPRNG/RANDOM_UNAVAILABLE"); };\n' +
  readFileSync(new URL('../client/minigame-data-client.js', import.meta.url), 'utf8'), {
  module: mod, exports: mod.exports,
  Buffer: undefined, process: undefined, require: undefined, URL: undefined,
  atob: undefined, btoa: undefined, TextEncoder: undefined, TextDecoder: undefined,
  crypto: undefined, wx: undefined
});

for (const [name, factory] of [['source', createDataClient], ['shipped bundle', mod.exports.createDataClient]] as const) {
  test(`${name}: minigame get/save use AppID header and unchanged Bearer/body contract without platform globals`, async () => {
    const sent: any[] = [];
    const wx = { request(options: any) {
      sent.push(JSON.parse(JSON.stringify({
        url: options.url, method: options.method, header: options.header,
        data: options.data, timeout: options.timeout
      })));
      options.success({ statusCode: 200, data: options.url.endsWith('/get') ? empty : saved });
    } };
    const store = factory({ wx, accessToken: token, baseUrl, appId });
    assert.equal((await store.get()).exists, false);
    assert.equal((await store.save('{ "中文":"🚀", "big":9007199254740993123 }', 0)).version, 1);
    const common = {
      method: 'POST', timeout: 20000,
      header: { 'content-type': 'application/json', Authorization: 'Bearer ' + token, 'X-Minigame-AppId': appId }
    };
    assert.deepEqual(sent, [
      { ...common, url: baseUrl + '/api/data/get', data: {} },
      { ...common, url: baseUrl + '/api/data/save', data: { version: 0, data: '{ "中文":"🚀", "big":9007199254740993123 }' } }
    ]);
  });

  test(`${name}: invalid or secret-bearing AppID fails locally without exposing options`, () => {
    let calls = 0;
    const wx = { request() { calls++; } };
    for (const invalid of [undefined, null, '', 123, {}, { appId, appSecret: 'private-secret-marker' },
      'wx0123456789abcde', 'wx0123456789abcdef0', 'wx0123456789abcdeg', 'WX0123456789abcdef',
      'wx0123456789ABCDEF', appId + '\n', appId + '\r\nX-Other: injected', appId + '?secret=private-secret-marker',
      appId + ':private-secret-marker', new String(appId)]) {
      assert.throws(() => factory({ wx, accessToken: token, baseUrl, appId: invalid }),
        (error: any) => error.message === 'INVALID_CLIENT_OPTIONS');
    }
    for (const extra of [{ appSecret: 'private-secret-marker' }, { secret: 'private-secret-marker' },
      { header: { 'X-Minigame-AppId': 'wx1111111111111111' } }]) {
      assert.throws(() => factory({ wx, accessToken: token, baseUrl, appId, ...extra }),
        (error: any) => error.message === 'INVALID_CLIENT_OPTIONS');
    }
    assert.equal(calls, 0);
  });

  test(`${name}: URL injection, unknown routes and case variants cannot bypass AppID validation`, () => {
    let calls = 0;
    const wx = { request() { calls++; } };
    for (const invalidUrl of [
      baseUrl + '/api', baseUrl + '/', baseUrl + '?appId=' + appId, baseUrl + '#secret', baseUrl + '\n',
      baseUrl + '/..', baseUrl + '/%2e%2e/h5login', baseUrl.replace('/minigame', '/MINIGAME'),
      baseUrl.replace('/minigame', '/other'), baseUrl.replace('/minigame', '/cat-sudoku'),
      baseUrl.replace('https:', 'http:'), baseUrl.replace('https:', 'javascript:'),
      baseUrl.replace('https://', 'https://user:private-secret-marker@'),
      baseUrl.replace('https://', 'https://safe.example@'),
      baseUrl.replace('.com/', '.com\\\\evil.example/'),
      'https://safe.example:0/minigame', 'https://safe.example:65536/minigame',
      'https://../minigame', 'https://-safe.example/minigame', 'https://safe..example/minigame'
    ]) {
      for (const options of [{ appId }, {}]) {
        assert.throws(() => factory({ wx, accessToken: token, baseUrl: invalidUrl, ...options }),
          (error: any) => error.message === 'INVALID_CLIENT_OPTIONS', invalidUrl);
      }
    }
    assert.throws(() => factory({ wx, accessToken: token + '\n', baseUrl, appId }), /INVALID_CLIENT_OPTIONS/);
    assert.equal(calls, 0);
    assert.doesNotThrow(() => factory({ wx, accessToken: token, baseUrl: 'https://Other.example:8443/minigame', appId }));
    for (const path of ['minigame', 'h5login', 'h5login-test']) {
      assert.doesNotThrow(() => factory({ wx, accessToken: token, baseUrl: 'https://xn--game.example:8443/' + path, appId }));
    }
  });

  test(`${name}: factory identity cannot be overridden or mutated per request`, async () => {
    const sent: any[] = [];
    const options = { wx: { request(o: any) {
      sent.push(JSON.parse(JSON.stringify({ header: o.header, data: o.data, url: o.url })));
      o.header['X-Minigame-AppId'] = 'wx2222222222222222';
      o.success({ statusCode: 200, data: o.url.endsWith('/get') ? empty : saved });
    } }, accessToken: token, baseUrl, appId };
    const store = factory(options);
    options.appId = 'wx3333333333333333';
    options.baseUrl = 'https://evil.example/minigame';
    const override = { appId: 'wx4444444444444444', header: { 'X-Minigame-AppId': 'wx5555555555555555' } };
    await store.get(override);
    await store.save('{}', 0, override);
    await store.get();
    assert.deepEqual(sent.map(o => o.header['X-Minigame-AppId']), [appId, appId, appId]);
    assert.deepEqual(sent.map(o => o.header.Authorization), Array(3).fill('Bearer ' + token));
    assert.deepEqual(sent.map(o => o.url), [baseUrl + '/api/data/get', baseUrl + '/api/data/save', baseUrl + '/api/data/get']);
    assert.deepEqual(sent.map(o => o.data), [{}, { version: 0, data: '{}' }, {}]);
  });

  test(`${name}: legacy default, h5login and h5login-test require no AppID and retain original headers`, async () => {
    for (const legacyUrl of [undefined, 'https://sub2api.wdaveh5game.com/h5login', 'https://sub2api.wdaveh5game.com/h5login-test']) {
      const sent: any[] = [];
      const store = factory({ wx: { request(o: any) {
        sent.push(JSON.parse(JSON.stringify({ url: o.url, header: o.header, data: o.data })));
        o.success({ statusCode: 200, data: o.url.endsWith('/get') ? empty : saved });
      } }, accessToken: token, ...(legacyUrl ? { baseUrl: legacyUrl } : {}) });
      await store.get();
      await store.save('{}', 0);
      const prefix = legacyUrl || 'https://sub2api.wdaveh5game.com/h5login';
      assert.deepEqual(sent, [
        { url: prefix + '/api/data/get', header: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, data: {} },
        { url: prefix + '/api/data/save', header: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, data: { version: 0, data: '{}' } }
      ]);
    }
  });
}
