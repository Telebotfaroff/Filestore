import test from 'node:test';
import assert from 'node:assert/strict';
import { startPaymentRecoveryWorker } from '../src/payments/recovery-worker.js';

test('payment recovery scan is bounded and only selects due verified rows', async () => {
  let selectSql = '';
  let selectParams;
  const pool = { query: async (sql, params) => {
    selectSql = sql;
    selectParams = params;
    return { rows: [] };
  }};
  const logger = { info(){}, warn(){}, error(){} };
  const worker = startPaymentRecoveryWorker(pool, logger, null, 60_000);
  worker.stop();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(selectSql, /status='verified'/);
  assert.match(selectSql, /recovery_next_at <= NOW\(\)/);
  assert.match(selectSql, /LIMIT 25/);
  assert.deepEqual(selectParams, undefined);
});

test('failed payment recovery records bounded exponential backoff and error', async () => {
  const tx = { id: 77, user_telegram_id: 123, purpose: 'paid_file', method: 'stripe', recovery_attempts: 0 };
  const scheduled = [];
  const pool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id,user_telegram_id,purpose,method,recovery_attempts')) return { rows: [tx] };
      if (sql.includes('UPDATE payment_transactions SET recovery_attempts')) { scheduled.push({ sql, params }); return { rows: [] }; }
      throw new Error('Unexpected pool query');
    },
    connect: async () => ({ query: async (sql) => {
      if (sql.includes('FROM payment_transactions')) return { rowCount: 1, rows: [{ ...tx, status: 'verified', session_id: 8 }] };
      if (sql.includes('FROM payment_sessions')) throw new Error('Session unavailable');
      return { rows: [] };
    }, release(){} }),
  };
  let resolveWarning;
  const warned = new Promise(resolve => { resolveWarning = resolve; });
  const logger = { info(){}, warn(){ resolveWarning(); }, error(){} };
  const worker = startPaymentRecoveryWorker(pool, logger, null, 60_000);
  await warned;
  worker.stop();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].params[0], 77);
  assert.equal(scheduled[0].params[1], 30);
  assert.match(scheduled[0].params[2], /Session unavailable/);
  assert.match(scheduled[0].sql, /recovery_next_at=NOW/);
});


test('recovery notifications retry after Telegram failure and record bounded diagnostics', async () => {
  const claimed = [];
  const tx = { id: 93, user_telegram_id: 777, purpose: 'paid_file' };
  async function mockQuery(sql, params) {
    if (sql.includes("WHERE status='verified'")) return { rows: [] };
    if (sql.includes('WITH claimed')) return { rows: [tx] };
    if (sql.includes('recovery_notification_attempts=recovery_notification_attempts+1')) {
      claimed.push({ sql, params });
      return { rows: [] };
    }
    throw new Error('Unexpected SQL: ' + sql);
  }
  const pool = { query: mockQuery };
  let resolveWarning;
  const warning = new Promise(resolve => { resolveWarning = resolve; });
  const logger = { info(){}, warn(){ resolveWarning(); }, error(){} };
  const telegram = { sendMessage: async () => { throw new Error('Telegram temporarily unavailable'); } };
  const worker = startPaymentRecoveryWorker(pool, logger, telegram, 60_000);
  await warning;
  worker.stop();
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].params[0], 93);
  assert.match(claimed[0].params[1], /Telegram temporarily unavailable/);
  assert.match(claimed[0].sql, /recovery_notification_claimed_at=NULL/);
});
