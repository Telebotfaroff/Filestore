import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDatabasePool, closeDatabasePool } from './pool.js';
import { loadConfig } from '../config/env.js';

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url)) + '/migrations';
const MIGRATION_LOCK_ID = 74290136;

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export async function runMigrations(pool) {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    locked = true;
    await ensureMigrationTable(client);
    const files = await listMigrationFiles();
    const applied = await client.query('SELECT version, checksum FROM schema_migrations');
    const checksums = new Map(applied.rows.map((row) => [row.version, row.checksum]));

    for (const filename of files) {
      const version = filename.replace(/\.sql$/, '');
      const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (checksums.has(version)) {
        if (checksums.get(version) !== checksum) {
          throw new Error(`Applied migration ${version} was modified. Create a new migration instead.`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
        await client.query('COMMIT');
        console.info(`[FileStore] Applied migration ${version}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${version} failed: ${error.message}`);
      }
    }
    return { discovered: files.length, applied: files.filter((file) => !checksums.has(file.replace(/\.sql$/, ''))).length };
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]); } catch {}
    }
    client.release();
  }
}

async function main() {
  const config = loadConfig();
  const pool = createDatabasePool(config);
  try {
    const result = await runMigrations(pool);
    console.info(`[FileStore] Migrations complete. Found ${result.discovered}; newly applied ${result.applied}.`);
  } finally {
    await closeDatabasePool();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[FileStore] Migration runner failed:', error.message);
    process.exitCode = 1;
  });
}
