import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export interface Envelope { v: 1; ts: number; nonce: string; ciphertext: string; tag: string }
const protocol = 'minigame-data-v1';
const paths = ['/h5login/api/data/save', '/h5login/api/data/get'];
const invalid = () => new BadRequestException('INVALID_ENCRYPTED_PAYLOAD');
function decode(text: unknown, length?: number): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw invalid();
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text || (length !== undefined && bytes.length !== length)) throw invalid();
  return bytes;
}
function derive(token: string, direction: string): Buffer {
  return Buffer.from(hkdfSync('sha256', decode(token, 32), Buffer.from(protocol), Buffer.from(direction), 32));
}
export function openRequest(token: string, path: string, input: unknown, now = Date.now()): unknown {
  if (!paths.includes(path) || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'ciphertext,nonce,tag,ts,v') throw invalid();
  const e = input as Envelope;
  if (e.v !== 1 || !Number.isSafeInteger(e.ts) || typeof e.ciphertext !== 'string' || e.ciphertext.length > 262144) throw invalid();
  if (Math.abs(e.ts - now) > 120000) throw new BadRequestException('REQUEST_EXPIRED');
  const nonce = decode(e.nonce, 12), tag = decode(e.tag, 16), ciphertext = decode(e.ciphertext);
  const key = derive(token, 'c2s');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from([protocol, 'request', 'POST', path, String(e.ts), e.nonce].join('\n')));
    cipher.setAuthTag(tag);
    const bytes = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw invalid(); }
  finally { key.fill(0); }
}
export function sealResponse(token: string, path: string, requestNonce: string, payload: unknown): Envelope {
  if (!paths.includes(path)) throw invalid();
  decode(requestNonce, 12);
  const nonce = randomBytes(12), ts = Date.now(), nonceText = nonce.toString('base64url');
  const key = derive(token, 's2c');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from([protocol, 'response', 'POST', path, '200', requestNonce, String(ts), nonceText].join('\n')));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return { v: 1, ts, nonce: nonceText, ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  } finally { key.fill(0); }
}
