import { getDatabasePool } from './pool.js';

export async function checkDatabaseHealth() {
  const pool = getDatabasePool();
  const started = Date.now();
  try {
    const result = await pool.query('SELECT NOW() AS database_time');
    return {
      status: 'ok',
      latencyMs: Date.now() - started,
      databaseTime: result.rows[0].database_time,
    };
  } catch (error) {
    return { status: 'error', latencyMs: Date.now() - started, error: error.message };
  }
}
