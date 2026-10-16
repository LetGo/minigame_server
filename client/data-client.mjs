import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';

const PROTOCOL = 'minigame-data-v1';
const ROUTES = ['/h5login/api/data/save', '/h5login/api/data/get'];

// URI UTF-8 conversion avoids Buffer/TextEncoder dependencies in the WeChat runtime.
function utf8(text) {
  return Uint8Array.from(encodeURIComponent(text).match(/%[0-9A-F]{2}|[^%]/g) || [],
    c => c[0] === '%' ? parseInt(c.slice(1), 16) : c.charCodeAt(0));
}
function decode64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('INVALID_ENCODING');
  const bytes = base64urlnopad.decode(value);
  if (base64urlnopad.encode(bytes) !== value || (length !== undefined && bytes.length !== length)) {
    throw new Error('INVALID_ENCODING');
  }
  return bytes;
}
function derive(token, direction) {
  return hkdf(sha256, decode64(token, 32), utf8(PROTOCOL), utf8(direction), 32);
}
function validatePath(path) {
  if (!ROUTES.includes(path)) throw new Error('INVALID_DATA_PATH');
}

function fromUtf8(bytes) {
  return decodeURIComponent(Array.from(bytes, b => '%' + b.toString(16).padStart(2, '0')).join(''));
}

export function decodeResponse(token, path, envelope, requestNonce, now = Date.now()) {
  validatePath(path);
  decode64(requestNonce, 12);
  if (!envelope || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(',') !== 'ciphertext,nonce,tag,ts,v' || envelope.v !== 1 ||
      !Number.isSafeInteger(envelope.ts) || Math.abs(envelope.ts - now) > 120000 ||
      typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 262144) {
    throw new Error('INVALID_ENCRYPTED_RESPONSE');
  }
  const nonce = decode64(envelope.nonce, 12);
  const cipher = decode64(envelope.ciphertext);
  const tag = decode64(envelope.tag, 16);
  const bytes = new Uint8Array(cipher.length + tag.length);
  bytes.set(cipher); bytes.set(tag, cipher.length);
  const aad = utf8([PROTOCOL, 'response', 'POST', path, '200', requestNonce, String(envelope.ts), envelope.nonce].join('\n'));
  const key = derive(token, 's2c');
  try {
    return JSON.parse(fromUtf8(gcm(key, nonce, aad).decrypt(bytes)));
  } finally { key.fill(0); }
}

function secureNonce(wx) {
  return new Promise((resolve, reject) => {
    try {
      const manager = typeof wx.getUserCryptoManager === 'function' ? wx.getUserCryptoManager() : null;
      const provider = manager && typeof manager.getRandomValues === 'function' ? manager : wx;
      if (typeof provider.getRandomValues !== 'function') throw new Error('SECURE_RANDOM_UNAVAILABLE');
      provider.getRandomValues({ length: 12,
        success(result) {
          try {
            const bytes = new Uint8Array(result.randomValues);
            if (bytes.length !== 12) throw new Error('SECURE_RANDOM_UNAVAILABLE');
            resolve(bytes);
          } catch (err) { reject(err); }
        },
        fail() { reject(new Error('SECURE_RANDOM_UNAVAILABLE')); }
      });
    } catch (err) { reject(err); }
  });
}

export function createDataClient({ wx, accessToken, baseUrl = 'https://sub2api.wdaveh5game.com/h5login' }) {
  decode64(accessToken, 32);
  if (!wx || typeof wx.request !== 'function' ||
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?\/h5login$/i.test(baseUrl)) throw new Error('INVALID_CLIENT_OPTIONS');
  async function call(operation, payload) {
    const path = '/h5login/api/data/' + operation;
    const envelope = encodeRequest(accessToken, path, payload, await secureNonce(wx));
    return new Promise((resolve, reject) => {
      wx.request({
        url: baseUrl + '/api/data/' + operation,
        method: 'POST', header: { 'content-type': 'application/json', Authorization: 'Bearer ' + accessToken },
        data: envelope, timeout: 20000,
        success(res) {
          try {
            if (res.statusCode !== 200) {
              const err = new Error('DATA_REQUEST_FAILED');
              err.statusCode = res.statusCode;
              err.apiMessage = res.data && res.data.message;
              err.retryAfter = res.header && (res.header['Retry-After'] || res.header['retry-after']);
              throw err;
            }
            resolve(decodeResponse(accessToken, path, res.data, envelope.nonce));
          } catch (err) { reject(err); }
        },
        fail() { reject(new Error('DATA_NETWORK_ERROR')); }
      });
    });
  }
  return {
    get() { return call('get', {}); },
    async save(data, version) {
      if (typeof data !== 'string' || !Number.isInteger(version) || version < 0 || version > 2147483646 || utf8(data).length > 65536) {
        throw new Error('INVALID_SAVE_DATA');
      }
      try { JSON.parse(data); } catch { throw new Error('INVALID_SAVE_DATA'); }
      return call('save', { version, data });
    }
  };
}

export function encodeRequest(token, path, payload, nonce, ts = Date.now()) {
  validatePath(path);
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12 || !Number.isSafeInteger(ts)) {
    throw new Error('INVALID_REQUEST_CONTEXT');
  }
  const nonceText = base64urlnopad.encode(nonce);
  const aad = utf8([PROTOCOL, 'request', 'POST', path, String(ts), nonceText].join('\n'));
  const key = derive(token, 'c2s');
  try {
    const bytes = gcm(key, nonce, aad).encrypt(utf8(JSON.stringify(payload)));
    return { v: 1, ts, nonce: nonceText, ciphertext: base64urlnopad.encode(bytes.subarray(0, -16)),
      tag: base64urlnopad.encode(bytes.subarray(-16)) };
  } finally { key.fill(0); }
}
