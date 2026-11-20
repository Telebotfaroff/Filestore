import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaymentSessionInput, recordProviderEvent, recordVerifiedPayment } from '../src/payments/verification-repository.js';

test('payment session inputs require proper method, purpose, amount, currency and target', () => {
  assert.throws(() => validatePaymentSessionInput({ method: 'bogus', purpose: 'premium', amountMinor: 100, currency: 'INR', expiresAt: new Date(), planId: 1 }));
  assert.throws(() => validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: -1, currency: 'INR', expiresAt: new Date(), planId: 1 }));
  assert.throws(() => validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: 100, currency: 'IN', expiresAt: new Date(), planId: 1 }));
  assert.throws(() => validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: 100, currency: 'INR', expiresAt: new Date() }));
  assert.equal(validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: 100, currency: 'inr', expiresAt: new Date(), planId: 2 }).currency, 'INR');
});

test('provider events are idempotent and payload mismatch on reused event ID fails', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('INSERT INTO payment_provider_events')) return { rows: [] };
    return { rows: [{ id: 4, method: 'stripe', provider_event_id: 'evt_1', event_type: 'checkout', payload_hash: 'not-the-hash', processing_status: 'received' }] };
  }};
  await assert.rejects(recordProviderEvent(pool, { method: 'stripe', eventId: 'evt_1', eventType: 'checkout', payload: { a: 1 } }), /reused with different payload/);
  assert.equal(calls.length, 2);
});

test('verified payment rejects duplicate transaction ID if payment details do not match', async () => {
  const pool = { query: async (sql) => sql.includes('INSERT INTO payment_transactions') ? { rows: [] } : { rows: [{
    id: 9, user_telegram_id: '12345', method: 'stripe', external_transaction_id: 'pi_1',
    purpose: 'premium', plan_id: 2, file_id: null, amount_minor: 9900, currency: 'INR', status: 'verified', verified_at: new Date(),
  }] };
  await assert.rejects(recordVerifiedPayment(pool, { method: 'stripe', externalTransactionId: 'pi_1', userId: 12345, purpose: 'premium', planId: 2, amountMinor: 100, currency: 'INR' }), /does not match this payment/);
});

test('verified payment requires transaction ID', async () => {
  await assert.rejects(recordVerifiedPayment({ query: async () => ({ rows: [] }) }, { method: 'stripe', userId: 123, purpose: 'premium', planId: 1, amountMinor: 1, currency: 'INR' }), /transaction ID is required/);
});
