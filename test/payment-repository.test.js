import test from 'node:test';
import assert from 'node:assert/strict';
import { listPaymentTransactions, markPaymentMethodTest } from '../src/payments/repository.js';

test('payment transaction listing returns audit-safe fields with bounded limit', async () => {
  const calls = [];
  const pool = { query: async (sql, args) => {
    calls.push({ sql: String(sql), args });
    return { rows: [{ id: 10, status: 'verified', method: 'telegram_stars', amount_minor: 100, currency: 'XTR' }] };
  } };
  const rows = await listPaymentTransactions(pool, 'verified', 15);
  assert.equal(rows[0].id, 10);
  assert.ok(calls[0].sql.includes('external_transaction_id'));
  assert.ok(calls[0].sql.includes('WHERE ($1::text IS NULL OR status = $1)'));
  assert.deepEqual(calls[0].args, ['verified', 15]);
});

test('payment transaction status filter is validated', async () => {
  const pool = { query: async () => { throw new Error('query should not execute'); } };
  await assert.rejects(listPaymentTransactions(pool, 'unknown'), /Invalid payment transaction status/);
});

test('payment transaction limit is clamped to 50', async () => {
  let args;
  const pool = { query: async (_sql, queryArgs) => { args = queryArgs; return { rows: [] }; } };
  await listPaymentTransactions(pool, null, 1000);
  assert.deepEqual(args, [null, 50]);
});

test('markPaymentMethodTest binds method=$1, status=$2, error=$3 cleanly', async () => {
  const calls = [];
  const pool = {
    query: async (sql, args) => {
      calls.push({ sql: String(sql), args });
      return { rowCount: 1, rows: [] };
    },
  };

  await markPaymentMethodTest(pool, 'fampay', 'ok', null);
  assert.match(calls[0].sql, /SET last_test_status = \$2, last_test_error = \$3.*WHERE method = \$1/);
  assert.deepEqual(calls[0].args, ['fampay', 'ok', null]);

  const longError = 'E'.repeat(650);
  await markPaymentMethodTest(pool, 'telegram_stars', 'failed', longError);
  assert.equal(calls[1].args[0], 'telegram_stars');
  assert.equal(calls[1].args[1], 'failed');
  assert.equal(calls[1].args[2].length, 500);
});
