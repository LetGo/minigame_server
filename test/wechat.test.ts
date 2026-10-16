import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { WechatClient } from '../src/auth/wechat.client.js';

const credentials = { appId: 'wx0123456789abcdef', appSecret: 'test-only-secret' };

test('WeChat client exchanges code at the fixed official HTTPS endpoint and returns only openid', async () => {
  let calls = 0;
  const client = new WechatClient(credentials, async (input, options) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
    assert.equal(url.searchParams.get('js_code'), 'one-use-code');
    assert.equal(url.searchParams.get('appid'), credentials.appId);
    assert.equal(url.searchParams.get('secret'), credentials.appSecret);
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    return Response.json({ openid: 'test-openid', session_key: 'never-return-this' });
  });
  assert.deepEqual(await client.exchange('one-use-code'), { openid: 'test-openid' });
  assert.equal(calls, 1);
});

const cases = [
  { name: 'invalid/expired code', data: { errcode: 40029, errmsg: 'sensitive-upstream-message' }, status: 401 },
  { name: 'reused code', data: { errcode: 40163 }, status: 401 },
  { name: 'blocked code', data: { errcode: 40226 }, status: 403 },
  { name: 'WeChat throttling', data: { errcode: 45011 }, status: 503 },
  { name: 'credential configuration error', data: { errcode: 40013 }, status: 502 },
  { name: 'malformed payload', data: { openid: 12 }, status: 502 },
  { name: 'missing session key', data: { openid: 'test-openid' }, status: 502 },
  { name: 'null payload', data: null, status: 502 },
];
for (const item of cases) {
  test(`WeChat client safely maps ${item.name}`, async () => {
    const client = new WechatClient(credentials, async () => Response.json(item.data));
    await assert.rejects(client.exchange('code'), (error: unknown) => {
      assert.ok(error instanceof HttpException);
      assert.equal(error.getStatus(), item.status);
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /sensitive-upstream|test-only-secret/);
      return true;
    });
  });
}

test('WeChat client sanitizes HTTP, JSON, timeout and transport failures without retries', async () => {
  const fetchers = [
    async () => new Response('private upstream body', { status: 503 }),
    async () => new Response('not-json'),
    async () => { throw new Error('https://private?secret=test-only-secret'); },
    async () => { throw new DOMException('private timeout', 'TimeoutError'); },
  ];
  for (const fetcher of fetchers) {
    let calls = 0;
    const client = new WechatClient(credentials, async () => { calls++; return fetcher(); });
    await assert.rejects(client.exchange('code'), (error: unknown) => {
      assert.ok(error instanceof HttpException);
      assert.equal(error.getStatus(), 502);
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /private|test-only-secret/);
      return true;
    });
    assert.equal(calls, 1);
  }
});
