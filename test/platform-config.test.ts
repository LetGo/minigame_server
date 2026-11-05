import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, chmod, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { loadPlatformConfig } from '../src/platform-config.js';

// Resolve the parser from installed pg itself; parsing never opens a connection
// or consults process.env (unlike constructing pg ConnectionParameters).
const require = createRequire(import.meta.url);
const parsePgConnectionString = createRequire(require.resolve('pg'))('pg-connection-string').parse as
  (url: string) => { database: string | null; user: string };

const appId = 'wx0123456789abcdef';
const appB = 'wxfedcba9876543210';
const secret = 'PLATFORM_CONFIG_SECRET_SENTINEL';
const gameEnv = (id = appId, pg = 'postgresql://user:password@localhost/db_a', redis = 'redis://localhost/1') =>
  `WECHAT_APP_ID=${id}\nWECHAT_APP_SECRET='${secret}'\nDATABASE_URL=${pg}\nREDIS_URL=${redis}\nPORT=18743\n`;
async function fixture(run: (dir: string, envFile: string, registry: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'platform-config-'));
  const envFile = join(dir, 'game.env'); const registry = join(dir, 'registry.json');
  try {
    await writeFile(envFile, gameEnv(), { mode: 0o600 });
    await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId, envFile }] }), { mode: 0o600 });
    await run(dir, envFile, registry);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function rejects(registry: string, extra: NodeJS.ProcessEnv = {}) {
  assert.throws(() => loadPlatformConfig({ MINIGAME_REGISTRY_FILE: registry, ...extra }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Invalid platform configuration');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error.stack), /PLATFORM_CONFIG_SECRET_SENTINEL|postgresql:|password/);
    return true;
  });
}

test('platform loads private game dotenv using parseEnv, fixed loopback proxy and independent listener', async () => {
  await fixture(async (_dir, _env, registry) => {
    const config = loadPlatformConfig({ MINIGAME_REGISTRY_FILE: registry });
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 18744);
    assert.equal(config.games.length, 1); assert.equal(config.games[0]!.appId, appId);
    assert.equal(config.games[0]!.appSecret, secret);
    assert.equal(config.games[0]!.trustLocalProxy, true);
    assert.equal(loadPlatformConfig({ MINIGAME_REGISTRY_FILE: registry, MINIGAME_PORT: '18745' }).port, 18745);
  });
});

test('registry rejects schema changes, duplicate IDs, empty/excess entries and mismatched identity without secrets', async (t) => {
  for (const [label, transform] of [
    ['unknown root', (e: any) => ({ ...e, secret })],
    ['unknown entry', (e: any) => ({ ...e, games: [{ ...e.games[0], secret }] })],
    ['wrong version', (e: any) => ({ ...e, version: 2 })],
    ['empty', (e: any) => ({ ...e, games: [] })],
    ['duplicates', (e: any) => ({ ...e, games: [e.games[0], e.games[0]] })],
    ['too many', (e: any) => ({ ...e, games: Array(33).fill(e.games[0]) })],
    ['invalid ID', (e: any) => ({ ...e, games: [{ ...e.games[0], appId: 'wx0123456789abcdeF' }] })],
    ['mismatched ID', (e: any) => ({ ...e, games: [{ ...e.games[0], appId: appB }] })],
  ] as const) await t.test(label, () => fixture(async (_dir, envFile, registry) => {
    await writeFile(registry, JSON.stringify(transform({ version: 1, games: [{ appId, envFile }] })));
    rejects(registry);
  }));
});

