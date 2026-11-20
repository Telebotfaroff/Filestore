import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarsPayload, getTelegramStarsPrice, handleStarsPreCheckout } from '../src/payments/telegram-stars.js';

test('Stars price lookup returns only positive integer prices for configured targets', () => {
  const config = { stars_prices: { premium: { '3': 150 }, paid_file: { '12': 20 }, paid_batch: { '9': 85 } } };
  assert.equal(getTelegramStarsPrice(config, 'premium', { planId: 3 }), 150);
  assert.equal(getTelegramStarsPrice(config, 'paid_file', { paidLinkId: 12 }), 20);
  assert.equal(getTelegramStarsPrice(config, 'paid_batch', { batchLinkId: 9 }), 85);
  assert.equal(getTelegramStarsPrice(config, 'premium', { planId: 99 }), null);
  assert.equal(getTelegramStarsPrice({ stars_prices: { premium: { '3': 1.5 } } }, 'premium', { planId: 3 }), null);
});

test('signed invoice payload passes pre-checkout only for its matching user and amount', async () => {
  const token = 'bot-token-secret-test';
  const payload = createStarsPayload(token, 44);
  const session = { id: 44, user_telegram_id: 101, method: 'telegram_stars', currency: 'XTR', expected_amount_minor: 100, status: 'pending', expires_at: new Date(Date.now() + 60000) };
  const answers = [];
  const ctx = { preCheckoutQuery: { id: 'q1', from: { id: 101 }, invoice_payload: payload, currency: 'XTR', total_amount: 100 }, telegram: { answerPreCheckoutQuery: async (...args) => answers.push(args) } };
  const pool = { query: async () => ({ rows: [session] }) };
  await handleStarsPreCheckout({}, pool, ctx, token, { warn() {} });
  assert.deepEqual(answers, [['q1', true]]);
});

test('signed payload pre-checkout fails closed for a mismatched amount', async () => {
  const token = 'bot-token-secret-test';
  const payload = createStarsPayload(token, 44);
  const session = { id: 44, user_telegram_id: 101, method: 'telegram_stars', currency: 'XTR', expected_amount_minor: 100, status: 'pending', expires_at: new Date(Date.now() + 60000) };
  const answers = [];
  const ctx = { preCheckoutQuery: { id: 'q2', from: { id: 101 }, invoice_payload: payload, currency: 'XTR', total_amount: 101 }, telegram: { answerPreCheckoutQuery: async (...args) => answers.push(args) } };
  const pool = { query: async () => ({ rows: [session] }) };
  await handleStarsPreCheckout({}, pool, ctx, token, { warn() {} });
  assert.deepEqual(answers, [['q2', false, 'Checkout expired or amount mismatch. Please try again.']]);
});

test('invoice payload signature cannot be reused with another bot token', async () => {
  const payload = createStarsPayload('token-A', 44);
  const answers = [];
  const ctx = { preCheckoutQuery: { id: 'q3', from: { id: 101 }, invoice_payload: payload, currency: 'XTR', total_amount: 100 }, telegram: { answerPreCheckoutQuery: async (...args) => answers.push(args) } };
  await handleStarsPreCheckout({}, { query: async () => ({ rows: [] }) }, ctx, 'token-B', { warn() {} });
  assert.deepEqual(answers, [['q3', false, 'Invalid checkout. Please restart the purchase.']]);
});
