import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../src/database/migrate.js';

test('referral migration upgrades preexisting users as old and is repeatable without modifying earlier migrations', async () => {
  // Disposable database on the fixed isolated test PostgreSQL, never the production port.
  const adminUrl = 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
  const admin = new Pool({ connectionString: adminUrl });
  const name = 'invite_upgrade_' + randomBytes(6).toString('hex');
  const previous = await mkdtemp(join(tmpdir(), 'minigame-pre-referral-'));
  let target: Pool | undefined;
  let created = false;
  try {
    for (const filename of ['001_users.sql', '002_game_saves.sql']) {
      await copyFile(join('migrations', filename), join(previous, filename));
    }
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const url = new URL(adminUrl);
    url.pathname = '/' + name;
    target = new Pool({ connectionString: url.toString() });
    await migrate(target, previous);
    const old = await target.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id', ['wx1111111111111111', 'existing_player']);
    const originalSave = '{ "legacy":9007199254740993123 }\n';
    await target.query('INSERT INTO game_saves(user_id,data,version) VALUES($1,$2,7)', [old.rows[0].id, originalSave]);
    const before = await target.query('SELECT name, checksum FROM schema_migrations ORDER BY name');

    await migrate(target);
    await migrate(target);
    const columns = await target.query("SELECT column_name FROM information_schema.columns WHERE table_name='game_users' AND column_name='first_login_completed'");
    assert.equal(columns.rowCount, 1, 'new-user marker must be installed by the new migration');
    const upgraded = await target.query('SELECT first_login_completed FROM game_users WHERE id=$1', [old.rows[0].id]);
    assert.equal(upgraded.rows[0].first_login_completed, true, 'existing player must never receive fresh registration eligibility');
    const save = await target.query('SELECT data,version FROM game_saves WHERE user_id=$1', [old.rows[0].id]);
    assert.deepEqual(save.rows[0], { data: originalSave, version: 7 });
    const after = await target.query('SELECT name, checksum FROM schema_migrations WHERE name=ANY($1::text[]) ORDER BY name', [['001_users.sql','002_game_saves.sql']]);
    assert.deepEqual(after.rows, before.rows);
    assert.equal((await target.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='003_invites.sql'")).rows[0].n, 1);
    for (const table of ['game_profiles', 'game_invitations']) {
      assert.equal((await target.query('SELECT to_regclass($1) AS name', [table])).rows[0].name, table);
    }
  } finally {
    if (target) await target.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    await rm(previous, { recursive: true, force: true });
  }
});
