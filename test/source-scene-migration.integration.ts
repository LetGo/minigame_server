import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../src/database/migrate.js';

// Separate scratch database on the disposable test PostgreSQL only.
const testUrl = 'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';

test('source scene migration preserves legacy data and enforces write-once attribution in PostgreSQL', async t => {
  const admin = new Pool({ connectionString: testUrl });
  const name = 'scene_upgrade_' + randomBytes(6).toString('hex');
  const previous = await mkdtemp(join(tmpdir(), 'minigame-pre-scene-'));
  let target: Pool | undefined;
  let created = false;
  try {
    for (const file of ['001_users.sql', '002_game_saves.sql', '003_invites.sql']) {
      await copyFile(join('migrations', file), join(previous, file));
    }
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const url = new URL(testUrl); url.pathname = '/' + name;
    target = new Pool({ connectionString: url.href });
    const db = target;
    await migrate(db, previous);
    const legacy = (await db.query('INSERT INTO game_users(app_id,open_id) VALUES($1,$2) RETURNING id',
      ['wx1111111111111111', 'pre_scene_legacy'])).rows[0].id;
    const save = '{ "original":9007199254740993123 }\n';
    await db.query('INSERT INTO game_saves(user_id,data,version) VALUES($1,$2,9)', [legacy, save]);
    const history = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    await migrate(db);
    await migrate(db);
    const columns = await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='game_users' AND column_name IN ('source_scene','source_scene_reported_at')`);
    assert.equal(columns.rowCount, 2, 'source scene migration must install nullable attribution columns');

    await t.test('legacy users remain unknown rather than being incorrectly backfilled', async () => {
      const user = (await db.query('SELECT source_scene,source_scene_reported_at,first_login_completed FROM game_users WHERE id=$1', [legacy])).rows[0];
      assert.deepEqual(user, { source_scene: null, source_scene_reported_at: null, first_login_completed: true });
      assert.deepEqual((await db.query('SELECT data,version FROM game_saves WHERE user_id=$1', [legacy])).rows[0], { data: save, version: 9 });
      const prior = await db.query('SELECT name,checksum FROM schema_migrations WHERE name=ANY($1::text[]) ORDER BY name', [history.map(row => row.name)]);
      assert.deepEqual(prior.rows, history);
    });

    await t.test('database permits a first scene and leaves unrelated login updates working', async () => {
      await db.query('UPDATE game_users SET source_scene=$1,source_scene_reported_at=clock_timestamp() WHERE id=$2', [1007, legacy]);
      await db.query('UPDATE game_users SET last_login_at=clock_timestamp() WHERE id=$1', [legacy]);
      const current = (await db.query('SELECT source_scene,source_scene_reported_at FROM game_users WHERE id=$1', [legacy])).rows[0];
      assert.equal(current.source_scene, 1007);
      assert(current.source_scene_reported_at instanceof Date);
    });

    await t.test('database rejects replacement, clearing and attribution timestamp rewriting', async () => {
      const before = (await db.query('SELECT source_scene,source_scene_reported_at::text FROM game_users WHERE id=$1', [legacy])).rows[0];
      for (const sql of [
        'UPDATE game_users SET source_scene=1008 WHERE id=$1',
        'UPDATE game_users SET source_scene=NULL,source_scene_reported_at=NULL WHERE id=$1',
        "UPDATE game_users SET source_scene_reported_at=source_scene_reported_at+interval '1 second' WHERE id=$1",
      ]) {
        await assert.rejects(() => db.query(sql, [legacy]), 'a stored attribution must be immutable');
        assert.deepEqual((await db.query('SELECT source_scene,source_scene_reported_at::text FROM game_users WHERE id=$1', [legacy])).rows[0], before);
      }
      await db.query('UPDATE game_users SET source_scene=source_scene,source_scene_reported_at=source_scene_reported_at WHERE id=$1', [legacy]);
    });

    await t.test('database rejects invalid scenes and partial scene/timestamp records', async () => {
      for (const [scene, time] of [[0, '2026-10-17T00:00:00Z'], [-1, '2026-10-17T00:00:00Z'],
        [1007, null], [null, '2026-10-17T00:00:00Z']]) {
        await assert.rejects(() => db.query(`INSERT INTO game_users(app_id,open_id,source_scene,source_scene_reported_at)
          VALUES($1,$2,$3,$4)`, ['wx1111111111111111', randomBytes(8).toString('hex'), scene, time]));
      }
    });
  } finally {
    if (target) await target.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    await rm(previous, { recursive: true, force: true });
  }
});