test('private file validation rejects relative paths, symlinks, non-regular files, modes and oversized content', async (t) => {
  for (const target of ['registry', 'env'] as const) {
    for (const mutation of ['relative', 'symlink', 'parent-symlink', 'directory', 'public', 'executable', 'large'] as const) {
      await t.test(`${target} ${mutation}`, () => fixture(async (dir, envFile, registry) => {
        let path = target === 'registry' ? registry : envFile;
        if (mutation === 'relative') path = 'relative-private-file';
        if (mutation === 'symlink') { const link = join(dir, 'link'); await symlink(path, link); path = link; }
        if (mutation === 'parent-symlink') {
          const sub = join(dir, 'sub'); await mkdir(sub); const file = join(sub, 'file');
          await writeFile(file, target === 'registry' ? JSON.stringify({ version: 1, games: [{ appId, envFile }] }) : gameEnv(), { mode: 0o600 });
          const link = join(dir, 'linked-dir'); await symlink(sub, link); path = join(link, 'file');
        }
        if (mutation === 'directory') path = dir;
        if (mutation === 'public') await chmod(path, 0o644);
        if (mutation === 'executable') await chmod(path, 0o700);
        if (mutation === 'large') await writeFile(path, ' '.repeat(128 * 1024));
        if (target === 'env') await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId, envFile: path }] }));
        rejects(target === 'registry' ? path : registry);
      }));
    }
  }
});

test('invalid registry bytes and game config failures have one fixed sanitized error', async () => {
  await fixture(async (_dir, envFile, registry) => {
    for (const bytes of ['{'+secret, 'null', '[]']) { await writeFile(registry, bytes); rejects(registry); }
    await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId, envFile }] }));
    await writeFile(envFile, `WECHAT_APP_ID=${appId}\nWECHAT_APP_SECRET=${secret}\nDATABASE_URL=${secret}\n`);
    rejects(registry);
    rejects('/missing-'+secret);
    rejects('');
  });
});

test('port must be a decimal TCP port and never inherits the game PORT', async () => {
  await fixture(async (_dir, _env, registry) => {
    for (const port of ['0', '65536', '-1', '1.5', '', ' 18744', '18744x']) rejects(registry, { MINIGAME_PORT: port });
  });
});

test('storage identity rejects aliases, encoded PG database names and duplicate credentials', async (t) => {
  const pairs = [
    ['PG password', 'postgres://other:secret@LOCALHOST:5432/db_a', 'redis://localhost/2'],
    ['PG loopback alias', 'postgres://other:secret@127.0.0.1/db_a', 'redis://localhost/2'],
    ['PG encoded database', 'postgres://other:secret@[::1]:5432/db_%61', 'redis://localhost/2'],
    ['PG short IPv4', 'postgres://other:secret@127.1/db_a', 'redis://localhost/2'],
    ['PG numeric IPv4', 'postgres://other:secret@2130706433/db_a', 'redis://localhost/2'],
    ['PG hex IPv4', 'postgres://other:secret@0x7f000001/db_a', 'redis://localhost/2'],
    ['Redis password and zeros', 'postgres://user:secret@localhost/db_b', 'redis://:different@LOCALHOST:6379/01'],
    ['Redis loopback alias', 'postgres://user:secret@localhost/db_b', 'redis://[::1]/1'],
  ];
  for (const [label, pg, redis] of pairs) await t.test(label!, () => fixture(async (dir, envFile, registry) => {
    const envB = join(dir, 'b.env'); await writeFile(envB, gameEnv(appB, pg, redis), { mode: 0o600 });
    await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId, envFile }, { appId: appB, envFile: envB }] }));
    rejects(registry);
  }));
});

