import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

const valid = {
  WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_APP_SECRET: 'test-only-secret',
  DATABASE_URL: 'postgresql://user:pass@127.0.0.1/test',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
};

test('configuration rejects missing secrets and unsafe configuration without exposing values', () => {
  const config = loadConfig(valid);
  assert.equal(config.port, 18740);
  assert.equal(config.sessionTtlSeconds, 604800);
  assert.equal(config.host, '127.0.0.1');
  assert.throws(() => loadConfig({ ...valid, WECHAT_APP_SECRET: '' }), /WECHAT_APP_SECRET/);
  assert.throws(() => loadConfig({ ...valid, PORT: '0' }), /PORT/);
  assert.throws(() => loadConfig({ ...valid, REDIS_URL: 'https://sensitive-value' }), /REDIS_URL/);
  assert.throws(() => loadConfig({ ...valid, TRUST_LOCAL_PROXY: 'true', HOST: '0.0.0.0' }), /loopback/);
});
