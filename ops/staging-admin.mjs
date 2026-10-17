// Run from the repository root. Never prints secrets; only targets staging storage.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

export function readEnv(path) {
  assert.equal(statSync(path).mode & 0o777, 0o600, 'credential file must be mode 0600');
  return parseEnv(readFileSync(path, 'utf8'));
}
export function assertStaging(env) {
  const db = new URL(env.DATABASE_URL);
  const redis = new URL(env.REDIS_URL);
  assert.equal(db.hostname, '127.0.0.1');
  assert.equal(db.port, '15441');
  assert.equal(db.pathname, '/minigame_staging');
  assert.equal(db.username, 'minigame_staging_app');
  assert.equal(redis.hostname, '127.0.0.1');
  assert.equal(redis.port, '16391');
  assert.equal(redis.pathname, '/0');
  assert.equal(env.PORT, '18741');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.TRUST_LOCAL_PROXY, 'true');
}

async function main() {
  const action = process.argv[2];
  if (action === 'prepare') {
    assert(!existsSync('.env.staging') && !existsSync('.env.staging.infrastructure'), 'refuse to replace existing staging credentials');
    // Only these two WeChat values are reused; no production DB/Redis URL is copied.
    const prod = readEnv('.env');
    assert.match(prod.WECHAT_APP_ID, /^wx[a-f0-9]{16}$/);
    assert(prod.WECHAT_APP_SECRET && !/[\r\n]/.test(prod.WECHAT_APP_SECRET));
    const owner = randomBytes(32).toString('hex');
    const app = randomBytes(32).toString('hex');
    const redis = randomBytes(32).toString('hex');
    const infra = `POSTGRES_PASSWORD=${owner}\nSTAGING_APP_PASSWORD=${app}\nREDIS_PASSWORD=${redis}\n`;
    const runtime = Object.entries({
      NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '18741', TRUST_LOCAL_PROXY: 'true',
      WECHAT_APP_ID: prod.WECHAT_APP_ID, WECHAT_APP_SECRET: prod.WECHAT_APP_SECRET,
      DATABASE_URL: `postgresql://minigame_staging_app:${app}@127.0.0.1:15441/minigame_staging`,
      REDIS_URL: `redis://:${redis}@127.0.0.1:16391/0`, SESSION_TTL_SECONDS: '604800',
      LOGIN_RATE_LIMIT: '120', LOGIN_RATE_WINDOW_SECONDS: '60',
    }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
    writeFileSync('.env.staging.infrastructure', infra, { mode: 0o600, flag: 'wx' });
    writeFileSync('.env.staging', runtime, { mode: 0o600, flag: 'wx' });
    assertStaging(readEnv('.env.staging'));
    console.log('staging_credentials_prepared: true (0600; values not printed)');
    return;
  }
  assert.equal(action, 'migrate', 'usage: node ops/staging-admin.mjs prepare|migrate');
  const env = readEnv('.env.staging');
  const infra = readEnv('.env.staging.infrastructure');
  assertStaging(env);
  assert.match(infra.STAGING_APP_PASSWORD, /^[a-f0-9]{64}$/);
  const pool = new Pool({ host: '127.0.0.1', port: 15441, database: 'minigame_staging',
    user: 'minigame_staging_owner', password: infra.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 3000, statement_timeout: 15000 });
  try {
    const { migrate } = await import(pathToFileURL(resolve('runtime/staging/current/dist/database/migrate.js')).href);
    await migrate(pool, resolve('runtime/staging/current/migrations'));
    const role = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='minigame_staging_app'");
    if (!role.rowCount) {
      await pool.query(`CREATE ROLE minigame_staging_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${infra.STAGING_APP_PASSWORD}'`);
    }
    await pool.query('REVOKE ALL ON DATABASE minigame_staging FROM PUBLIC');
    await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await pool.query('GRANT CONNECT ON DATABASE minigame_staging TO minigame_staging_app');
    await pool.query('GRANT USAGE ON SCHEMA public TO minigame_staging_app');
    await pool.query('GRANT SELECT, INSERT, UPDATE ON game_users, game_saves, game_profiles, game_invitations TO minigame_staging_app');
    const migrations = await pool.query('SELECT name FROM schema_migrations ORDER BY name');
    console.log(JSON.stringify({ staging_migrations: migrations.rows.map(row => row.name) }));
  } finally { await pool.end(); }
  const app = new Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    const result = await app.query(`SELECT current_user AS role, current_database() AS database,
      has_table_privilege(current_user,'game_invitations','UPDATE') AS can_update,
      has_table_privilege(current_user,'game_invitations','DELETE') AS can_delete,
      has_schema_privilege(current_user,'public','CREATE') AS can_ddl`);
    assert.equal(result.rows[0].can_update, true);
    assert.equal(result.rows[0].can_delete, false);
    assert.equal(result.rows[0].can_ddl, false);
    console.log(JSON.stringify(result.rows[0]));
  } finally { await app.end(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('Staging provisioning failed; secrets suppressed. Inspect staging-only configuration locally.'); process.exitCode = 1; });
}