test('PGPORT fallback in installed pg cannot alias two accepted platform databases', async () => {
  const previous = process.env.PGPORT;
  process.env.PGPORT = '55432';
  try {
    const urls = ['postgresql://fixture:***@127.0.0.1/cat_sudoku', 'postgresql://fixture:***@127.0.0.1:55432/cat_sudoku'];
    // Construction only: use the same connectionString option as Infrastructure.
    const identities = urls.map(connectionString => {
      const client = new Client({ connectionString });
      return { host: client.host, port: client.port, database: client.database };
    });
    assert.deepEqual(identities, [
      { host: '127.0.0.1', port: 55432, database: 'cat_sudoku' },
      { host: '127.0.0.1', port: 55432, database: 'cat_sudoku' },
    ]);
    await fixture(async (dir, envFile, registry) => {
      await writeFile(envFile, gameEnv(appId, urls[0]));
      const envB = join(dir, 'b.env');
      await writeFile(envB, gameEnv(appB, urls[1], 'redis://localhost/2'), { mode: 0o600 });
      await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId, envFile }, { appId: appB, envFile: envB }] }));
      // The argument does NOT contain PGPORT; pg still reads the real process.
      rejects(registry);
      rejects(registry, { PGPORT: '' });
    });
  } finally {
    if (previous === undefined) delete process.env.PGPORT; else process.env.PGPORT = previous;
  }
});

test('PGPORT contract rejects every nonempty process value even with explicit URL ports', async () => {
  const previous = process.env.PGPORT;
  try {
    await fixture(async (_dir, envFile, registry) => {
      for (const port of ['55432', '5432', '0', ' ', secret]) {
        process.env.PGPORT = port;
        for (const url of ['postgresql://fixture:***@localhost/cat_sudoku', 'postgresql://fixture:***@localhost:5432/cat_sudoku']) {
          await writeFile(envFile, gameEnv(appId, url));
          rejects(registry, { PGPORT: '' });
        }
      }
    });
  } finally {
    if (previous === undefined) delete process.env.PGPORT; else process.env.PGPORT = previous;
  }
});

test('PGPORT unset or empty preserves canonical cat and explicit ports despite unused env argument values', async () => {
  const keys = ['PGPORT', 'PGHOST', 'PGDATABASE', 'PGUSER'] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.PGHOST = 'ambient.invalid';
    process.env.PGDATABASE = 'ambient_database';
    process.env.PGUSER = 'ambient_user';
    await fixture(async (_dir, envFile, registry) => {
      for (const ambient of [undefined, '']) {
        if (ambient === undefined) delete process.env.PGPORT; else process.env.PGPORT = ambient;
        for (const port of [undefined, 5432, 55432]) {
          const url = `postgresql://fixture:***@127.0.0.1${port === undefined ? '' : ':' + port}/cat_sudoku`;
          await writeFile(envFile, gameEnv(appId, url));
          const config = loadPlatformConfig({ MINIGAME_REGISTRY_FILE: registry, PGPORT: '55432' });
          assert.equal(config.games[0]!.databaseUrl, url);
          const client = new Client({ connectionString: config.games[0]!.databaseUrl });
          assert.equal(client.host, '127.0.0.1');
          assert.equal(client.database, 'cat_sudoku');
          assert.equal(client.user, 'fixture');
          assert.equal(client.port, port ?? 5432);
        }
      }
    });
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    });
  }
});

test('PG reserved-escape collision reported by installed driver parser is rejected', async () => {
  const urls = ['postgresql://fixture:***@localhost/db%3F', 'postgresql://fixture:***@localhost/db%253F'];
  assert.deepEqual(urls.map(url => parsePgConnectionString(url).database), ['db%3F', 'db%3F']);
  await fixture(async (dir, envFile, registry) => {
    await writeFile(envFile, gameEnv(appId, urls[0]));
    const envB = join(dir, 'b.env');
    await writeFile(envB, gameEnv(appB, urls[1], 'redis://localhost/2'), { mode: 0o600 });
    await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId, envFile }, { appId: appB, envFile: envB }] }));
    rejects(registry);
  });
});

