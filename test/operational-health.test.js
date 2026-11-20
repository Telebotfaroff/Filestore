import test from 'node:test';
import assert from 'node:assert/strict';
import { getOperationalHealth, formatOperationalHealth } from '../src/admin/operational-health.js';

test('operational health collects queue and recovery counters and marks warnings', async () => {
  let sql = '';
  const values = {
    delivery_pending: 4, delivery_pending_stale: 1, delivery_processing: 2,
    delivery_processing_stale: 0, delivery_failed: 1, delivery_uncertain: 0,
    deletions_due: 3, deletions_stale: 0, deletions_failed: 0,
    payment_recovery_pending: 2, payment_notifications_pending: 1,
    payment_notifications_exhausted: 0, checkpoint_expired_pending: 0,
  };
  const pool = { query: async (q) => { sql = q; return { rows: [values] }; } };
  const health = await getOperationalHealth(pool);
  assert.match(sql, /delivery_pending_stale/);
  assert.match(sql, /recovery_notification_required/);
  assert.equal(health.status, 'warning');
  assert.ok(health.warnings.includes('delivery_pending_stale'));
  assert.ok(health.warnings.includes('payment_recovery_pending'));
  assert.equal(health.stats.delivery_pending, 4);
});

test('operational health formatter presents distinct subsystem counts', () => {
  const output = formatOperationalHealth({
    status: 'warning', latencyMs: 9,
    stats: {
      delivery_pending: 3, delivery_pending_stale: 1, delivery_processing: 2,
      delivery_processing_stale: 1, delivery_failed: 0, delivery_uncertain: 1,
      deletions_due: 0, deletions_stale: 0, deletions_failed: 2,
      payment_recovery_pending: 0, payment_notifications_pending: 1,
      payment_notifications_exhausted: 0, checkpoint_expired_pending: 0,
    },
    warnings: ['delivery_pending_stale','deletions_failed'],
  });
  assert.match(output, /Overall: WARNING/);
  assert.match(output, /older than 10m: 1/);
  assert.match(output, /Failed: 2/);
  assert.match(output, /Attention:/);
});
