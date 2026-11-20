import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleDeliveryJob, claimNextDeliveryJob } from '../src/delivery/repository.js';

test('creates a job and item inside a transaction', async () => {
  const statements = [];
  const client = { query: async (sql, args) => {
    statements.push({ sql: String(sql).trim(), args });
    if (String(sql).includes('INSERT INTO delivery_jobs')) return { rows: [{ id: 77 }] };
    return { rows: [] };
  }, release: () => {} };
  const pool = { connect: async () => client };
  const jobId = await createSingleDeliveryJob(pool, 1234, 99, 1234);
  assert.equal(jobId, 77);
  assert.equal(statements[0].sql, 'BEGIN');
  assert.match(statements[1].sql, /INSERT INTO delivery_jobs/);
  assert.match(statements[2].sql, /INSERT INTO delivery_items/);
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('claims pending job, item, and attempt in one transaction', async () => {
  const statements = [];
  const client = { query: async (sql, args) => {
    const q = String(sql).trim();
    statements.push(q);
    if (q.startsWith('SELECT id, requester_telegram_id')) return { rowCount: 1, rows: [{ id: 41, requester_telegram_id: 123 }] };
    if (q.startsWith('SELECT id, file_id FROM delivery_items')) return { rowCount: 1, rows: [{ id: 51, file_id: 99 }] };
    if (q.startsWith('INSERT INTO delivery_attempts')) return { rows: [{ id: 61 }] };
    return { rows: [] };
  }, release: () => {} };
  const pool = { connect: async () => client };
  const claim = await claimNextDeliveryJob(pool, '@delivery');
  assert.deepEqual(claim, { jobId: 41, requesterTelegramId: 123, itemId: 51, fileId: 99, attemptId: 61 });
  assert.ok(statements.includes('BEGIN'));
  assert.ok(statements.includes('COMMIT'));
  assert.ok(statements.some((q) => q.includes('SKIP LOCKED')));
});


test('renews a processing lease only for the current worker', async () => {
  const calls = [];
  const pool = { query: async (sql, args) => {
    calls.push({ sql: String(sql), args });
    return { rowCount: 1, rows: [{ id: 8 }] };
  } };
  const { renewDeliveryLease } = await import('../src/delivery/repository.js');
  assert.equal(await renewDeliveryLease(pool, 42, 'bot-A'), true);
  assert.match(calls[0].sql, /locked_until = NOW\(\) \+ INTERVAL '90 seconds'/);
  assert.match(calls[0].sql, /status = 'processing' AND locked_by = \$2 AND locked_until > NOW\(\)/);
  assert.deepEqual(calls[0].args, [42, 'bot-A']);
});

test('lease renewal reports false when lease ownership is lost', async () => {
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  const { renewDeliveryLease } = await import('../src/delivery/repository.js');
  assert.equal(await renewDeliveryLease(pool, 42, 'bot-A'), false);
});

import { finishDelivery } from '../src/delivery/repository.js';

test('finish delivery refuses to write completion when worker lease is lost', async () => {
  const statements = [];
  const client = { query: async (sql, args) => {
    const query = String(sql).trim();
    statements.push({ query, args });
    if (query.includes('SELECT id FROM delivery_jobs WHERE id =')) return { rowCount: 0, rows: [] };
    return { rows: [] };
  }, release: () => {} };
  const pool = { connect: async () => client };
  await assert.rejects(
    finishDelivery(pool, { jobId: 5, itemId: 6, attemptId: 7, requesterTelegramId: 8 }, 9, 'bot-A'),
    /Delivery lease lost/,
  );
  assert.equal(statements[0].query, 'BEGIN');
  assert.match(statements[1].query, /locked_by = \$2 AND locked_until > NOW\(\) FOR UPDATE/);
  assert.deepEqual(statements[1].args, [5, 'bot-A']);
  assert.equal(statements.some(x => x.query.includes('UPDATE delivery_attempts SET status =')), false);
  assert.equal(statements.at(-1).query, 'ROLLBACK');
});
