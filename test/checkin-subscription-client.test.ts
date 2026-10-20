import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const templateId = '2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4';
const baseUrl = 'https://sub2api.wdaveh5game.com/h5login-test';
const token = Buffer.alloc(32, 7).toString('base64url');
const eventId = '9b9f8d21-1c00-4f11-8a02-123456789abc';
const receipt = (status = 'accept', alreadyRecorded = false) => ({
  eventId, templateId, status, recordedAt: '2026-10-20T01:00:00.000Z', alreadyRecorded,
});

async function factory() {
  // Keep the initial missing-feature RED an assertion, rather than an import crash.
  const module = await import('../client/checkin-subscription-client.mjs' as string).catch((error: any) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.createCheckinSubscriptionClient, 'function');
  return module.createCheckinSubscriptionClient;
}

test('click invokes exact WeChat template synchronously before any network and reports accept with original UUID', async () => {
  const create = await factory();
  const order: string[] = [];
  let callback: any;
  const wx = {
    requestSubscribeMessage(options: any) {
      order.push('prompt');
      assert.deepEqual(options.tmplIds, [templateId]);
      callback = options;
      return { notAPromise: true };
    },
    request(options: any) {
      order.push('report');
      assert.equal(options.url, baseUrl + '/api/subscriptions/checkin/report');
      assert.equal(options.method, 'POST');
      assert.equal(options.header.Authorization, 'Bearer ' + token);
      assert.equal(options.header['content-type'], 'application/json');
      assert.deepEqual(options.data, { eventId, templateId, status: 'accept' });
      options.success({ statusCode: 200, data: receipt() });
      return { notAPromise: true };
    },
    getSetting() { assert.fail('settings must never stand in for a new subscription'); },
  };
  const client = create({ wx, accessToken: token });
  const result = client.requestSubscription(eventId);
  assert.deepEqual(order, ['prompt']);
  callback.success({ errMsg: 'requestSubscribeMessage:ok', [templateId]: 'accept' });
  assert.deepEqual(await result, receipt());
  assert.deepEqual(order, ['prompt', 'report']);
});


test('validates canonical opaque Bearer, HTTPS staging-only base and rejects identity/config overrides before side effects', async () => {
  const create = await factory();
  const wx = { request() { assert.fail('no network'); }, requestSubscribeMessage() { assert.fail('no prompt'); } };
  for (const accessToken of [undefined, '', 'Bearer ' + token, token + ' ', 'x'.repeat(42) + 'B', 'x'.repeat(44), 'a\n'.repeat(22)]) {
    assert.throws(() => create({ wx, accessToken }), /INVALID_CLIENT_OPTIONS/);
  }
  for (const baseUrl of ['http://example.com/h5login-test', 'https://example.com/h5login',
    'https://example.com/h5login-test/', 'https://example.com/h5login-test/api',
    'https://u:p@example.com/h5login-test', 'https://example.com/h5login-test?x=1',
    'https://example.com/h5login-test#x', 'https://example.com/h5login-test/../h5login']) {
    assert.throws(() => create({ wx, accessToken: token, baseUrl }), /INVALID_CLIENT_OPTIONS/);
  }
  for (const override of [{ userId: eventId }, { uid: eventId }, { openid: 'other' }, { templateId: 'other' }]) {
    assert.throws(() => create({ wx, accessToken: token, ...override }), /INVALID_CLIENT_OPTIONS/);
  }
  assert.throws(() => create({ wx: {}, accessToken: token }), /INVALID_CLIENT_OPTIONS/);
  assert.throws(() => create(null), /INVALID_CLIENT_OPTIONS/);
  assert.doesNotThrow(() => create({ wx, accessToken: token, baseUrl: 'https://other.example:8443/h5login-test' }));
});

