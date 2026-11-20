import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDashboardCommands } from '../src/admin/dashboard-commands.js';

function fakeBot() {
  const commands = new Map();
  const actions = [];
  return {
    command(name, handler) { commands.set(name, handler); },
    action(pattern, handler) { actions.push({ pattern, handler }); },
    commands,
    actions,
  };
}

function makePool(rows = []) {
  return {
    query: async (sql) => {
      if (sql.includes('SELECT COUNT(*)::int AS total FROM payment_transactions')) return { rows: [{ total: rows.length }], rowCount: 1 };
      if (sql.includes('FROM payment_transactions') && !sql.includes('payment_transactions t')) return { rows, rowCount: rows.length };
      if (sql.includes('FROM payment_transactions t')) return { rows: [rows[0]], rowCount: rows.length ? 1 : 0 };
      if (sql.includes('FROM payment_provider_events')) return { rows: [], rowCount: 0 };
      throw new Error('Unexpected SQL in test: ' + sql);
    },
  };
}

const row = {
  id: 23, user_telegram_id: '111', method: 'telegram_stars', purpose: 'premium',
  amount_minor: 499, currency: 'INR', status: 'verified', external_transaction_id: 'charge-xyz',
  created_at: new Date('2026-01-01T00:00:00Z'),
};

test('recent payments shows inline transaction detail buttons and filter options', async () => {
  const bot = fakeBot();
  registerDashboardCommands(bot, makePool([row]), { error() {} });
  let message;
  await bot.commands.get('payment_recent')({ reply: async (text, options) => { message = { text, options }; } });
  assert.match(message.text, /#23/);
  assert.equal(message.options.reply_markup.inline_keyboard[0][0].callback_data, 'paydetail:23:all:0');
  assert.ok(message.options.reply_markup.inline_keyboard.some((buttons) => buttons.some((button) => button.callback_data === 'paybrowse:verified:0')));
  assert.ok(message.options.reply_markup.inline_keyboard.some((buttons) => buttons.some((button) => button.callback_data === 'paymentsearchhelp')));
});

test('transaction detail callback includes recovery action and retains browse filter/page', async () => {
  const bot = fakeBot();
  registerDashboardCommands(bot, makePool([row]), { error() {} });
  const action = bot.actions.find(({ pattern }) => pattern instanceof RegExp && pattern.test('paydetail:23:verified:2'));
  assert.ok(action, 'filtered detail callback handler is registered');
  let edited;
  const ctx = {
    match: ['paydetail:23:verified:2', '23', 'verified', '2'],
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  };
  await action.handler(ctx);
  assert.match(edited.text, /Payment Transaction #23/);
  const keyboard = edited.options.reply_markup.inline_keyboard;
  assert.ok(keyboard.some((buttons) => buttons.some((button) => button.callback_data === 'payreconcile:23')));
  assert.ok(keyboard.some((buttons) => buttons.some((button) => button.callback_data === 'paybrowse:verified:2')));
});
