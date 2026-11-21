import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMainBot, MAIN_BOT_MENU_COMMANDS } from '../src/bot/main.js';
import { createDeliveryBot } from '../src/delivery/bot.js';
import {
  OWNER_COMMAND_CATEGORIES,
  ADMIN_INTERACTIVE_PROMPTS,
  buildAdminHelpKeyboard,
  isPlatformOwner,
} from '../src/bot/admin-router.js';

function createMockMainPool() {
  return {
    query: async (sql) => {
      if (sql.includes('INSERT INTO users')) return { rows: [{ telegram_id: '1' }], rowCount: 1 };
      if (sql.includes('tracked_users') && sql.includes('active_files')) {
        return {
          rows: [{ tracked_users: 5, active_files: 12, premium_active: 2, payments_applied: 3, revenue_by_currency: { INR: 19900 } }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM delivery_jobs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM withdrawal_requests')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM creator_wallets')) {
        return {
          rows: [{ available_minor: 0, locked_minor: 0, total_earned_minor: 0, total_withdrawn_minor: 0, upi_id: null, upi_name: null }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM storage_channels') || sql.includes('FROM delivery_bots') || sql.includes('FROM shortener_providers') || sql.includes('FROM force_sub_channels')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM app_settings')) return { rows: [], rowCount: 0 };
      if (sql.includes('UPDATE payment_methods') && sql.includes('is_enabled = FALSE')) {
        return { rows: [{ method: 'fampay', is_enabled: false }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO app_settings')) return { rows: [{ setting_key: 'auto_delete_minutes', setting_value: '30' }], rowCount: 1 };
      return { rows: [{ total: 0, count: 0, pending: 0, processing: 0, completed: 0, failed: 0, uncertain: 0 }], rowCount: 1 };
    },
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release() {},
    }),
  };
}

function makeTextUpdate(userId, text, updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: userId === 1 ? 'Owner' : 'User' },
      text,
      entities: text.startsWith('/') ? [{ offset: 0, length: text.split(' ')[0].length, type: 'bot_command' }] : [],
    },
  };
}

function makeCallbackUpdate(userId, data, updateId) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: userId, is_bot: false, first_name: userId === 1 ? 'Owner' : 'User' },
      message: {
        message_id: 500 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private' },
        text: 'Panel',
      },
      chat_instance: 'ci_1',
      data,
    },
  };
}

test('isPlatformOwner fails closed when adminIds is missing or empty', () => {
  assert.equal(isPlatformOwner({ from: { id: 1 } }, undefined), false);
  assert.equal(isPlatformOwner({ from: { id: 1 } }, null), false);
  assert.equal(isPlatformOwner({ from: { id: 1 } }, []), false);
  assert.equal(isPlatformOwner({ from: { id: 2 } }, [1]), false);
  assert.equal(isPlatformOwner({ from: { id: 1 } }, [1]), true);
});

test('Main Bot Telegram menu exposes only /start, /me, /guide, and /help', () => {
  assert.deepEqual(
    MAIN_BOT_MENU_COMMANDS.map((c) => c.command),
    ['start', 'me', 'guide', 'help'],
  );
});

test('all interactive /admin keyboards keep callback_data within Telegram 64-byte limit', () => {
  for (const view of ['home', 'system', 'delivery', 'premium', 'payments', 'gateways', 'confirmations', 'all']) {
    const kb = buildAdminHelpKeyboard(view);
    assert.ok(Array.isArray(kb.inline_keyboard) && kb.inline_keyboard.length > 0, `Expected buttons for view ${view}`);
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        assert.ok(btn.callback_data && Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `callback_data too long: ${btn.callback_data}`);
      }
    }
  }
  assert.ok(Object.keys(ADMIN_INTERACTIVE_PROMPTS).length >= 18);
});

