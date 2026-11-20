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

import { searchPaymentTransactions } from '../src/admin/dashboard-repository.js';

test('payment search supports IDs and reference text with a bounded result set', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 14 }] };
    return { rows: [{ id: 3 }] };
  } };
  const result = await searchPaymentTransactions(pool, 'UTR_45%', 50);
  assert.deepEqual(result, { rows: [{ id: 3 }], total: 14, term: 'UTR_45%', limit: 10 });
  assert.deepEqual(calls[0].params, ['UTR_45%', '%UTR_45%%']);
  assert.deepEqual(calls[1].params, ['UTR_45%', '%UTR_45%%', 10]);
  assert.ok(calls[0].sql.includes('id::text = $1'));
  assert.ok(calls[0].sql.includes('user_telegram_id::text = $1'));
  assert.ok(calls[0].sql.includes('external_transaction_id ILIKE $2'));
  assert.ok(calls[0].sql.includes('utr ILIKE $2'));
});

test('blank payment search performs no SQL', async () => {
  let called = false;
  const result = await searchPaymentTransactions({ query: async () => { called = true; } }, '   ');
  assert.deepEqual(result, { rows: [], total: 0, term: '' });
  assert.equal(called, false);
});
