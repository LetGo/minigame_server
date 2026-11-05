import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { loadConfig, type AppConfig } from './config.js';

export interface PlatformConfig {
  host: '127.0.0.1';
  port: number;
  games: AppConfig[];
}

export const PLATFORM_APP_ID = /^wx[0-9a-f]{16}$/;
const MAX_PRIVATE_BYTES = 64 * 1024;

// Read from the validated descriptor, not a second pathname open. A realpath
// comparison rejects symlinks in parent components as well as the final file.
function privateText(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > MAX_PRIVATE_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_PRIVATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_PRIVATE_BYTES) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { closeSync(fd); }
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function normalizedHost(host: string): string {
  // WHATWG special-host parsing also canonicalizes numeric/short/hex IPv4,
  // unlike non-special postgres:/redis: URL parsing.
  const value = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, '');
  return value === 'localhost' || value === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(value)
    || value === '[::ffff:7f00:1]' || value === '[::ffff:127.0.0.1]' ? 'loopback' : value;
}

// Credentials do not partition storage. Query parameters are deliberately not
// allowed: pg accepts identity overrides such as ?host= and ?database= there.
function storageIdentity(raw: string, kind: 'pg' | 'redis'): string {
  const url = new URL(raw);
  if (!url.hostname || url.search || url.hash) throw new Error();
  const port = Number(url.port || (kind === 'pg' ? 5432 : 6379));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  let database = url.pathname.slice(1);
  if (kind === 'redis') {
    database = decodeURIComponent(database);
    if (!/^\d*$/.test(database) || !Number.isSafeInteger(Number(database))) throw new Error();
    database = String(Number(database || 0));
  } else {
    // Require an explicit canonical ASCII database name. pg decodes reserved
    // escapes differently and preprocesses noncanonical URLs before parsing;
    // absent paths also allow PGDATABASE/user fallback instead of this identity.
    if (raw !== url.href || /%(?![0-9a-f]{2})/i.test(raw) || !/^[A-Za-z0-9_]{1,63}$/.test(database)) throw new Error();
  }
  return JSON.stringify([normalizedHost(url.hostname), port, database]);
}

/** Fail closed with a fixed error: never propagate paths, env values or URLs. */
export function loadPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  try {
    // pg reads the real process environment, not this loader's env argument,
    // when a URL omits its port. Require PGPORT unset/empty for this entrypoint.
    if (process.env.PGPORT) throw new Error();
    const portText = env.MINIGAME_PORT ?? '18744';
    if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error();
    const registry: unknown = JSON.parse(privateText(env.MINIGAME_REGISTRY_FILE));
    if (!exactObject(registry, ['version', 'games']) || registry.version !== 1 || !Array.isArray(registry.games)
      || registry.games.length < 1 || registry.games.length > 32) throw new Error();
    const ids = new Set<string>(); const databases = new Set<string>(); const redisDbs = new Set<string>();
    const games = registry.games.map((entry: unknown): AppConfig => {
      if (!exactObject(entry, ['appId', 'envFile']) || typeof entry.appId !== 'string'
        || !PLATFORM_APP_ID.test(entry.appId) || ids.has(entry.appId)) throw new Error();
      const config = loadConfig({ ...parseEnv(privateText(entry.envFile)), HOST: '127.0.0.1', TRUST_LOCAL_PROXY: 'true' });
      if (config.appId !== entry.appId) throw new Error();
      const pg = storageIdentity(config.databaseUrl, 'pg'); const redis = storageIdentity(config.redisUrl, 'redis');
      if (databases.has(pg) || redisDbs.has(redis)) throw new Error();
      ids.add(config.appId); databases.add(pg); redisDbs.add(redis);
      return config;
    });
    return { host: '127.0.0.1', port: Number(portText), games };
  } catch { throw new Error('Invalid platform configuration'); }
}
