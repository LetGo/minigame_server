import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertStaging } from '../ops/staging-admin.mjs';

const valid = {
  DATABASE_URL: 'postgresql://minigame_staging_app:fixture@127.0.0.1:15441/minigame_staging',
  REDIS_URL: 'redis://:fixture@127.0.0.1:16391/0', PORT: '18741', HOST: '127.0.0.1', TRUST_LOCAL_PROXY: 'true',
};
test('staging provisioning guard accepts only isolated staging endpoints', () => {
  assert.doesNotThrow(() => assertStaging(valid));
  for (const [field, value] of [
    ['DATABASE_URL', valid.DATABASE_URL.replace('15441', '15440')],
    ['DATABASE_URL', valid.DATABASE_URL.replace('minigame_staging', 'minigame_prod')],
    ['REDIS_URL', valid.REDIS_URL.replace('16391', '16390')],
    ['REDIS_URL', valid.REDIS_URL.replace('/0', '/15')],
    ['HOST', '0.0.0.0'], ['PORT', '18740'], ['TRUST_LOCAL_PROXY', 'false'],
  ]) assert.throws(() => assertStaging({ ...valid, [field]: value }), field);
});
test('staging Nginx separates prefix, disables mirror/logging and preserves body caps', () => {
  const nginx = readFileSync('ops/nginx-h5login-staging.conf', 'utf8');
  assert.match(nginx, /location \^~ \/h5login-test\/api\/data\//);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:18741\/h5login\/api\/data\//);
  assert.match(nginx, /client_max_body_size 256k/);
  assert.match(nginx, /client_max_body_size 16k/);
  assert.equal((nginx.match(/mirror off;/g) ?? []).length, 3);
  assert.equal((nginx.match(/access_log off;/g) ?? []).length, 3);
  assert.doesNotMatch(nginx, /18740|15440|16390/);
});