test('Main Bot registers all 40 owner-only commands under /admin, supports interactive buttons/prompts, and blocks non-owners', async () => {
  const pool = createMockMainPool();
  const config = {
    mainBotToken: '123456:TESTTOKEN',
    adminIds: [1],
    tokenEncryptionKey: randomBytes(32).toString('base64'),
    deliveryManager: { list: async () => [] },
  };
  const bot = createMainBot(config, { warn() {}, error() {}, info() {} }, pool);
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Main', username: 'FileStoreMainBot' };
  bot.telegram.callApi = async (method) => (method === 'getMe' ? bot.botInfo : true);

  const sent = [];
  const edited = [];
  const cbAnswers = [];
  bot.context.reply = async function (text, extra) {
    sent.push({ chatId: this.chat?.id, text, extra });
    return { message_id: 10 };
  };
  bot.context.editMessageText = async function (text, extra) {
    edited.push({ chatId: this.chat?.id, text, extra });
    return { message_id: 10 };
  };
  bot.context.answerCbQuery = async function (text, extra) {
    cbAnswers.push({ text, extra });
    return true;
  };
  bot.context.deleteMessage = async () => true;

  // Every documented owner command must be wired into adminRouter
  const expectedCommands = OWNER_COMMAND_CATEGORIES.flatMap((c) => c.commands.map((cmd) => cmd.name)).sort();
  const registeredCommands = bot.adminRouter.listSubcommands();
  assert.equal(expectedCommands.length, 40);
  assert.deepEqual(registeredCommands, expectedCommands);

  // Non-owner is blocked on /admin, subcommands, and interactive callbacks
  await bot.handleUpdate(makeTextUpdate(999, '/admin', 1));
  await bot.handleUpdate(makeTextUpdate(999, '/admin help', 2));
  await bot.handleUpdate(makeTextUpdate(999, '/admin status', 3));
  await bot.handleUpdate(makeTextUpdate(999, '/admin delivery_jobs', 4));
  await bot.handleUpdate(makeTextUpdate(999, '/admin paid_confirm ABC 123', 5));
  await bot.handleUpdate(makeTextUpdate(999, '/admin batch_confirm XYZ 123', 6));
  await bot.handleUpdate(makeTextUpdate(999, '/admin withdraw_approve 5 UTR999', 7));
  assert.equal(sent.length, 7);
  for (const m of sent) {
    assert.match(m.text, /restricted to the platform owner/i);
  }

  for (const [idx, cb] of ['cc:admin_cmds:home', 'cc:adm_run:status', 'cc:adm_ask:auto_delete', 'cc:adm_cancel:delivery'].entries()) {
    await bot.handleUpdate(makeCallbackUpdate(999, cb, 8 + idx));
    assert.match(cbAnswers[idx]?.text ?? '', /Restricted to platform owner/i);
  }
  assert.equal(edited.length, 0);

  // Owner opens interactive /admin help hub and full list
  const startLen = sent.length;
  await bot.handleUpdate(makeTextUpdate(1, '/admin help', 20));
  assert.match(sent[startLen].text, /Owner Admin Commands/);
  assert.match(sent[startLen].text, /\/admin withdrawals/);
  assert.ok(sent[startLen].extra?.reply_markup?.inline_keyboard?.some((r) => r.some((b) => b.callback_data === 'cc:adm_run:status')));

  await bot.handleUpdate(makeTextUpdate(1, '/admin status', 21));
  assert.match(sent[startLen + 1].text, /FileStore Live Status/);

  await bot.handleUpdate(makeTextUpdate(1, '/admin /delivery_jobs', 22));
  assert.match(sent[startLen + 2].text, /No delivery jobs found yet/);

  await bot.handleUpdate(makeTextUpdate(1, '/admin auto_delete 999999', 23));
  assert.match(sent[startLen + 3].text, /Usage: \/admin auto_delete/);

  await bot.handleUpdate(makeTextUpdate(1, '/admin nonexistent_cmd', 24));
  assert.match(sent[startLen + 4].text, /Unknown admin command/);

  // Owner navigates interactive categories
  await bot.handleUpdate(makeCallbackUpdate(1, 'cc:admin_cmds:payments', 25));
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Payment Gateways/);
  assert.ok(edited[0].extra?.reply_markup?.inline_keyboard?.some((r) => r.some((b) => b.callback_data === 'cc:adm_run:payment_analytics')));

  // Owner runs one-tap action (cc:adm_run:payment_disable:fampay)
  const beforeRun = sent.length;
  await bot.handleUpdate(makeCallbackUpdate(1, 'cc:adm_run:payment_disable:fampay', 26));
  assert.match(sent[beforeRun].text, /Disabled fampay/);
  assert.ok(sent[beforeRun].extra?.reply_markup?.inline_keyboard?.some((r) => r.some((b) => b.callback_data === 'cc:admin_cmds:home')));

  // Owner launches guided prompt (cc:adm_ask:auto_delete) and sends plain text reply "30"
  const beforeEdit = edited.length;
  await bot.handleUpdate(makeCallbackUpdate(1, 'cc:adm_ask:auto_delete', 27));
  assert.equal(edited.length, beforeEdit + 1);
  assert.match(edited[beforeEdit].text, /Set Global Auto-Delete Delay/);
  assert.ok(bot.adminRouter.getActivePrompt(1));

  const beforeReply = sent.length;
  await bot.handleUpdate(makeTextUpdate(1, '30', 28));
  assert.equal(bot.adminRouter.getActivePrompt(1), null);
  assert.match(sent[beforeReply].text, /Auto-delete enabled!.*30 minute/);
  assert.ok(sent[beforeReply].extra?.reply_markup?.inline_keyboard?.some((r) => r.some((b) => b.callback_data === 'cc:adm_ask:auto_delete')));

  // /cancel clears active interactive admin prompt
  await bot.handleUpdate(makeCallbackUpdate(1, 'cc:adm_ask:delivery_retry', 29));
  assert.ok(bot.adminRouter.getActivePrompt(1));
  const beforeCancel = sent.length;
  await bot.handleUpdate(makeTextUpdate(1, '/cancel', 30));
  assert.equal(bot.adminRouter.getActivePrompt(1), null);
  assert.match(sent[beforeCancel].text, /Action Cancelled/);
});

