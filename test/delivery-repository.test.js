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