test('PG database path must be explicit canonical safe ASCII, never a username fallback', async (t) => {
  for (const path of ['', '/', '/db%3F', '/db%253F', '/db_%61', '/db%2Fa', '/db%00', '/db%ZZ',
    '/db-name', '/db.name', '/db name', '/数据库', '/db/a', '//db', `/${'a'.repeat(64)}`]) {
    await t.test(`reject path ${JSON.stringify(path)}`, () => fixture(async (_dir, envFile, registry) => {
      const url = `postgresql://fixture:***@localhost${path}`;
      if (path === '' || path === '/') {
        // pg leaves database unset here; ConnectionParameters then uses PGDATABASE
        // before falling back to the user. The loader must never infer identity.
        const parsed = parsePgConnectionString(url);
        assert.equal(parsed.database, null);
        assert.equal(parsed.user, 'fixture');
      }
      await writeFile(envFile, gameEnv(appId, url));
      rejects(registry);
    }));
  }
  for (const username of ['', 'db%3F', 'db%253F']) {
    await t.test(`reject missing database for username ${JSON.stringify(username)}`, () => fixture(async (_dir, envFile, registry) => {
      const url = `postgresql://${username}:***@localhost/`;
      assert.equal(parsePgConnectionString(url).database, null);
      await writeFile(envFile, gameEnv(appId, url));
      rejects(registry);
    }));
  }
});

test('PG URL preprocessing cannot change a database after canonical path validation', async (t) => {
  for (const [label, url, database] of [
    ['space credential and tab path', 'postgresql://fixture:has space@localhost/db\ta', 'db\ta'],
    ['malformed escape and tab path', 'postgresql://fixture:bad%ZZ@localhost/db\ta', 'db\ta'],
    ['malformed escape and encoded dot segment', 'postgresql://fixture:bad%ZZ@localhost/db/%2e%2e/db_a', 'db/%2e%2e/db_a'],
  ]) {
    await t.test(label!, () => fixture(async (_dir, envFile, registry) => {
      assert.equal(parsePgConnectionString(url!).database, database);
      assert.match(new URL(url!).pathname, /^\/[A-Za-z0-9_]+$/);
      await writeFile(envFile, gameEnv(appId, url));
      rejects(registry);
    }));
  }
});

test('accepted PG database identities match installed driver parser regardless of credentials', async (t) => {
  for (const database of ['cat_sudoku', 'db_a', 'DB_A', 'db_0123', '_db', '0', '0123', 'a'.repeat(57)]) {
    await t.test(database, () => fixture(async (dir, envFile, registry) => {
      const first = `postgresql://fixture:***@localhost/${database}`;
      const second = `postgres://db%3F:***@localhost:5432/${database}`;
      assert.equal(parsePgConnectionString(first).database, database);
      assert.equal(parsePgConnectionString(second).database, database);
      await writeFile(envFile, gameEnv(appId, first));
      assert.equal(loadPlatformConfig({ MINIGAME_REGISTRY_FILE: registry }).games[0]!.databaseUrl, first);
      const envB = join(dir, 'b.env');
      await writeFile(envB, gameEnv(appB, second, 'redis://localhost/2'), { mode: 0o600 });
      await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId, envFile }, { appId: appB, envFile: envB }] }));
      rejects(registry);
      const distinct = `${database}_other`;
      const distinctUrl = `postgres://fixture:***@localhost/${distinct}`;
      assert.equal(parsePgConnectionString(distinctUrl).database, distinct);
      await writeFile(envB, gameEnv(appB, distinctUrl, 'redis://localhost/2'));
      assert.equal(loadPlatformConfig({ MINIGAME_REGISTRY_FILE: registry }).games.length, 2);
    }));
  }
});

test('distinct storage identities support multiple registered apps', async () => {
  await fixture(async (dir, envFile, registry) => {
    const envB = join(dir, 'b.env'); await writeFile(envB, gameEnv(appB, 'postgres://user:password@localhost/db_b', 'redis://localhost/2'), { mode: 0o600 });
    await writeFile(registry, JSON.stringify({ version: 1, games: [{ appId, envFile }, { appId: appB, envFile: envB }] }));
    assert.deepEqual(loadPlatformConfig({ MINIGAME_REGISTRY_FILE: registry }).games.map(g => g.appId), [appId, appB]);
  });
});
