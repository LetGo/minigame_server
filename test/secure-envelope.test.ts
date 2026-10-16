import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { openRequest, sealResponse } from '../src/data/secure-envelope.js';
// @ts-expect-error Independently implemented client crypto.
import { encodeRequest, decodeResponse } from '../client/data-client.mjs';
const token = randomBytes(32).toString('base64url');
const path = '/h5login/api/data/save';

test('server AEAD interoperates with independent client, rejects tampering/path swap and expired requests', () => {
  const payload = { version: 0, data: '{ "中文":"🚀", "n":9007199254740993123 }\n' };
  const envelope = encodeRequest(token, path, payload, randomBytes(12));
  assert.deepEqual(openRequest(token, path, envelope), payload);
  const response = sealResponse(token, path, envelope.nonce, { version: 1 });
  assert.deepEqual(decodeResponse(token, path, response, envelope.nonce), { version: 1 });
  assert.throws(() => openRequest(token, '/h5login/api/data/get', envelope), /INVALID_ENCRYPTED_PAYLOAD/);
  assert.throws(() => openRequest(token, path, { ...envelope, tag: randomBytes(16).toString('base64url') }), /INVALID_ENCRYPTED_PAYLOAD/);
  assert.throws(() => openRequest(token, path, { ...envelope, extra: true }), /INVALID_ENCRYPTED_PAYLOAD/);
  assert.throws(() => openRequest(token, path, encodeRequest(token, path, payload, randomBytes(12), Date.now()-121000)), /REQUEST_EXPIRED/);
  assert.throws(() => openRequest(token, path, { ...envelope, nonce: envelope.nonce+'=' }), /INVALID_ENCRYPTED_PAYLOAD/);
});
