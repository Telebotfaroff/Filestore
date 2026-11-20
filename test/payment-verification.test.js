import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaymentSessionInput, recordProviderEvent, recordVerifiedPayment } from '../src/payments/verification-repository.js';

test('payment session inputs require proper method, purpose, positive amount, currency and target', () => {
  const future = new Date(Date.now() + 60_000);
  assert.throws(() => validatePaymentSessionInput({ method: 'bogus', purpose: 'premium', amountMinor: 100, currency: 'INR', expiresAt: future, planId: 1 }));
  assert.throws(() => validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: -1, currency: 'INR', expiresAt: future, planId: 1 }));
  assert.throws(() => validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: 0, currency: 'INR', expiresAt: future, planId: 1 }));
  assert.throws(() => validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: 100, currency: 'IN', expiresAt: future, planId: 1 }));
  assert.throws(() => validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: 100, currency: 'INR', expiresAt: future }));
  assert.throws(() => validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: 100, currency: 'INR', expiresAt: new Date(Date.now() - 1000), planId: 1 }));
  assert.equal(validatePaymentSessionInput({ method: 'stripe', purpose: 'premium', amountMinor: 100, currency: 'inr', expiresAt: future, userId: 12345, planId: 2 }).currency, 'INR');
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

test('verified payment requires a matching pending checkout session and rejects mismatched duplicate IDs', async () => {
  const session = { id: 7, user_telegram_id: '12345', method: 'stripe', purpose: 'premium', plan_id: 2, file_id: null, expected_amount_minor: 9900, currency: 'INR', status: 'pending', expires_at: new Date(Date.now() + 60_000) };
  const prior = { id: 9, user_telegram_id: '54321', method: 'stripe', external_transaction_id: 'pi_1', purpose: 'premium', plan_id: 2, file_id: null, amount_minor: 9900, currency: 'INR', status: 'verified', session_id: 7, verified_at: new Date() };
  const client = { query: async (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM payment_sessions')) return { rows: [session], rowCount: 1 };
    if (sql.includes('FROM payment_transactions')) return { rows: [prior], rowCount: 1 };
    throw new Error('Unexpected query ' + sql);
  }, release() {} };
  const pool = { connect: async () => client };
  await assert.rejects(recordVerifiedPayment(pool, { method: 'stripe', externalTransactionId: 'pi_1', sessionId: 7, userId: 12345, purpose: 'premium', planId: 2, amountMinor: 9900, currency: 'INR' }), /does not match this payment/);
});

test('verified payment requires transaction ID and session ID', async () => {
  const pool = { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  await assert.rejects(recordVerifiedPayment(pool, { method: 'stripe', sessionId: 1, userId: 123, purpose: 'premium', planId: 1, amountMinor: 1, currency: 'INR' }), /transaction ID is required/);
  await assert.rejects(recordVerifiedPayment(pool, { method: 'stripe', externalTransactionId: 'abc', userId: 123, purpose: 'premium', planId: 1, amountMinor: 1, currency: 'INR' }), /session ID is required/);
});


test('expired session accepts only an authoritative Telegram Stars payment recovery flag', async () => {
  const expiredSession = { id: 11, user_telegram_id: '12345', method: 'telegram_stars', purpose: 'premium', plan_id: 2, file_id: null, batch_link_id: null, paid_link_id: null, expected_amount_minor: 50, currency: 'XTR', status: 'pending', expires_at: new Date(Date.now() - 5000) };
  let inserted = false;
  const client = { query: async (sql) => {
    if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM payment_sessions')) return { rows: [expiredSession], rowCount: 1 };
    if (sql.includes('FROM payment_transactions')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO payment_transactions')) { inserted = true; return { rows: [{ id: 88, status: 'verified' }], rowCount: 1 }; }
    if (sql.includes('UPDATE payment_sessions')) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected query ' + sql);
  }, release() {} };
  const pool = { connect: async () => client };
  const payment = { method: 'telegram_stars', externalTransactionId: 'charge_1', sessionId: 11, userId: 12345, purpose: 'premium', planId: 2, amountMinor: 50, currency: 'XTR' };
  await assert.rejects(recordVerifiedPayment(pool, payment), /Payment session expired/);
  assert.equal(inserted, false);
  const recovered = await recordVerifiedPayment(pool, { ...payment, allowExpiredSession: true });
  assert.equal(recovered.transaction.id, 88);
  assert.equal(inserted, true);
});


test('expired checkout sessions accept late authoritative Stars receipts but not other methods', async () => {
  const expiredSession = { id: 12, user_telegram_id: '12345', method: 'telegram_stars', purpose: 'premium', plan_id: 2, file_id: null, batch_link_id: null, paid_link_id: null, expected_amount_minor: 80, currency: 'XTR', status: 'expired', expires_at: new Date(Date.now() - 30000) };
  let inserted = false;
  const client = { query: async (sql) => {
    if ( ['BEGIN','COMMIT','ROLLBACK'].includes(sql) ) return { rows: [] };
    if (sql.includes('FROM payment_sessions')) return { rows: [expiredSession], rowCount: 1 };
    if (sql.includes('FROM payment_transactions')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO payment_transactions')) { inserted = true; return { rows: [{ id: 89, status: 'verified' }], rowCount: 1 }; }
    if (sql.includes('UPDATE payment_sessions')) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected query ' + sql);
  }, release() {} };
  const pool = { connect: async () => client };
  const payment = { method: 'telegram_stars', externalTransactionId: 'charge_late', sessionId: 12, userId: 12345, purpose: 'premium', planId: 2, amountMinor: 80, currency: 'XTR', allowExpiredSession: true };
  const result = await recordVerifiedPayment(pool, payment);
  assert.equal(result.transaction.id, 89);
  assert.equal(inserted, true);
  inserted = false;
  await assert.rejects(recordVerifiedPayment(pool, { ...payment, method: 'stripe' }), /does not match the checkout session/);
  assert.equal(inserted, false);
});
