import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAccess } from '../src/access/access-manager.js';

function mockPool({ premium = false, checkpointOn = false, providerRows = [], stateRows = [], grant = false } = {}) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM premium_memberships')) return { rowCount: premium ? 1 : 0, rows: premium ? [{}] : [] };
      if (sql.includes("key = 'checkpoint_enabled'")) return { rowCount: 1, rows: [{ value: checkpointOn }] };
      if (sql.includes('FROM shortener_providers')) return { rowCount: providerRows.length, rows: providerRows };
      if (sql.includes('FROM user_checkpoint_state')) return { rowCount: stateRows.length, rows: stateRows };
      if (sql.includes('FROM access_grants')) return { rowCount: grant ? 1 : 0, rows: grant ? [{}] : [] };
      throw new Error('Unexpected query: ' + sql);
    },
  };
}
const passedForceSub = { passed: true, missing: [] };

test('force-sub blocks before any access lookup', async () => {
  const result = await evaluateAccess(mockPool(), { userId: 10, type: 'free_file' }, { passed: false, missing: [{ telegram_chat_id: -100 }] });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'force_subscription_required');
});

test('paid file access is entitlement-based and does not use premium bypass', async () => {
  const result = await evaluateAccess(mockPool({ premium: true, grant: false }), { userId: 10, type: 'paid_file', resourceId: 99 }, passedForceSub);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'purchase_required');
});

test('paid file is allowed with explicit entitlement', async () => {
  const result = await evaluateAccess(mockPool({ grant: true }), { userId: 10, type: 'paid_file', resourceId: 99 }, passedForceSub);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'paid_file_entitlement');
});

test('active premium bypasses free checkpoint checks', async () => {
  const result = await evaluateAccess(mockPool({ premium: true, checkpointOn: true }), { userId: 10, type: 'free_file' }, passedForceSub);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'premium');
});

test('free file is allowed when checkpoint enforcement is off', async () => {
  const result = await evaluateAccess(mockPool({ checkpointOn: false }), { userId: 10, type: 'free_file' }, passedForceSub);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'checkpoint_disabled');
});

test('checkpoint enforcement fails closed without an active provider', async () => {
  const result = await evaluateAccess(mockPool({ checkpointOn: true }), { userId: 10, type: 'free_file' }, passedForceSub);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'checkpoint_provider_unavailable');
});