test('caller supplies canonical UUID; report accepts only eventId/status and cannot override identity or template', async () => {
  const create = await factory();
  let calls = 0;
  const wx = { request() { calls++; throw new Error('UNEXPECTED_NETWORK'); }, requestSubscribeMessage() { calls++; throw new Error('UNEXPECTED_PROMPT'); } };
  const client = create({ wx, accessToken: token });
  for (const badId of [undefined, '', 'not-uuid', ' ' + eventId, eventId.toUpperCase(), '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(client.requestSubscription(badId), /INVALID_EVENT_ID/);
    await assert.rejects(client.reportResult({ eventId: badId, status: 'accept' }), /INVALID_REPORT/);
  }
  for (const input of [null, [], {}, { eventId, status: 'cancel' }, { eventId, status: 'ACCEPT' },
    { eventId, status: 'accept', userId: eventId }, { eventId, status: 'accept', openid: 'x' },
    { eventId, status: 'accept', templateId }, { eventId, status: 'accept', uid: eventId }]) {
    await assert.rejects(client.reportResult(input), /INVALID_REPORT/);
  }
  assert.equal(calls, 0);
});

for (const status of ['reject', 'ban', 'filter']) {
  test('reports explicit WeChat ' + status + ' observation without inventing accept', async () => {
    const create = await factory();
    let reports = 0;
    const client = create({ accessToken: token, wx: {
      requestSubscribeMessage(o: any) { o.success({ errMsg: 'requestSubscribeMessage:ok', [templateId]: status }); },
      request(o: any) { reports++; assert.equal(o.data.status, status); o.success({ statusCode: 200, data: receipt(status) }); },
    } });
    assert.deepEqual(await client.requestSubscription(eventId), receipt(status));
    assert.equal(reports, 1);
  });
}

test('missing API is explicit; invalid callbacks, cancellation and thrown SDK details never report or leak', async () => {
  const create = await factory();
  const sensitive = 'private token and openid';
  const neverRequest = () => assert.fail('no report for a failed or invalid prompt');
  const missing = create({ accessToken: token, wx: { request: neverRequest } });
  await assert.rejects(missing.requestSubscription(eventId), /SUBSCRIPTION_API_UNAVAILABLE/);
  for (const response of [undefined, null, {}, { otherTemplate: 'accept' }, { [templateId]: 'cancel' },
    { [templateId]: 'ACCEPT' }, { [templateId]: 'accept', errMsg: 'requestSubscribeMessage:fail' }]) {
    const client = create({ accessToken: token, wx: {
      request: neverRequest, requestSubscribeMessage(o: any) { o.success(response); },
    } });
    await assert.rejects(client.requestSubscription(eventId), (e: any) =>
      e.message === 'INVALID_SUBSCRIPTION_CALLBACK' && !e.pendingReport);
  }
  for (const action of ['cancel', 'throw']) {
    const client = create({ accessToken: token, wx: {
      request: neverRequest,
      requestSubscribeMessage(o: any) {
        if (action === 'throw') throw new Error(sensitive);
        o.fail({ errMsg: 'requestSubscribeMessage:fail cancel ' + sensitive });
      },
    } });
    await assert.rejects(client.requestSubscription(eventId), (e: any) =>
      e.message === 'SUBSCRIPTION_REQUEST_FAILED' && !e.pendingReport && !JSON.stringify(e).includes(sensitive));
  }
});

test('one prompt callback is handled at most once, even if SDK repeats or contradicts callbacks', async () => {
  const create = await factory();
  let reports = 0;
  const client = create({ accessToken: token, wx: {
    requestSubscribeMessage(o: any) {
      o.success({ errMsg: 'requestSubscribeMessage:ok', [templateId]: 'accept' });
      o.success({ errMsg: 'requestSubscribeMessage:ok', [templateId]: 'reject' });
      o.fail({ errMsg: 'late cancel' });
    },
    request(o: any) { reports++; o.success({ statusCode: 200, data: receipt() }); },
  } });
  assert.deepEqual(await client.requestSubscription(eventId), receipt());
  assert.equal(reports, 1);
});

for (const failure of ['network', 'http', 'throw', 'malformed']) {
  test('report ' + failure + ' failure preserves safe original event for explicit retry without reprompt', async () => {
    const create = await factory();
    let prompts = 0;
    let attempts = 0;
    const client = create({ accessToken: token, wx: {
      requestSubscribeMessage(o: any) { prompts++; o.success({ errMsg: 'requestSubscribeMessage:ok', [templateId]: 'accept' }); },
      request(o: any) {
        attempts++;
        assert.deepEqual(o.data, { eventId, templateId, status: 'accept' });
        if (attempts > 1) { o.success({ statusCode: 200, data: receipt('accept', true) }); return; }
        if (failure === 'network') o.fail({ errMsg: 'SECRET token/openid' });
        if (failure === 'throw') throw new Error('SECRET token/openid');
        if (failure === 'http') o.success({ statusCode: 502, data: 'SECRET token/openid', header: {} });
        if (failure === 'malformed') o.success({ statusCode: 200, data: { ...receipt(), eventId: 'other-user-id' } });
      },
    } });
    let pending: any;
    await assert.rejects(client.requestSubscription(eventId), (e: any) => {
      assert.deepEqual(e.pendingReport, { eventId, status: 'accept' });
      assert.equal(JSON.stringify(e).includes('SECRET'), false);
      assert.equal(e.message.includes('SECRET'), false);
      assert.equal(e.cause, undefined);
      pending = e.pendingReport;
      return true;
    });
    assert.equal(attempts, 1, 'no automatic retry');
    assert.deepEqual(await client.reportResult(pending), receipt('accept', true));
    assert.equal(prompts, 1, 'retry must not request another subscription');
    assert.equal(attempts, 2);
  });
}

test('report validates exact receipt bindings/status, timestamp/boolean and sanitizes response body', async () => {
  const create = await factory();
  for (const response of [null, [], 'html', { ...receipt(), templateId: 'other' }, { ...receipt(), status: 'reject' },
    { ...receipt(), recordedAt: null }, { ...receipt(), recordedAt: 'garbage' },
    { ...receipt(), alreadyRecorded: 'true' }, { ...receipt(), openid: 'SECRET' }]) {
    const client = create({ accessToken: token, wx: { request(o: any) { o.success({ statusCode: 200, data: response }); } } });
    await assert.rejects(client.reportResult({ eventId, status: 'accept' }), (e: any) =>
      e.message === 'INVALID_SUBSCRIPTION_RESPONSE' && e.pendingReport.eventId === eventId);
  }
});

test('source runs with no Node/crypto/encoding/storage globals and waits for actual wx.request callback', async () => {
  const source = readFileSync(new URL('../client/checkin-subscription-client.mjs', import.meta.url), 'utf8');
  const create = runInNewContext(source.replace('export function ', 'function ') + '\ncreateCheckinSubscriptionClient;', {
    Buffer: undefined, process: undefined, crypto: undefined, require: undefined,
    TextEncoder: undefined, TextDecoder: undefined, atob: undefined, localStorage: undefined,
  });
  let networkCallback: any;
  let settled = false;
  const client = create({ accessToken: token, wx: {
    requestSubscribeMessage(o: any) { o.success({ errMsg: 'requestSubscribeMessage:ok', [templateId]: 'reject' }); },
    request(o: any) { networkCallback = o; return { requestTaskOnly: true }; },
    setStorageSync() { assert.fail('must not persist credentials'); },
    getStorageSync() { assert.fail('must not read credentials from storage'); },
    getSetting() { assert.fail('must not infer new accept from settings'); },
  } });
  const operation = client.requestSubscription(eventId).then((value: any) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  networkCallback.success({ statusCode: 200, data: receipt('reject') });
  assert.deepEqual(await operation, receipt('reject'));
  assert.deepEqual(Object.keys(client).sort(), ['reportResult', 'requestSubscription']);
});
