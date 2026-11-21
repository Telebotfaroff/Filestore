import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMainBot } from '../src/bot/main.js';
import { registerControlCenter, buildPublicMenuKeyboard } from '../src/bot/control-center.js';
import { listStorageChannels, setStorageEnabled } from '../src/storage/repository.js';
import { getIndexedFile } from '../src/storage/file-query.js';
import { createDeliveryBot } from '../src/delivery/bot.js';
import { addShortenerProvider, listShortenerProviders } from '../src/access/shortener-repository.js';

function createFakeBot() {
  const commands = [];
  const actions = [];
  const onHandlers = new Map();
  return {
    command(name, handler) { commands.push({ name, handler }); },
    action(pattern, handler) { actions.push({ pattern, handler }); },
    on(event, handler) {
      const key = Array.isArray(event) ? event.join(',') : event;
      const list = onHandlers.get(key) ?? [];
      list.push(handler);
      onHandlers.set(key, list);
    },
    commands,
    actions,
    onHandlers,
  };
}

function findAction(bot, data) {
  for (const entry of bot.actions) {
    if (typeof entry.pattern === 'string' && entry.pattern === data) return { handler: entry.handler, match: [data] };
    if (entry.pattern instanceof RegExp) {
      const m = data.match(entry.pattern);
      if (m) return { handler: entry.handler, match: m };
    }
  }
  return null;
}

test('buildPublicMenuKeyboard stays within 64-byte callback_data limit and excludes Owner-only buttons', () => {
  const kb = buildPublicMenuKeyboard();
  const buttons = kb.inline_keyboard.flat();
  const forbidden = new Set(['cc:dash', 'cc:health', 'cc:plans', 'cc:payments', 'cc:autodel', 'cc:wdq:pending:0', 'cc:jobs']);
  for (const btn of buttons) {
    assert.ok(!forbidden.has(btn.callback_data), `Public menu must not expose Owner-only callback ${btn.callback_data}`);
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `callback_data too long: ${btn.callback_data}`);
  }
  assert.ok(buttons.some((b) => b.callback_data === 'cc:me'));
  assert.ok(buttons.some((b) => b.callback_data === 'cc:storage'));
  assert.ok(buttons.some((b) => b.callback_data === 'cc:bots'));
  assert.ok(buttons.some((b) => b.callback_data === 'cc:short'));
});

