import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/database/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await migrate(pool);
    process.stdout.write('Database migrations applied successfully\n');
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  process.stderr.write('Migration failed; check connection, schema and migration checksums\n');
  process.exitCode = 1;
});