test('Main Bot /admin fails closed when adminIds is empty', async () => {
  const pool = createMockMainPool();
  const bot = createMainBot(
    { mainBotToken: '123456:TESTTOKEN', adminIds: [], deliveryManager: { list: async () => [] } },
    { warn() {}, error() {}, info() {} },
    pool,
  );
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Main', username: 'FileStoreMainBot' };
  const sent = [];
  bot.context.reply = async function (text) {
    sent.push(text);
    return { message_id: 1 };
  };
  await bot.handleUpdate(makeTextUpdate(1, '/admin status', 1));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /restricted to the platform owner/i);
});

test('Delivery Bot consolidates interactive owner diagnostics under /admin and removes standalone commands', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM delivery_jobs')) {
        return {
          rows: [{ pending: 2, processing: 0, completed: 15, failed: 0, uncertain: 0 }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM storage_channels') || sql.includes('FROM force_sub_channels')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const { bot } = createDeliveryBot(
    { adminIds: [1], deliveryBotToken: '123456:DELIVERYTOKEN' },
    { warn() {}, error() {}, info() {} },
    pool,
    '123456:DELIVERYTOKEN',
  );
  bot.botInfo = { id: 654321, is_bot: true, first_name: 'Delivery', username: 'FileStoreDelivBot' };
  bot.telegram.callApi = async (method) => (method === 'getMe' ? bot.botInfo : true);

  const sent = [];
  const edited = [];
  bot.context.reply = async function (text, extra) {
    sent.push({ text, extra });
    return { message_id: 1 };
  };
  bot.context.editMessageText = async function (text, extra) {
    edited.push({ text, extra });
    return { message_id: 1 };
  };
  bot.context.answerCbQuery = async () => true;

  // Non-owner blocked on Delivery Bot /admin and dbadm callbacks
  await bot.handleUpdate(makeTextUpdate(888, '/admin', 1));
  await bot.handleUpdate(makeTextUpdate(888, '/admin status', 2));
  await bot.handleUpdate(makeTextUpdate(888, '/admin test', 3));
  await bot.handleUpdate(makeCallbackUpdate(888, 'dbadm:status', 4));
  assert.equal(edited.length, 0);
  for (const item of sent) {
    assert.doesNotMatch(item.text, /Delivery Bot Owner Admin|Delivery Queue Status|Delivery Bot Permission Test/i);
    assert.match(item.text, /restricted to the platform owner|Open a valid FileStore share link/i);
  }

  // Standalone /delivery_status and /delivery_test no longer respond
  const beforeStandalone = sent.length;
  await bot.handleUpdate(makeTextUpdate(1, '/delivery_status', 5));
  await bot.handleUpdate(makeTextUpdate(1, '/delivery_test', 6));
  assert.equal(sent.length, beforeStandalone, 'Standalone /delivery_status and /delivery_test must not be registered');

  // Owner can open interactive /admin menu and tap dbadm:status, dbadm:test, and dbadm:home
  await bot.handleUpdate(makeTextUpdate(1, '/admin', 7));
  assert.match(sent[beforeStandalone].text, /Delivery Bot Owner Admin/);
  assert.ok(sent[beforeStandalone].extra?.reply_markup?.inline_keyboard?.some((r) => r.some((b) => b.callback_data === 'dbadm:status')));

  await bot.handleUpdate(makeCallbackUpdate(1, 'dbadm:status', 8));
  assert.match(edited[0].text, /Delivery Queue Status/);
  assert.match(edited[0].text, /Pending:.*2/);

  await bot.handleUpdate(makeCallbackUpdate(1, 'dbadm:test', 9));
  assert.match(edited[1].text, /Delivery Bot Permission Test/);

  await bot.handleUpdate(makeCallbackUpdate(1, 'dbadm:home', 10));
  assert.match(edited[2].text, /Delivery Bot Owner Admin/);
});
