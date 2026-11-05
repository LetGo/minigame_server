import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/database/migrate.js';

// Only compose.test.yaml credentials and fixed disposable test ports are used.
export async function platformStorage() {
  const compose = await readFile('compose.test.yaml', 'utf8');
  const password = compose.match(/^\s+POSTGRES_PASSWORD: ([a-z_]+)$/m)?.[1];
  assert.ok(password && password !== '***');
  const ownerUrl = `postgresql://minigame_test:${password}@127.0.0.1:15439/minigame_test`;
  const owner = new Pool({ connectionString: ownerUrl }); owner.on('error', () => {});
  const suffix = randomBytes(6).toString('hex');
  const role = 'platform_role_' + suffix;
  const names: string[] = [];
  const redis = createClient({ url: 'redis://127.0.0.1:16389/15' }); redis.on('error', () => {});
  const configs: ReturnType<typeof loadConfig>[] = [];
  const pools: Pool[] = [];
  async function close() {
    for (const pool of pools) if (!pool.ended) await pool.end();
    if (redis.isOpen) {
      // Sessions are shared-prefix but values include the exact random AppIDs.
      for await (const batch of redis.scanIterator({ MATCH: 'minigame:*', COUNT: 100 })) {
        for (const key of batch) {
          if (configs.some(c => key.includes(c.appId))) { await redis.del(key); continue; }
          if (key.startsWith('minigame:session:')) {
            const value = await redis.get(key);
            if (value && configs.some(c => { try { return JSON.parse(value).appId === c.appId; } catch { return false; } })) await redis.del(key);
          }
        }
      }
      await redis.quit();
    }
    for (const name of names) {
      const deadline = Date.now() + 5000;
      while (Number((await owner.query('SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].n)) {
        assert.ok(Date.now() < deadline, 'scratch database connections must close'); await delay(20);
      }
      await owner.query(`DROP DATABASE ${name}`);
      assert.equal((await owner.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0);
    }
    await owner.query(`DROP ROLE IF EXISTS ${role}`);
    await owner.end();
  }
  try {
    await redis.connect();
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'platform-test-runtime-only'`);
    for (let i = 0; i < 2; i++) {
      const name = `platform_${suffix}_${i}`; await owner.query(`CREATE DATABASE ${name}`); names.push(name);
      const url = new URL(ownerUrl); url.pathname = '/' + name;
      const pool = new Pool({ connectionString: url.href }); pool.on('error', () => {}); pools.push(pool);
      await migrate(pool);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 15);
      await pool.query(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await pool.query(`GRANT SELECT, INSERT, UPDATE ON game_users, game_saves TO ${role}`);
      await pool.query(`GRANT SELECT, INSERT ON game_daily_logins TO ${role}`);
      await pool.query(`GRANT INSERT ON game_login_events TO ${role}`);
      await pool.query(`GRANT SELECT ON game_profiles TO ${role}`);
      url.username = role; url.password = 'platform-test-runtime-only';
      const runtime = new Pool({ connectionString: url.href }); runtime.on('error', () => {});
      try {
        const privileges = await runtime.query(`SELECT
          has_database_privilege(current_database(), 'CREATE') AS ddl,
          has_table_privilege('game_users', 'DELETE') AS destructive,
          has_table_privilege('game_users', 'SELECT, INSERT, UPDATE') AS users,
          has_table_privilege('game_saves', 'SELECT, INSERT, UPDATE') AS saves`);
        assert.deepEqual(privileges.rows[0], { ddl: false, destructive: false, users: true, saves: true });
      } finally { await runtime.end(); }
      configs.push(loadConfig({ WECHAT_APP_ID: 'wx'+randomBytes(8).toString('hex'), WECHAT_APP_SECRET: 'platform-test-secret',
        DATABASE_URL: url.href, REDIS_URL: 'redis://127.0.0.1:16389/15', LOGIN_RATE_LIMIT: '1000', TRUST_LOCAL_PROXY: 'true' }));
    }
    return { owner, pools, configs, redis, close, names };
  } catch (error) { await close(); throw error; }
}
