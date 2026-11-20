import test from 'node:test';
import assert from 'node:assert/strict';
import { getPaymentTransactionDetail } from '../src/admin/dashboard-repository.js';

test('payment detail query loads transaction, checkout, and provider event history', async () => {
  const calls = [];
  const tx = { id: 4, method: 'telegram_stars', external_transaction_id: 'charge_abc', session_id: 12 };
  const events = [{ id: 8, processing_status: 'processed', event_type: 'successful_payment' }];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM payment_transactions t')) return { rows: [tx], rowCount: 1 };
    if (sql.includes('FROM payment_provider_events')) return { rows: events, rowCount: 1 };
    throw new Error('Unexpected query: ' + sql);
  } };
  const result = await getPaymentTransactionDetail(pool, 4);
  assert.deepEqual(result, { transaction: tx, events });
  assert.deepEqual(calls[0].params, [4]);
  assert.deepEqual(calls[1].params, [4, 'telegram_stars', 'charge_abc']);
  assert.match(calls[0].sql, /LEFT JOIN payment_sessions/);
  assert.match(calls[1].sql, /payment_transaction_id = \$1/);
});

test('payment detail returns null when transaction does not exist', async () => {
  let count = 0;
  const pool = { query: async () => { count++; return { rows: [], rowCount: 0 }; } };
  assert.equal(await getPaymentTransactionDetail(pool, 404), null);
  assert.equal(count, 1);
});

test('payment detail query rejects invalid transaction IDs', async () => {
  const pool = { query: async () => { throw new Error('Should not query'); } };
  await assert.rejects(getPaymentTransactionDetail(pool, 0), /Invalid payment transaction ID/);
  await assert.rejects(getPaymentTransactionDetail(pool, 'abc'), /Invalid payment transaction ID/);
});
