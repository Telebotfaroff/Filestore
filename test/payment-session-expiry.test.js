import test from 'node:test';
import assert from 'node:assert/strict';
import { expirePendingPaymentSessions } from '../src/payments/session-expiry-worker.js';

test('expiry worker only marks overdue pending sessions, using bounded skip-locked batches', async () => {
  let sqlSeen = '';
  let paramsSeen;
  const pool = { query: async (sql, params) => {
    sqlSeen = sql;
    paramsSeen = params;
    return { rows: [{ id: 1 }, { id: 2 }] };
  }};
  const expired = await expirePendingPaymentSessions(pool, 9000);
  assert.equal(expired, 2);
  assert.match(sqlSeen, /status='pending'/);
  assert.match(sqlSeen, /expires_at <= NOW()/);
  assert.match(sqlSeen, /FOR UPDATE SKIP LOCKED/);
  assert.match(sqlSeen, /UPDATE payment_sessions p SET status='expired'/);
  assert.deepEqual(paramsSeen, [2000]);
});

test('expiry worker normalizes invalid batch size to default and uses returned row count', async () => {
  let captured;
  const pool = { query: async (_sql, params) => { captured = params[0]; return { rows: [] }; } };
  assert.equal(await expirePendingPaymentSessions(pool, 0), 0);
  assert.equal(captured, 500);
});
