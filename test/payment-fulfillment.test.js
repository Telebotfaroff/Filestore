import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVerifiedPayment } from '../src/payments/fulfillment-repository.js';

test('applied payment is idempotent and exits without additional grants', async () => {
  const statements = [];
  const client = { query: async (sql, args) => {
    statements.push({ sql, args });
    if (sql.includes('FROM payment_transactions')) return { rowCount: 1, rows: [{ id: 21, purpose: 'premium', user_telegram_id: 123, status: 'applied' }] };
    return { rows: [] };
  }, release() {} };
  const result = await applyVerifiedPayment({ connect: async () => client }, 21);
  assert.equal(result.alreadyApplied, true);
  assert.equal(statements.some(s => s.sql.includes('INSERT INTO access_grants')), false);
});

test('pending transactions cannot be fulfilled', async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql);
    if (sql.includes('FROM payment_transactions')) return { rowCount: 1, rows: [{ id: 22, purpose: 'paid_file', user_telegram_id: 456, status: 'pending', session_id: 5 }] };
    return { rows: [] };
  }, release() {} };
  await assert.rejects(applyVerifiedPayment({ connect: async () => client }, 22), /Only verified transactions/);
  assert.ok(statements.includes('ROLLBACK'));
});

test('paid batch fulfillment grants every file in batch transactionally', async () => {
  const tx = { id: 23, user_telegram_id: 789, method: 'stripe', purpose: 'paid_batch', plan_id: null, file_id: null, batch_link_id: 4, paid_link_id: null, amount_minor: 5000, currency: 'INR', status: 'verified', session_id: 6 };
  const session = { id: 6, status: 'verified', user_telegram_id: 789, purpose: 'paid_batch', plan_id: null, file_id: null, batch_link_id: 4, paid_link_id: null, expected_amount_minor: 5000, currency: 'INR' };
  const grants = [];
  const calls = [];
  const client = { query: async (sql, args = []) => {
    calls.push(sql);
    if (sql.includes('FROM payment_transactions')) return { rowCount: 1, rows: [tx] };
    if (sql.includes('FROM payment_sessions')) return { rowCount: 1, rows: [session] };
    if (sql.includes('FROM paid_batch_links')) return { rowCount: 1, rows: [{ id: 4, title: 'Batch', price_minor: 5000, currency: 'INR' }] };
    if (sql.includes('INSERT INTO paid_batch_purchases')) return { rowCount: 1, rows: [{ id: 41 }] };
    if (sql.includes('SELECT file_id FROM paid_batch_items')) return { rowCount: 2, rows: [{ file_id: 101 }, { file_id: 102 }] };
    if (sql.includes('INSERT INTO access_grants')) grants.push(args);
    return { rows: [] };
  }, release() {} };
  const result = await applyVerifiedPayment({ connect: async () => client }, 23);
  assert.equal(result.applied, true);
  assert.equal(result.fileCount, 2);
  assert.deepEqual(grants.map(x => x[1]), [101, 102]);
  assert.ok(calls.some(s => s.includes("status='applied'")));
  assert.ok(calls.includes('COMMIT'));
});