test('Main Bot opens private chat to public creators while protecting Owner-only commands and callbacks', async () => {
  const upsertedIds = [];
  const pool = {
    query: async (sql, params = []) => {
      if (sql.includes('INSERT INTO users')) {
        upsertedIds.push(Number(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM users WHERE telegram_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM files WHERE status')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (sql.includes('FROM storage_channels')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM delivery_bots')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM share_links')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM paid_file_links')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM paid_batch_links')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM creator_wallets')) return { rows: [{ currency: 'INR', available_minor: 5000, locked_minor: 0, total_earned_minor: 5000, total_withdrawn_minor: 0 }], rowCount: 1 };
      if (sql.includes('FROM user_creator_settings')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM wallet_ledger') || sql.includes('FROM withdrawal_requests')) return { rows: [], rowCount: 0 };
      if (sql.includes('AS users_total')) {
        return {
          rows: [{
            users_total: 1, users_active_7d: 1, files_active: 0, files_disabled: 0, storage_channels_active: 0,
            delivery_bots_active: 0, jobs_pending: 0, jobs_processing: 0, jobs_completed: 0, jobs_failed: 0, jobs_uncertain: 0,
            premium_active: 0, paid_file_links_active: 0, paid_batch_links_active: 0, paid_file_requests_pending: 0,
            paid_batch_requests_pending: 0, payments_applied: 0, revenue_by_currency: {}, events_24h: 0,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const config = {
    mainBotToken: '123456:TESTTOKEN',
    adminIds: [1],
    tokenEncryptionKey: randomBytes(32).toString('base64'),
    deliveryManager: { list: async () => [] },
  };
  const mainBot = createMainBot(config, { warn() {}, error() {}, info() {} }, pool);
  mainBot.botInfo = { id: 123456, is_bot: true, first_name: 'Main', username: 'FileStoreMainBot' };
  const sent = [];
  mainBot.context.reply = async function (text, extra) {
    sent.push({ chatId: this.chat?.id, text, extra });
    return { message_id: 10 };
  };
  mainBot.context.answerCbQuery = async () => true;

  const sendPrivateText = (userId, text, updateId) => mainBot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'Creator' },
      text,
      entities: text.startsWith('/') ? [{ offset: 0, length: text.split(' ')[0].length, type: 'bot_command' }] : [],
    },
  });

  // Public creator can open Creator Hub & /me
  await sendPrivateText(4242, '/start', 1);
  await sendPrivateText(4242, '/me', 2);
  assert.ok(upsertedIds.includes(4242));
  assert.match(sent[0].text, /Creator Hub/);
  assert.match(sent[1].text, /Available Balance: 50\.00 INR/);

  // Public creator is blocked from Owner-only /admin command and all subcommands
  for (const [idx, cmd] of [
    '/admin',
    '/admin status',
    '/admin dashboard',
    '/admin payments',
    '/admin fampay_set a|b|c',
    '/admin plans',
    '/admin auto_delete',
    '/admin withdrawals',
  ].entries()) {
    await sendPrivateText(4242, cmd, 10 + idx);
  }
  const denials = sent.slice(2);
  assert.equal(denials.length, 8);
  for (const msg of denials) {
    assert.match(msg.text, /restricted to the platform owner/i);
  }

  // Old standalone owner commands are no longer registered as top-level commands
  const countBeforeOld = sent.length;
  for (const [idx, cmd] of ['/status', '/dashboard', '/payments', '/plans', '/auto_delete', '/withdrawals'].entries()) {
    await sendPrivateText(1, cmd, 30 + idx);
  }
  assert.equal(sent.length, countBeforeOld, 'Standalone owner commands must not execute outside /admin');

  // Group chat message from non-admin is ignored silently
  await mainBot.handleUpdate({
    update_id: 50,
    message: {
      message_id: 50,
      date: Math.floor(Date.now() / 1000),
      chat: { id: -999, type: 'supergroup' },
      from: { id: 4242, is_bot: false, first_name: 'Creator' },
      text: '/start',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });
  assert.equal(sent.length, countBeforeOld);

  // Owner gets full Control Center on /start & /admin, and dashboard via /admin dashboard
  await sendPrivateText(1, '/start', 60);
  await sendPrivateText(1, '/admin', 61);
  await sendPrivateText(1, '/admin dashboard', 62);
  assert.match(sent[countBeforeOld].text, /FileStore Control Center/);
  assert.match(sent[countBeforeOld + 1].text, /FileStore Control Center/);
  assert.match(sent[countBeforeOld + 2].text, /FileStore Dashboard/);
});

test('Control Center rejects Owner-only callbacks for non-admin users', async () => {
  const bot = createFakeBot();
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  registerControlCenter(bot, { adminIds: [1], deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  for (const cb of ['cc:dash', 'cc:payments', 'cc:plans', 'cc:autodel', 'cc:wdq:pending:0', 'cc:prompt:fampay_all']) {
    const action = findAction(bot, cb);
    assert.ok(action, `Expected handler for ${cb}`);
    let alertText = null;
    await action.handler({
      from: { id: 777 },
      match: action.match,
      answerCbQuery: async (text) => { alertText = text; },
      editMessageText: async () => { throw new Error('Should not render panel to non-owner'); },
    });
    assert.match(alertText ?? '', /Restricted to platform owner\/admin/);
  }
});

test('Tenant isolation: repository queries scope storage channels, files, and shorteners by ownerId', async () => {
  const captured = [];
  const query = async (sql, params = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 };
    }
    captured.push({ sql, params });
    if (sql.includes('SELECT role, owner_telegram_id FROM storage_channels')) {
      return { rows: [{ role: 'backup', owner_telegram_id: 4242 }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO shortener_providers')) {
      return { rows: [{ id: 5, name: params[0], base_url: params[1], api_endpoint: params[2], owner_telegram_id: params[12] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  };

  await listStorageChannels(pool, 4242);
  assert.match(captured.at(-1).sql, /owner_telegram_id = \$1/);
  assert.deepEqual(captured.at(-1).params, [4242]);

  await setStorageEnabled(pool, -100123, true, 4242);
  const storageLookup = captured.find((q) => q.sql.includes('SELECT role, owner_telegram_id FROM storage_channels'));
  assert.ok(storageLookup);
  assert.match(storageLookup.sql, /AND owner_telegram_id = \$2/);
  assert.deepEqual(storageLookup.params, [-100123, 4242]);

  await getIndexedFile(pool, 'FILE01', 4242);
  assert.match(captured.at(-1).sql, /AND f\.uploaded_by = \$2/);
  assert.deepEqual(captured.at(-1).params, ['FILE01', 4242]);

  await addShortenerProvider(
    pool,
    { tokenEncryptionKey: randomBytes(32).toString('base64') },
    { name: 'MyShort', baseUrl: 'https://shrinkme.io', apiEndpoint: 'https://shrinkme.io/api', apiKey: 'key12345' },
    4242,
    4242,
  );
  assert.match(captured.at(-1).sql, /owner_telegram_id/);
  assert.equal(captured.at(-1).params[12], 4242);

  await listShortenerProviders(pool, 4242);
  assert.match(captured.at(-1).sql, /WHERE owner_telegram_id = \$1/);
  assert.deepEqual(captured.at(-1).params, [4242]);
});

test('Delivery Bot /start share link enforces creator-scoped force-sub & shortener checkpoint isolation', async () => {
  const queries = [];
  const queuedJobs = [];
  const pool = {
    connect: async () => ({
      query: async (sql, params = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO delivery_jobs')) {
          queuedJobs.push({ userId: params[1], botId: params[3] });
          return { rows: [{ id: 88 }], rowCount: 1 };
        }
        return { rows: [{ id: 1 }], rowCount: 1 };
      },
      release() {},
    }),
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM share_links WHERE link_code')) {
        return {
          rows: [{ id: 10, link_code: 's_creator1', link_type: 'single', title: 'Creator Video', is_enabled: true, created_by: 4242 }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM share_link_items i')) {
        return {
          rows: [{ position: 1, file_id: 99, file_code: 'CR99', file_name: 'Clip.mp4', file_type: 'video', file_size: 1024, file_status: 'active', telegram_message_id: 50, storage_chat_id: -100999, storage_channel_enabled: true }],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT force_sub_enabled FROM user_creator_settings')) {
        return { rows: [{ force_sub_enabled: false }], rowCount: 1 };
      }
      if (sql.includes('SELECT checkpoint_enabled FROM user_creator_settings')) {
        return { rows: [{ checkpoint_enabled: true }], rowCount: 1 };
      }
      if (sql.includes('FROM shortener_providers')) {
        return { rows: [{ id: 1, name: 'TestShort', checkpoint_minutes: 60, verification_mode: 'api_key' }], rowCount: 1 };
      }
      if (sql.includes('FROM creator_checkpoint_states')) {
        // Unlocked only for creator 4242
        return { rows: [{ checkpoint_expires_at: new Date(Date.now() + 3600_000) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const config = {
    adminIds: [1],
    deliveryBotToken: '234567:CREATORBOT',
    tokenEncryptionKey: randomBytes(32).toString('base64'),
  };
  const runtime = createDeliveryBot(
    config,
    { warn() {}, error() {}, info() {} },
    pool,
    config.deliveryBotToken,
    { deliveryBotId: 7, includeGlobal: false },
  );
  runtime.bot.botInfo = { id: 234567, is_bot: true, first_name: 'CreatorBot', username: 'CreatorDeliveryBot' };
  const replies = [];
  runtime.bot.context.reply = async (text, extra) => { replies.push({ text, extra }); return { message_id: 2 }; };

  await runtime.bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 9999, type: 'private' },
      from: { id: 9999, is_bot: false, first_name: 'Viewer' },
      text: '/start s_creator1',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });

  // Confirmed creator-scoped queries ran with creator ID 4242 and queued onto custom delivery bot ID 7
  assert.ok(queries.some((q) => q.sql.includes('force_sub_enabled FROM user_creator_settings') && q.params[0] === 4242));
  assert.ok(queries.some((q) => q.sql.includes('checkpoint_enabled FROM user_creator_settings') && q.params[0] === 4242));
  assert.ok(queries.some((q) => q.sql.includes('FROM creator_checkpoint_states') && q.params[1] === 4242));
  assert.deepEqual(queuedJobs, [{ userId: 9999, botId: 7 }]);
  assert.match(replies[0].text, /Delivery queued/);
});

test('Creator Hub renders rich HTML cards safely and /guide opens interactive multi-chapter user tutorial', async () => {
  const bot = createFakeBot();
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM creator_wallets')) {
        return { rows: [{ currency: 'INR', available_minor: 15000, locked_minor: 2500, total_earned_minor: 30000, total_withdrawn_minor: 12500 }], rowCount: 1 };
      }
      if (sql.includes('FROM user_creator_settings')) {
        return { rows: [{ user_telegram_id: 4242, checkpoint_enabled: true, force_sub_enabled: false, payout_upi_id: 'creator@fam' }], rowCount: 1 };
      }
      if (sql.includes('FROM delivery_bots')) {
        return { rows: [{ username: 'SharedBot' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  registerControlCenter(bot, { adminIds: [1], deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  // 1. Creator Hub home card uses HTML formatting & escapes user display name
  const startCmd = bot.commands.find((c) => c.name === 'start')?.handler;
  let homeReply;
  await startCmd({
    from: { id: 4242, first_name: 'Alice <Pro> & Co' },
    reply: async (text, options) => { homeReply = { text, options }; },
  });
  assert.equal(homeReply.options.parse_mode, 'HTML');
  assert.match(homeReply.text, /FileStore Creator Hub/);
  assert.match(homeReply.text, /Alice &lt;Pro&gt; &amp; Co/);
  assert.match(homeReply.text, /Workspace Overview/);
  assert.match(homeReply.text, /Creator Wallet/);
  assert.match(homeReply.text, /150\.00 INR/);
  assert.match(homeReply.text, /creator@fam/);
  assert.ok(homeReply.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:uguide:overview'));

  // 2. /guide opens overview and every chapter tab renders cleanly within 64-byte callback_data limit
  const guideCmd = bot.commands.find((c) => c.name === 'guide')?.handler;
  assert.ok(guideCmd, '/guide command must be registered');
  let guideReply;
  await guideCmd({
    from: { id: 4242, first_name: 'Alice' },
    reply: async (text, options) => { guideReply = { text, options }; },
  });
  assert.equal(guideReply.options.parse_mode, 'HTML');
  assert.match(guideReply.text, /FileStore User & Creator Guide/);
  assert.match(guideReply.text, /How It Works/);

  for (const chapter of ['overview', 'links', 'paid', 'setup', 'short', 'earn']) {
    const action = findAction(bot, `cc:uguide:${chapter}`);
    assert.ok(action, `Missing guide action for ${chapter}`);
    let edited;
    await action.handler({
      from: { id: 4242 },
      match: action.match,
      answerCbQuery: async () => {},
      editMessageText: async (text, options) => { edited = { text, options }; },
    });
    assert.equal(edited.options.parse_mode, 'HTML');
    for (const btn of edited.options.reply_markup.inline_keyboard.flat()) {
      assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `callback_data too long: ${btn.callback_data}`);
    }
  }
});

