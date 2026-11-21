import pg from 'pg';

const { Pool } = pg;
let pool;

export function createMockDatabasePool() {
  return {
    isMock: true,
    on: () => {},
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => {},
    }),
    end: async () => {},
  };
}

export function createDatabasePool(config) {
  if (pool) return pool;
  if (!config?.databaseUrl) {
    console.warn('[FileStore] DATABASE_URL not configured — mock database pool active');
    pool = createMockDatabasePool();
    return pool;
  }
  try {
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
  } catch (error) {
    console.warn('[FileStore] Database pool init failed — mock active:', error.message);
    pool = createMockDatabasePool();
  }
  return pool;
}

export function activateMockDatabasePool() {
  pool = createMockDatabasePool();
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
