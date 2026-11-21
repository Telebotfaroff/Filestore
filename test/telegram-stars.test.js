import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStarsPayload,
  getTelegramStarsPrice,
  handleStarsPreCheckout,
  sendStarsInvoice,
  setTelegramStarsPrice,
  enableTelegramStars,
  testTelegramStars,
} from '../src/payments/telegram-stars.js';

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

test('sendStarsInvoice passes Telegraf v4 invoice object (not positional args)', async () => {
  const sentCalls = [];
  const bot = {
    telegram: {
      sendInvoice: async (...args) => {
        sentCalls.push(args);
        return { message_id: 99 };
      },
    },
  };
  const pool = {
    query: async (sql) => {
      if (sql.includes('SELECT is_enabled, public_config FROM payment_methods')) {
        return { rowCount: 1, rows: [{ is_enabled: true, public_config: { stars_prices: { premium: { '3': 75 } } } }] };
      }
      if (sql.includes('INSERT INTO payment_sessions')) {
        return { rowCount: 1, rows: [{ id: 88, method: 'telegram_stars', purpose: 'premium', expected_amount_minor: 75, currency: 'XTR' }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  const ctx = { chat: { id: 555, type: 'private' }, from: { id: 555 } };
  const res = await sendStarsInvoice(bot, pool, ctx, 'premium', { planId: 3 }, 'Gold Plan (30 days)', 'Unlock Gold Plan benefits', 'bot-token-secret-test');
  assert.deepEqual(res, { sessionId: 88, stars: 75 });
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].length, 2);
  assert.equal(sentCalls[0][0], 555);
  assert.equal(typeof sentCalls[0][1], 'object');
  assert.equal(sentCalls[0][1].title, 'Gold Plan (30 days)');
  assert.equal(sentCalls[0][1].description, 'Unlock Gold Plan benefits');
  assert.equal(sentCalls[0][1].provider_token, '');
  assert.equal(sentCalls[0][1].currency, 'XTR');
  assert.deepEqual(sentCalls[0][1].prices, [{ label: 'Gold Plan (30 days)', amount: 75 }]);
  assert.match(sentCalls[0][1].payload, /^fsstars:88:[a-f0-9]{32}$/);
});

test('setTelegramStarsPrice, enableTelegramStars, and testTelegramStars manage Stars configuration', async () => {
  const state = {
    is_enabled: false,
    public_config: {},
    setup_status: 'not_configured',
    last_test_status: 'unknown',
    last_test_error: null,
  };
  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes('SELECT is_enabled, public_config, setup_status')) {
        return { rowCount: 1, rows: [{ ...state }] };
      }
      if (sql.includes('SELECT is_enabled, public_config FROM payment_methods')) {
        return { rowCount: 1, rows: [{ is_enabled: state.is_enabled, public_config: state.public_config }] };
      }
      if (sql.includes('SET public_config = $2::jsonb')) {
        state.public_config = JSON.parse(args[1]);
        state.setup_status = args[2];
        state.is_enabled = args[3];
        state.last_test_status = 'unknown';
        state.last_test_error = null;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SET is_enabled = TRUE')) {
        state.is_enabled = true;
        state.setup_status = 'configured';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SET last_test_status = $2')) {
        state.last_test_status = args[1];
        state.last_test_error = args[2];
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  await assert.rejects(() => enableTelegramStars(pool, 100), /Set at least one Telegram Stars price/);
  await assert.rejects(() => testTelegramStars({ getMe: async () => ({ username: 'TestBot' }) }, pool), /No Telegram Stars prices configured yet/);
  assert.equal(state.last_test_status, 'failed');

  const updated = await setTelegramStarsPrice(pool, 'premium', 1, 50, 100);
  assert.equal(updated.isConfigured, true);
  assert.equal(updated.counts.premium, 1);

  const enabled = await enableTelegramStars(pool, 100);
  assert.equal(enabled.isEnabled, true);

  const tested = await testTelegramStars({ getMe: async () => ({ username: 'FileStore_testbot' }) }, pool);
  assert.equal(tested.ok, true);
  assert.equal(tested.botUsername, 'FileStore_testbot');
  assert.equal(state.last_test_status, 'ok');
  assert.equal(state.last_test_error, null);

  const removed = await setTelegramStarsPrice(pool, 'premium', 1, 0, 100);
  assert.equal(removed.isConfigured, false);
  assert.equal(removed.isEnabled, false);
});
