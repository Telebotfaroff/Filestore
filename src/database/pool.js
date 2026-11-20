import pg from 'pg';

const { Pool } = pg;
let pool;

export function createDatabasePool(config) {
  if (pool) return pool;
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'filestore',
  });
  pool.on('error', (error) => {
    // Pool-level errors may occur on idle clients; avoid leaking connection details.
    console.error('[FileStore] PostgreSQL pool error:', error.message);
  });
  return pool;
}

export function getDatabasePool() {
  if (!pool) throw new Error('Database pool has not been initialized');
  return pool;
}

export async function closeDatabasePool() {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}
