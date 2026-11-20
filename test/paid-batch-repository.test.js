import test from 'node:test';
import assert from 'node:assert/strict';
import { listPaidBatchLinks } from '../src/paid-files/batch-repository.js';

test('batch listing counts purchases distinctly despite multiple batch items', async () => {
  let sql;
  let args;
  const pool = {
    query: async (query, parameters) => {
      sql = String(query);
      args = parameters;
      return { rows: [{ id: 1, item_count: 4, purchase_count: 3 }] };
    },
  };
  const rows = await listPaidBatchLinks(pool);
  assert.equal(rows[0].item_count, 4);
  assert.equal(rows[0].purchase_count, 3);
  assert.match(sql, /COUNT\(DISTINCT i\.file_id\).*COUNT\(DISTINCT p\.id\)/s);
  assert.deepEqual(args, [30]);
});

test('batch listing clamps limits to a safe range', async () => {
  const limits = [];
  const pool = { query: async (_sql, args) => { limits.push(args[0]); return { rows: [] }; } };
  await listPaidBatchLinks(pool, -5);
  await listPaidBatchLinks(pool, 999);
  assert.deepEqual(limits, [1, 100]);
});
