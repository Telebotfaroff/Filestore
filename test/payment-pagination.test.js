import test from 'node:test';
import assert from 'node:assert/strict';
import { listPaymentTransactions } from '../src/admin/dashboard-repository.js';

test('payment list query returns count and rows for selected page', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 12 }] };
    return { rows: [{ id: 7 }, { id: 8 }] };
  } };
  const result = await listPaymentTransactions(pool, { limit: 5, offset: 5, status: 'verified' });
  assert.deepEqual(result, { rows: [{ id: 7 }, { id: 8 }], total: 12, limit: 5, offset: 5, status: 'verified' });
  assert.deepEqual(calls[0].params, ['verified']);
  assert.deepEqual(calls[1].params, ['verified', 5, 5]);
  assert.match(calls[1].sql, /WHERE status = \$1/);
  assert.match(calls[1].sql, /ORDER BY created_at DESC LIMIT \$2 OFFSET \$3/);
});

test('payment list safely clamps pagination and normalizes unknown filter', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return sql.includes('COUNT(*)::int AS total') ? { rows: [{ total: 1 }] } : { rows: [] };
  } };
  const result = await listPaymentTransactions(pool, { limit: 500, offset: -10, status: 'injected;drop' });
  assert.deepEqual(result, { rows: [], total: 1, limit: 10, offset: 0, status: 'all' });
  assert.deepEqual(calls[0].params, []);
  assert.deepEqual(calls[1].params, [10, 0]);
  assert.doesNotMatch(calls[1].sql, /injected/);
});
