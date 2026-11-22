import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerControlCenter } from '../src/bot/control-center.js';
import { createCreatorBroadcastWorker } from '../src/broadcast/worker.js';
import { getOwnerLinkAnalytics } from '../src/web/link-analytics-repository.js';
import { listPaidFileLinks } from '../src/paid-files/repository.js';
import { listPaidBatchLinks } from '../src/paid-files/batch-repository.js';
import { listShareLinks } from '../src/storage/share-links-repository.js';
import { getPremiumPlanById, listPremiumPlans, setPremiumPlanEnabled } from '../src/premium/repository.js';
import { getCreatorSettings, setCreatorForceSubEnabled } from '../src/wallet/repository.js';
import { registerDeliveryBotManagerCommands } from '../src/delivery/admin-commands.js';
import { issueOrRegenerateAccessToken } from '../src/web/token-repository.js';
import { startHttpServer } from '../src/server.js';
import { clearCache } from '../src/utils/cache.js';

function createFakeBot() {
  const commands = [];
  const actions = [];
  const onHandlers = new Map();
  return {
    telegram: {
      editMessageReplyMarkup: async () => true,
    },
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

test('control-center broadcast detail, manage, and retry actions match numeric IDs, import cleanly, and escape HTML without literal \\n', async () => {
  const bot = createFakeBot();
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM creator_broadcasts b')) {
        return {
          rows: [{
            id: 42,
            owner_telegram_id: 777,
            status: 'paused',
            total_recipients: 10,
            sent_count: 4,
            failed_count: 2,
            pending_count: 4,
            last_error: 'Bad <tag> & detail',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE creator_broadcasts SET status=$3')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT id FROM creator_broadcasts WHERE id=$1')) {
        return { rows: [{ id: 42 }], rowCount: 1 };
      }
      if (sql.includes("UPDATE creator_broadcast_recipients SET status='pending'")) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('FROM creator_broadcasts WHERE owner_telegram_id=$1')) {
        return {
          rows: [{
            id: 42,
            delivery_bot_id: 9,
            status: 'paused',
            total_recipients: 10,
            sent_count: 4,
            failed_count: 2,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql, params = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        calls.push({ sql, params });
        if (sql.includes('SELECT id FROM creator_broadcasts WHERE id=$1')) return { rows: [{ id: 42 }], rowCount: 1 };
        if (sql.includes("UPDATE creator_broadcast_recipients SET status='pending'")) return { rows: [], rowCount: 2 };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  };

  registerControlCenter(bot, { adminIds: [1], deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  // History view: no literal "\n"
  const historyAction = findAction(bot, 'cc:broadcast_history');
  assert.ok(historyAction);
  let editedText = '';
  await historyAction.handler({
    from: { id: 777 },
    match: historyAction.match,
    answerCbQuery: async () => true,
    editMessageText: async (text) => { editedText = text; },
  });
  assert.doesNotMatch(editedText, /\\n/);

  // Detail regex matches numeric ID 42, calls getCreatorBroadcast, escapes HTML error
  const detailAction = findAction(bot, 'cc:broadcast_detail:42');
  assert.ok(detailAction, 'cc:broadcast_detail:42 must match regex');
  let detailText = '';
  await detailAction.handler({
    from: { id: 777 },
    match: detailAction.match,
    answerCbQuery: async () => true,
    editMessageText: async (text) => { detailText = text; },
  });
  assert.doesNotMatch(detailText, /\\n/);
  assert.match(detailText, /Broadcast #42/);
  assert.match(detailText, /Bad &lt;tag&gt; &amp; detail/);

  // Manage regex matches numeric ID 42 and calls setCreatorBroadcastStatus
  const manageAction = findAction(bot, 'cc:broadcast_manage:paused:42');
  assert.ok(manageAction, 'cc:broadcast_manage:paused:42 must match regex');
  let manageAlert = '';
  await manageAction.handler({
    from: { id: 777 },
    chat: { id: 777 },
    callbackQuery: { message: { message_id: 99 } },
    match: manageAction.match,
    answerCbQuery: async (txt) => { manageAlert = txt; },
  });
  assert.equal(manageAlert, 'Broadcast updated.');

  // Retry regex matches numeric ID 42 and calls retryCreatorBroadcast
  const retryAction = findAction(bot, 'cc:broadcast_retry:42');
  assert.ok(retryAction, 'cc:broadcast_retry:42 must match regex');
  let retryAlert = '';
  let retryView = '';
  await retryAction.handler({
    from: { id: 777 },
    match: retryAction.match,
    answerCbQuery: async (txt) => { retryAlert = txt; },
    editMessageText: async (text) => { retryView = text; },
  });
  assert.match(retryAlert, /Retry queued for 2 failed recipient/);
  assert.match(retryView, /Retry requested for Broadcast #42/);
});

test('broadcast worker passes [job.id, sanitizedError] in error fallback and fetches media once per campaign', async () => {
  const updates = [];
  let claimedOnce = false;
  const pool = {
    query: async (sql, params = []) => {
      if (sql.includes("UPDATE creator_broadcasts SET status='pending',last_error=$2 WHERE id=$1")) {
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE creator_broadcasts SET status='processing'")) {
        if (claimedOnce) return { rows: [], rowCount: 0 };
        claimedOnce = true;
        return {
          rows: [{
            id: 91,
            delivery_bot_id: 5,
            owner_telegram_id: 777,
            message_text: '',
            media_type: 'photo',
            media_file_id: 'FILE_ID_1',
            caption: 'Promo!',
            buttons: [[{ text: 'Open', url: 'https://example.com' }]],
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT status FROM creator_broadcasts')) return { rows: [{ status: 'processing' }], rowCount: 1 };
      if (sql.includes('WITH picked AS')) {
        return claimedOnce === 'done'
          ? { rows: [], rowCount: 0 }
          : (claimedOnce = 'done', { rows: [{ telegram_user_id: 1001 }, { telegram_user_id: 1002 }], rowCount: 2 });
      }
      if (sql.includes('UPDATE creator_broadcast b SET status=')) return { rows: [{ status: 'completed' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 1 }),
      release() {},
    }),
  };

  // Case 1: unavailable sourceTelegram triggers fallback UPDATE with [job.id, error] and redacts token
  const workerNoSrc = createCreatorBroadcastWorker(
    { sendPhoto: async () => {} },
    pool,
    { warn() {}, error() {}, info() {} },
    5,
    () => null,
  );
  workerNoSrc.start();
  await new Promise((r) => setTimeout(r, 40));
  workerNoSrc.stop();

  assert.equal(updates.length, 1);
  assert.equal(typeof updates[0].params[0], 'number');
  assert.equal(updates[0].params[0], 91);
  assert.match(updates[0].params[1], /Media source bot is unavailable/);

  // Case 2: callable sourceTelegram fetches media file once and delivers Buffer payloads to recipients
  let getFileLinkCalls = 0;
  const sentPhotos = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  try {
    claimedOnce = false;
    const workerWithSrc = createCreatorBroadcastWorker(
      { sendPhoto: async (uid, payload, opts) => { sentPhotos.push({ uid, payload, opts }); } },
      pool,
      { warn() {}, error() {}, info() {} },
      5,
      () => ({ getFileLink: async () => { getFileLinkCalls += 1; return 'https://api.telegram.org/file/bot123456:SECRET/photo.jpg'; } }),
    );
    workerWithSrc.start();
    await new Promise((r) => setTimeout(r, 320));
    workerWithSrc.stop();
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(getFileLinkCalls, 1);
  assert.equal(sentPhotos.length, 2);
  assert.ok(Buffer.isBuffer(sentPhotos[0].payload.source));
  assert.equal(sentPhotos[0].opts.caption, 'Promo!');
});

test('owner link analytics joins files table and global link list queries include view_count', async () => {
  const capturedSql = [];
  const pool = {
    query: async (sql) => {
      capturedSql.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };

  await getOwnerLinkAnalytics(pool, 25);
  assert.match(capturedSql[0], /JOIN files f ON f\.id=pfl\.file_id/);
  assert.doesNotMatch(capturedSql[0], /SELECT id,public_code AS code,file_name AS title/);

  await listPaidFileLinks(pool, 10, null);
  assert.match(capturedSql[1], /link_open_events[\s\S]*AS view_count/);

  await listPaidBatchLinks(pool, 10, null);
  assert.match(capturedSql[2], /link_open_events[\s\S]*AS view_count/);

  await listShareLinks(pool, { limit: 10, offset: 0, ownerId: null });
  assert.match(capturedSql[4], /link_open_events[\s\S]*AS view_count/);
});

test('premium plan and wallet creator settings caches do not self-invalidate on read and invalidate properly on mutations', async () => {
  clearCache();
  let planReads = 0;
  let listReads = 0;
  let settingsReads = 0;
  const pool = {
    query: async (sql, params = []) => {
      if (sql.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT id, name, price_minor, currency, duration_days, is_enabled, owner_telegram_id FROM premium_plans WHERE id = $1')) {
        planReads += 1;
        return { rows: [{ id: 7, name: 'Creator VIP', owner_telegram_id: 500 }], rowCount: 1 };
      }
      if (sql.includes('FROM premium_plans')) {
        listReads += 1;
        return { rows: [{ id: 7, name: 'Creator VIP', owner_telegram_id: 500, is_enabled: false }], rowCount: 1 };
      }
      if (sql.includes('UPDATE premium_plans SET is_enabled')) {
        return { rows: [{ id: 7, name: 'Creator VIP', is_enabled: params[1], owner_telegram_id: 500 }], rowCount: 1 };
      }
      if (sql.includes('SELECT user_telegram_id, checkpoint_enabled, force_sub_enabled')) {
        settingsReads += 1;
        return { rows: [{ user_telegram_id: 500, checkpoint_enabled: false, force_sub_enabled: true, payout_upi_id: null }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO user_creator_settings')) {
        return { rows: [{ user_telegram_id: 500, checkpoint_enabled: false, force_sub_enabled: params[1], payout_upi_id: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  await getPremiumPlanById(pool, 7, 500);
  await getPremiumPlanById(pool, 7, 500);
  assert.equal(planReads, 1, 'getPremiumPlanById should cache repeated reads');

  await listPremiumPlans(pool, 500);
  await listPremiumPlans(pool, 500);
  assert.equal(listReads, 1);

  // Toggling without explicit ownerId must still invalidate creator 500's plan cache
  await setPremiumPlanEnabled(pool, 7, false);
  await listPremiumPlans(pool, 500);
  assert.equal(listReads, 2);

  await getCreatorSettings(pool, 500);
  await getCreatorSettings(pool, 500);
  assert.equal(settingsReads, 1);
  await setCreatorForceSubEnabled(pool, 500, false);
  await getCreatorSettings(pool, 500);
  assert.equal(settingsReads, 2);
  clearCache();
});

test('api-router uses pbatch_ link prefix and web panel views use responsive data-table and kpi-grid classes', async () => {
  const apiRouterSrc = await readFile(new URL('../src/web/api-router.js', import.meta.url), 'utf8');
  const appJsSrc = await readFile(new URL('../src/web/public/app.js', import.meta.url), 'utf8');

  assert.match(apiRouterSrc, /\?start=pbatch_\$\{r\.public_code\}/);
  assert.doesNotMatch(apiRouterSrc, /\?start=batch_\$\{r\.public_code\}/);

  assert.doesNotMatch(appJsSrc, /class="page-head"/);
  assert.doesNotMatch(appJsSrc, /class="stats-grid"/);
  assert.match(appJsSrc, /data-label="Last Seen"/);
  assert.match(appJsSrc, /data-label="Days Left"/);
  assert.match(appJsSrc, /data-label="Unique Viewers"/);
});

test('creators adding a delivery bot are warned they must add their own storage channel, and forwarding a channel post connects storage', async () => {
  clearCache();
  const bot = createFakeBot();
  bot.telegram.getMe = async () => ({ id: 999, username: 'Filestore_advbot' });
  bot.telegram.getChat = async (id) => ({ id: Number(id), type: 'channel', title: 'Creator Vault', username: null });
  bot.telegram.getChatMember = async () => ({ status: 'administrator', can_post_messages: true });

  const savedChannels = [];
  const pool = {
    query: async (sql, params = []) => {
      if (sql.includes('FROM storage_channels') && sql.includes('owner_telegram_id = $1')) {
        return { rows: savedChannels.filter((c) => c.owner_telegram_id === params[0]), rowCount: savedChannels.length };
      }
      if (sql.includes('FROM storage_channels') && sql.includes('owner_telegram_id IS NULL')) {
        return { rows: [{ id: 1, telegram_chat_id: -1001, title: 'Platform', is_enabled: true }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO storage_channels')) {
        const row = { id: 10, telegram_chat_id: params[0], title: params[1], is_enabled: true, owner_telegram_id: params[5] };
        savedChannels.push(row);
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql, params = []) => {
        if (sql.includes('COUNT(*)::int AS total FROM storage_channels')) return { rows: [{ total: 0 }], rowCount: 1 };
        if (sql.includes('COALESCE(MAX(priority), 0)::int AS priority')) return { rows: [{ priority: 0 }], rowCount: 1 };
        if (sql.includes('FROM storage_channels')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO storage_channels')) {
          const row = { id: 10, telegram_chat_id: params[0], title: params[1], is_enabled: true, owner_telegram_id: params[6] ?? null };
          savedChannels.push(row);
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    }),
  };

  const deliveryManager = {
    list: async () => [],
    addToken: async () => ({ id: 5, username: 'CreatorDeliveryBot', role: 'primary', runtime_status: 'running' }),
  };

  registerControlCenter(bot, { adminIds: [1], deliveryManager }, { warn() {}, error() {}, info() {} }, pool);
  registerDeliveryBotManagerCommands(bot, deliveryManager, { warn() {}, error() {}, info() {} }, pool, { adminIds: [1] });

  // 1. Creator viewing Delivery Bots without own storage sees required warning + Add Storage Channel button
  const botsAction = findAction(bot, 'cc:bots');
  let botsView = null;
  await botsAction.handler({
    from: { id: 505 },
    answerCbQuery: async () => {},
    editMessageText: async (text, opts) => { botsView = { text, opts }; },
  });
  assert.match(botsView.text, /MUST also add your own Storage Channel/);
  assert.match(botsView.text, /will NOT work/);
  assert.ok(botsView.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:prompt:storage_add'));

  // 2. Creator tapping Add Delivery Bot sees mandatory storage notice before sending token
  const promptBotAction = findAction(bot, 'cc:prompt:delivery_bot_add');
  let promptBotView = null;
  await promptBotAction.handler({
    from: { id: 505 },
    match: promptBotAction.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, opts) => { promptBotView = { text, opts }; },
  });
  assert.match(promptBotView.text, /MUST add your own Storage Channel/);
  assert.ok(promptBotView.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:prompt:storage_add'));

  const runOnHandlers = async (event, ctx) => {
    const handlers = bot.onHandlers.get(event) ?? [];
    let idx = 0;
    const next = async () => {
      if (idx >= handlers.length) return undefined;
      const fn = handlers[idx++];
      return fn(ctx, next);
    };
    return next();
  };

  // 3. Creator submitting Delivery Bot token without storage gets ACTION REQUIRED warning + Add Storage Channel Now button
  let botAddedReply = null;
  await runOnHandlers('text', {
    from: { id: 505 },
    message: { text: '123456:FAKE_TOKEN_FOR_TEST' },
    deleteMessage: async () => {},
    reply: async (text, opts) => { botAddedReply = { text, opts }; },
  });
  assert.match(botAddedReply.text, /ACTION REQUIRED/);
  assert.match(botAddedReply.text, /will NOT work/);
  assert.ok(botAddedReply.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:prompt:storage_add'));

  // 4. /delivery_bot_add slash command without token also warns creator
  const cmdAdd = bot.commands.find((c) => c.name === 'delivery_bot_add');
  let cmdUsageReply = '';
  await cmdAdd.handler({
    from: { id: 505 },
    message: { text: '/delivery_bot_add' },
    reply: async (text) => { cmdUsageReply = text; },
  });
  assert.match(cmdUsageReply, /MUST also add your own Storage Channel/);

  // 5. Creator forwarding a channel post during storage_add saves the channel
  const promptStgAction = findAction(bot, 'cc:prompt:storage_add');
  await promptStgAction.handler({
    from: { id: 505 },
    match: promptStgAction.match,
    telegram: bot.telegram,
    answerCbQuery: async () => {},
    editMessageText: async () => {},
  });
  let fwdReply = '';
  await runOnHandlers('message', {
    from: { id: 505 },
    telegram: bot.telegram,
    message: { forward_origin: { type: 'channel', chat: { id: -100888777666, type: 'channel', title: 'Creator Vault' } } },
    reply: async (text) => { fwdReply = text; },
  });
  assert.match(fwdReply, /Storage Channel Connected/);
  assert.equal(savedChannels.length, 1);
  assert.equal(savedChannels[0].telegram_chat_id, -100888777666);
  clearCache();
});

test('owner All Delivery Bots web API & UI expose list, total users, details, edit, test, and remove with strict owner RBAC', async () => {
  clearCache();
  const ownerId = 101;
  const creatorId = 202;
  const tokens = new Map();
  const users = new Map([
    [ownerId, { telegram_id: ownerId, username: 'ownerboss', first_name: 'Owner' }],
    [creatorId, { telegram_id: creatorId, username: 'alice', first_name: 'Alice' }],
  ]);
  const bots = [
    {
      id: 11,
      telegram_bot_id: 90011,
      username: 'PlatformDeliveryBot',
      role: 'primary',
      priority: 0,
      is_enabled: true,
      runtime_status: 'running',
      last_health_at: '2026-11-20T10:00:00.000Z',
      last_error: null,
      created_by: ownerId,
      owner_telegram_id: null,
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-20T10:00:00.000Z',
      owner_username: null,
      owner_first_name: null,
      owner_last_name: null,
      total_users: 42,
      active_users_7d: 19,
      total_interactions: 150,
      last_user_seen_at: '2026-11-20T09:30:00.000Z',
      jobs_total: 80,
      jobs_completed: 78,
      jobs_failed: 2,
      jobs_pending: 0,
      storage_channels_count: 1,
    },
    {
      id: 12,
      telegram_bot_id: 90012,
      username: 'AliceDeliveryBot',
      role: 'backup',
      priority: 25,
      is_enabled: true,
      runtime_status: 'running',
      last_health_at: '2026-11-20T10:05:00.000Z',
      last_error: null,
      created_by: creatorId,
      owner_telegram_id: creatorId,
      created_at: '2026-11-05T00:00:00.000Z',
      updated_at: '2026-11-20T10:05:00.000Z',
      owner_username: 'alice',
      owner_first_name: 'Alice',
      owner_last_name: null,
      total_users: 14,
      active_users_7d: 6,
      total_interactions: 33,
      last_user_seen_at: '2026-11-20T08:00:00.000Z',
      jobs_total: 20,
      jobs_completed: 19,
      jobs_failed: 1,
      jobs_pending: 0,
      storage_channels_count: 1,
    },
  ];

  const pool = {
    async query(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (n.startsWith('INSERT INTO web_access_tokens')) {
        const [uid, tokenHash, tokenPrefix] = params;
        const row = { telegram_user_id: uid, token_hash: tokenHash, token_prefix: tokenPrefix, created_at: new Date().toISOString(), rotated_at: new Date().toISOString(), last_used_at: null, is_new: true };
        tokens.set(uid, row);
        return { rows: [row], rowCount: 1 };
      }
      if (n.includes('FROM web_access_tokens t JOIN users u')) {
        for (const r of tokens.values()) {
          if (r.token_hash === params[0]) {
            const u = users.get(r.telegram_user_id) || {};
            return { rows: [{ ...r, username: u.username ?? null, first_name: u.first_name ?? null }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }
      if (n.startsWith('UPDATE web_access_tokens SET last_used_at')) return { rows: [], rowCount: 1 };
      if (n.includes('SELECT 1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (n.includes('FROM delivery_bots d') && n.includes('WHERE d.id = $1')) {
        const found = bots.find((b) => b.id === Number(params[0]));
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      if (n.includes('FROM delivery_bots d') && n.includes('LIMIT 500')) {
        return { rows: bots, rowCount: bots.length };
      }
      if (n.includes('AS unique_bot_users FROM delivery_bot_user_activity')) {
        return { rows: [{ unique_bot_users: 51 }], rowCount: 1 };
      }
      if (n.includes('FROM delivery_bot_user_activity a')) {
        return { rows: [{ telegram_user_id: 7001, username: 'viewer1', first_name: 'Viewer', last_name: null, is_blocked: false, interaction_count: 5, first_seen_at: '2026-11-10T00:00:00.000Z', last_seen_at: '2026-11-20T08:00:00.000Z' }], rowCount: 1 };
      }
      if (n.includes('FROM storage_channels') && n.includes('LIMIT 20')) {
        return { rows: [{ id: 1, telegram_chat_id: -100123, title: 'Vault', username: null, role: 'primary', is_enabled: true, last_test_status: 'ok' }], rowCount: 1 };
      }
      if (n.includes('FROM force_sub_channels') && n.includes('LIMIT 20')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const removedIds = [];
  const deliveryManager = {
    async setPriority(id, prio) {
      const b = bots.find((x) => x.id === Number(id));
      if (b) b.priority = prio;
    },
    async setEnabled(id, en) {
      const b = bots.find((x) => x.id === Number(id));
      if (b) { b.is_enabled = en; b.runtime_status = en ? 'running' : 'paused'; }
    },
    async promotePrimary(id) {
      const b = bots.find((x) => x.id === Number(id));
      if (!b || !b.is_enabled) return false;
      b.role = 'primary';
      b.priority = 0;
      return true;
    },
    async pause(id) {
      const b = bots.find((x) => x.id === Number(id));
      if (!b) return false;
      b.runtime_status = 'paused';
      return true;
    },
    async resume(id) {
      const b = bots.find((x) => x.id === Number(id));
      if (!b) return false;
      b.is_enabled = true;
      b.runtime_status = 'running';
      return true;
    },
    async restart() { return true; },
    async test(id) {
      const b = bots.find((x) => x.id === Number(id));
      return { bot: { id: b.id, username: b.username, first_name: b.username }, checks: [{ chatId: -100123, status: 'ok' }] };
    },
    async remove(id) {
      const idx = bots.findIndex((x) => x.id === Number(id));
      if (idx === -1) return false;
      bots.splice(idx, 1);
      removedIds.push(Number(id));
      return true;
    },
  };

  const ownerToken = (await issueOrRegenerateAccessToken(pool, ownerId, { username: 'ownerboss', first_name: 'Owner' })).token;
  const creatorToken = (await issueOrRegenerateAccessToken(pool, creatorId, { username: 'alice', first_name: 'Alice' })).token;
  const server = await startHttpServer({
    port: 0,
    nodeEnv: 'test',
    database: 'connected',
    telegram: 'connected',
    delivery: 'connected',
    botUsername: 'Filestore_testbot',
    pool,
    config: { adminIds: [ownerId] },
    deliveryManager,
  }, { info() {}, warn() {}, error() {} });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;

    // Creator must receive 403 on all owner bot endpoints
    for (const [method, p] of [
      ['GET', '/api/panel/owner/bots'],
      ['GET', '/api/panel/owner/bots/12'],
      ['PATCH', '/api/panel/owner/bots/12'],
      ['POST', '/api/panel/owner/bots/12/test'],
      ['DELETE', '/api/panel/owner/bots/12'],
    ]) {
      const forbidden = await fetch(`${base}${p}`, {
        method,
        headers: { Authorization: `Bearer ${creatorToken}`, ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}) },
        body: method === 'PATCH' ? JSON.stringify({ priority: 5 }) : undefined,
      });
      assert.equal(forbidden.status, 403, `creator must be blocked on ${method} ${p}`);
    }

    // Owner lists all delivery bots with totalUsers and no secret fields
    const listRes = await fetch(`${base}/api/panel/owner/bots`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.total, 2);
    assert.equal(listJson.summary.uniqueBotUsers, 51);
    assert.equal(listJson.rows[0].totalUsers, 42);
    assert.equal(listJson.rows[1].totalUsers, 14);
    assert.equal(listJson.rows[1].token_ciphertext, undefined);

    // Owner views single bot details
    const detailRes = await fetch(`${base}/api/panel/owner/bots/12`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(detailRes.status, 200);
    const detailJson = await detailRes.json();
    assert.equal(detailJson.bot.username, 'AliceDeliveryBot');
    assert.equal(detailJson.bot.totalUsers, 14);
    assert.equal(detailJson.recentUsers.length, 1);
    assert.equal(detailJson.storageChannels.length, 1);

    // Owner edits priority and disables/enables
    const patchRes = await fetch(`${base}/api/panel/owner/bots/12`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 7, isEnabled: false }),
    });
    assert.equal(patchRes.status, 200);
    const patchJson = await patchRes.json();
    assert.equal(patchJson.bot.priority, 7);
    assert.equal(patchJson.bot.isEnabled, false);

    // Owner tests bot access
    const testRes = await fetch(`${base}/api/panel/owner/bots/12/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(testRes.status, 200);
    const testJson = await testRes.json();
    assert.equal(testJson.ok, true);
    assert.equal(testJson.checks[0].status, 'ok');

    // Owner deletes bot
    const delRes = await fetch(`${base}/api/panel/owner/bots/12`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(delRes.status, 200);
    assert.deepEqual(removedIds, [12]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const appJsSrc = await readFile(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.match(appJsSrc, /All Delivery Bots/);
  assert.match(appJsSrc, /data-bot-view=/);
  assert.match(appJsSrc, /data-bot-edit=/);
  assert.match(appJsSrc, /data-bot-users=/);
  assert.match(appJsSrc, /data-label="Total Users"/);
  clearCache();
});

test('Telegram control center cc:all_bots and cc:all_bot views/edits enforce owner RBAC and show total users', async () => {
  const bot = createFakeBot();
  const botRow = {
    id: 12,
    telegram_bot_id: 90012,
    username: 'CreatorMediaBot',
    role: 'backup',
    priority: 100,
    is_enabled: true,
    runtime_status: 'running',
    last_health_at: '2026-11-20T10:00:00.000Z',
    last_error: null,
    owner_telegram_id: 505,
    owner_username: 'creator505',
    owner_first_name: 'Maya',
    owner_last_name: null,
    total_users: 14,
    active_users_7d: 6,
    total_interactions: 33,
    jobs_total: 10,
    jobs_completed: 9,
    jobs_failed: 1,
    jobs_pending: 0,
    storage_channels_count: 1,
  };
  const pool = {
    async query(sql) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.includes('FROM delivery_bots d') && n.includes('WHERE d.id = $1')) return { rows: [botRow], rowCount: 1 };
      if (n.includes('FROM delivery_bots d') && n.includes('LIMIT 500')) return { rows: [botRow], rowCount: 1 };
      if (n.includes('AS unique_bot_users FROM delivery_bot_user_activity')) return { rows: [{ unique_bot_users: 14 }], rowCount: 1 };
      if (n.includes('FROM delivery_bot_user_activity a')) return { rows: [{ telegram_user_id: 7001, username: 'fan1', first_name: 'Fan', interaction_count: 4 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  let updatedPriority = null;
  const deliveryManager = {
    list: async () => [],
    setPriority: async (id, prio) => { botRow.priority = prio; updatedPriority = prio; },
  };
  registerControlCenter(bot, { adminIds: [1], deliveryManager }, { warn() {}, error() {} }, pool);

  // Non-owner blocked from cc:all_bots:0 and cc:all_bot:12
  const allBotsAction = findAction(bot, 'cc:all_bots:0');
  assert.ok(allBotsAction);
  let deniedMsg = '';
  await allBotsAction.handler({
    from: { id: 505 },
    match: allBotsAction.match,
    answerCbQuery: async (txt) => { deniedMsg = txt; },
  });
  assert.match(deniedMsg, /Restricted to platform owner/);

  // Owner views All Delivery Bots list with Total Users & HTML formatting
  let listText = '';
  let listOpts = null;
  await allBotsAction.handler({
    from: { id: 1 },
    match: allBotsAction.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, opts) => { listText = text; listOpts = opts; },
  });
  assert.equal(listOpts?.parse_mode, 'HTML');
  assert.match(listText, /All Delivery Bots \(Owner\)/);
  assert.match(listText, /<blockquote>/);
  assert.match(listText, /@CreatorMediaBot/);
  assert.match(listText, /Total Users: 14/);

  // Owner views bot details
  const detailAction = findAction(bot, 'cc:all_bot:12');
  let detailView = null;
  await detailAction.handler({
    from: { id: 1 },
    match: detailAction.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, opts) => { detailView = { text, opts }; },
  });
  assert.equal(detailView.opts?.parse_mode, 'HTML');
  assert.match(detailView.text, /Delivery Bot #12 \(Owner View\)/);
  assert.match(detailView.text, /Total Users: 14/);
  assert.ok(detailView.opts.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:all_bot_prio:12'));

  // Owner opens Edit Priority prompt and sends numeric priority
  const prioPrompt = findAction(bot, 'cc:all_bot_prio:12');
  await prioPrompt.handler({
    from: { id: 1 },
    match: prioPrompt.match,
    answerCbQuery: async () => {},
    editMessageText: async () => {},
  });
  const textHandlers = bot.onHandlers.get('text') ?? [];
  let prioReply = '';
  const runText = async (ctx) => {
    let i = 0;
    const next = async () => (i < textHandlers.length ? textHandlers[i++](ctx, next) : undefined);
    return next();
  };
  await runText({
    from: { id: 1 },
    message: { text: '15' },
    reply: async (text) => { prioReply = text; },
  });
  assert.equal(updatedPriority, 15);
  assert.match(prioReply, /Priority updated for @CreatorMediaBot/);
});

test('overview API returns 7/30-day overviewStats series and recentActivity, and web UI has no fake promo banners', async () => {
  clearCache();
  const creatorId = 303;
  const tokens = new Map();
  const pool = {
    async query(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (n.startsWith('INSERT INTO web_access_tokens')) {
        const [uid, tokenHash, tokenPrefix] = params;
        const row = { telegram_user_id: uid, token_hash: tokenHash, token_prefix: tokenPrefix, created_at: new Date().toISOString(), rotated_at: new Date().toISOString(), last_used_at: null, is_new: true };
        tokens.set(uid, row);
        return { rows: [row], rowCount: 1 };
      }
      if (n.includes('FROM web_access_tokens t JOIN users u')) {
        for (const r of tokens.values()) {
          if (r.token_hash === params[0]) {
            return { rows: [{ ...r, username: 'creator303', first_name: 'Nadia' }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }
      if (n.startsWith('UPDATE web_access_tokens SET last_used_at')) return { rows: [], rowCount: 1 };
      if (n.includes('SELECT 1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  const creatorToken = (await issueOrRegenerateAccessToken(pool, creatorId, { username: 'creator303', first_name: 'Nadia' })).token;
  const server = await startHttpServer({
    port: 0,
    nodeEnv: 'test',
    database: 'connected',
    telegram: 'connected',
    delivery: 'connected',
    botUsername: 'Filestore_testbot',
    pool,
    config: { adminIds: [1] },
  }, { info() {}, warn() {}, error() {} });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res30 = await fetch(`${base}/api/panel/overview?days=30`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(res30.status, 200);
    const json30 = await res30.json();
    assert.equal(json30.overviewStats?.days, 30);
    assert.equal(Array.isArray(json30.overviewStats?.series), true);
    assert.equal(json30.overviewStats.series.length, 30);
    assert.equal(Array.isArray(json30.recentActivity), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const appJsSrc = await readFile(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  assert.match(appJsSrc, /class="hero-banner"/);
  assert.match(appJsSrc, /class="wallet-hero-card"/);
  assert.match(appJsSrc, /id="overview-days-select"/);
  assert.match(appJsSrc, /recentActivity/);
  assert.doesNotMatch(appJsSrc, /Go Premium|Upgrade Now|Upgrade to Premium/i);
  clearCache();
});

test('creator website setup APIs support bots, channels, shorteners, plans, and broadcasts with strict tenant isolation', async () => {
  clearCache();
  const creatorA = 5101;
  const creatorB = 5102;
  const tokenStore = new Map();
  const bots = [];
  const storageChannels = [];
  const forceSubChannels = [];
  const plans = [];
  const broadcasts = [];
  let starsPrices = {};

  const pool = {
    async connect() {
      return {
        async query(sql, params = []) { return pool.query(sql, params); },
        release() {},
      };
    },
    async query(sql, params = []) {
      const n = sql.replace(/\s+/g, ' ').trim();
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK' || n.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      if (n.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (n.includes('INSERT INTO web_access_tokens')) {
        const record = {
          telegram_user_id: Number(params[0]),
          token_hash: params[1],
          token_prefix: params[2],
          username: 'creator',
          first_name: 'Creator',
          rotated_at: new Date(),
          last_used_at: null,
        };
        tokenStore.set(record.token_hash, record);
        return { rows: [record], rowCount: 1 };
      }
      if (n.includes('FROM web_access_tokens t') && n.includes('WHERE t.token_hash = $1')) {
        const rec = tokenStore.get(params[0]);
        return { rows: rec ? [rec] : [], rowCount: rec ? 1 : 0 };
      }
      if (n.startsWith('UPDATE web_access_tokens SET last_used_at')) return { rows: [], rowCount: 1 };
      if (n.includes('FROM delivery_bots d') && n.includes('WHERE d.owner_telegram_id = $1')) {
        return { rows: bots.filter((b) => b.owner_telegram_id === Number(params[0])), rowCount: bots.length };
      }
      if (n.includes('FROM delivery_bots WHERE id = $1 AND owner_telegram_id = $2')) {
        const hit = bots.find((b) => b.id === Number(params[0]) && b.owner_telegram_id === Number(params[1]));
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (n.includes('FROM delivery_bots') && n.includes('WHERE d.owner_telegram_id = $1')) {
        return { rows: bots.filter((b) => b.owner_telegram_id === Number(params[0])), rowCount: 0 };
      }
      if (n.includes('INSERT INTO storage_channels')) {
        const ch = {
          id: storageChannels.length + 1,
          telegram_chat_id: Number(params[0]),
          title: params[1],
          username: params[2],
          role: 'primary',
          is_enabled: true,
          owner_telegram_id: Number(params[4]),
          last_test_status: 'ok',
        };
        storageChannels.push(ch);
        return { rows: [ch], rowCount: 1 };
      }
      if (n.includes('SELECT COUNT') && n.includes('FROM storage_channels')) {
        const total = storageChannels.filter((c) => c.owner_telegram_id === Number(params[0]) && c.role === 'primary' && c.is_enabled).length;
        return { rows: [{ total }], rowCount: 1 };
      }
      if (n.includes('FROM storage_channels') && n.includes('telegram_chat_id = $1 AND owner_telegram_id = $2')) {
        const hit = storageChannels.find((c) => c.telegram_chat_id === Number(params[0]) && c.owner_telegram_id === Number(params[1]));
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (n.includes('FROM storage_channels') && n.includes('owner_telegram_id = $1')) {
        const rows = storageChannels.filter((c) => c.owner_telegram_id === Number(params[0]));
        return { rows, rowCount: rows.length };
      }
      if (n.includes('UPDATE storage_channels SET last_test_status')) {
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO force_sub_channels')) {
        const fch = {
          id: forceSubChannels.length + 1,
          telegram_chat_id: Number(params[0]),
          title: params[1],
          username: params[2],
          join_url: params[3],
          is_enabled: true,
          owner_telegram_id: Number(params[5]),
          last_test_status: 'ok',
        };
        forceSubChannels.push(fch);
        return { rows: [fch], rowCount: 1 };
      }
      if (n.includes('FROM force_sub_channels') && n.includes('owner_telegram_id = $1')) {
        const rows = forceSubChannels.filter((c) => c.owner_telegram_id === Number(params[0]));
        return { rows, rowCount: rows.length };
      }
      if (n.includes('INSERT INTO premium_plans')) {
        const plan = {
          id: plans.length + 10,
          name: params[0],
          price_minor: params[1],
          currency: params[2],
          duration_days: params[3],
          is_enabled: true,
          owner_telegram_id: Number(params[6]),
        };
        plans.push(plan);
        return { rows: [plan], rowCount: 1 };
      }
      if (n.includes('UPDATE premium_plans SET name = $2') && n.includes('AND owner_telegram_id = $7')) {
        const hit = plans.find((p) => p.id === Number(params[0]) && p.owner_telegram_id === Number(params[6]));
        if (!hit) return { rows: [], rowCount: 0 };
        hit.name = params[1];
        hit.price_minor = params[2];
        hit.duration_days = params[4];
        return { rows: [hit], rowCount: 1 };
      }
      if (n.includes('FROM premium_plans WHERE id = $1 AND owner_telegram_id = $2')) {
        const hit = plans.find((p) => p.id === Number(params[0]) && p.owner_telegram_id === Number(params[1]));
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (n.includes('FROM premium_plans') && n.includes('owner_telegram_id = $1')) {
        const rows = plans.filter((p) => p.owner_telegram_id === Number(params[0]));
        return { rows, rowCount: rows.length };
      }
      if (n.includes('FROM payment_methods') && params[0] === 'telegram_stars') {
        return { rows: [{ is_enabled: true, public_config: { stars_prices: { premium: starsPrices } } }], rowCount: 1 };
      }
      if (n.includes('UPDATE payment_methods SET public_config')) {
        const parsed = JSON.parse(params[1]);
        starsPrices = parsed.stars_prices?.premium || {};
        return { rows: [], rowCount: 1 };
      }
      if (n.includes('FROM delivery_bots') && (n.includes('WHERE id=$1') || n.includes('WHERE id = $1'))) {
        const hit = bots.find((b) => b.id === Number(params[0]) && (!params[1] || b.owner_telegram_id === Number(params[1])));
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (n.includes('FROM delivery_bot_user_activity') && n.includes('COUNT(')) {
        return { rows: [{ total: 2 }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO creator_broadcasts')) {
        const camp = {
          id: broadcasts.length + 1,
          owner_telegram_id: params[0],
          delivery_bot_id: params[1],
          status: 'pending',
          total_recipients: params[5],
          sent_count: 0,
          failed_count: 0,
          created_at: new Date(),
        };
        broadcasts.push(camp);
        return { rows: [camp], rowCount: 1 };
      }
      if (n.includes('FROM creator_broadcasts') && n.includes('owner_telegram_id = $1')) {
        return { rows: broadcasts.filter((c) => c.owner_telegram_id === Number(params[0])), rowCount: broadcasts.length };
      }
      if (n.includes('SELECT 1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  const tokenA = (await issueOrRegenerateAccessToken(pool, creatorA, { first_name: 'Alice' })).token;
  const tokenB = (await issueOrRegenerateAccessToken(pool, creatorB, { first_name: 'Bob' })).token;

  const deliveryManager = {
    async addToken(token, actorId, ownerId) {
      const bot = {
        id: bots.length + 1,
        telegram_bot_id: '9001',
        username: `Creator${ownerId}Bot`,
        role: 'primary',
        priority: 10,
        is_enabled: true,
        runtime_status: 'running',
        owner_telegram_id: Number(ownerId),
        total_users: 2,
        active_users_7d: 2,
        total_interactions: 5,
      };
      bots.push(bot);
      return bot;
    },
    async setPriority(botId, prio, ownerId) {
      const b = bots.find((x) => x.id === botId && x.owner_telegram_id === Number(ownerId));
      if (b) b.priority = prio;
    },
    async test(botId, ownerId) {
      const b = bots.find((x) => x.id === botId && x.owner_telegram_id === Number(ownerId));
      if (!b) throw new Error('Bot not found');
      return { bot: { id: 9001, username: b.username, first_name: 'CustomBot' }, checks: [{ status: 'ok' }] };
    },
    async remove(botId, ownerId) {
      const idx = bots.findIndex((x) => x.id === botId && x.owner_telegram_id === Number(ownerId));
      if (idx === -1) return false;
      bots.splice(idx, 1);
      return true;
    },
  };

  const notifyTelegram = {
    async getMe() { return { id: 777, username: 'MainBot' }; },
    async getChat(id) { return { id: -100555666777, type: 'channel', title: 'Creator Vault', username: 'creatorvault' }; },
    async getChatMember(chatId, userId) {
      if (Number(userId) === creatorB) return { status: 'member' };
      return { status: 'administrator', can_post_messages: true };
    },
  };

  const server = await startHttpServer({
    port: 0,
    nodeEnv: 'test',
    database: 'connected',
    telegram: 'connected',
    delivery: 'connected',
    botUsername: 'MainBot',
    pool,
    notifyTelegram,
    deliveryManager,
    config: { adminIds: [1], tokenEncryptionKey: randomBytes(32).toString('base64') },
  }, { info() {}, warn() {}, error() {} });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const hA = { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' };
    const hB = { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' };

    // 1. Connect Delivery Bot on website without Storage Channel -> warns requiresStorageChannel
    const addBotRes = await fetch(`${base}/api/panel/bots`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345' }),
    });
    assert.equal(addBotRes.status, 201);
    const addBotJson = await addBotRes.json();
    assert.equal(addBotJson.requiresStorageChannel, true);
    assert.match(addBotJson.warning, /Storage Channel/i);

    // Cross-tenant isolation: Creator B cannot edit or delete Creator A's bot
    const crossEdit = await fetch(`${base}/api/panel/bots/1`, {
      method: 'PATCH',
      headers: hB,
      body: JSON.stringify({ priority: 5 }),
    });
    assert.equal(crossEdit.status, 404);

    // 2. Add Storage Channel & Force-Sub Channel on website (and Creator B non-admin rejected)
    const addStorageRes = await fetch(`${base}/api/panel/channels/storage`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ channelInput: '-100555666777' }),
    });
    assert.equal(addStorageRes.status, 201);

    const addFsubB = await fetch(`${base}/api/panel/channels/force_sub`, {
      method: 'POST',
      headers: hB,
      body: JSON.stringify({ channelInput: '-100555666777' }),
    });
    assert.equal(addFsubB.status, 400);

    const addFsubA = await fetch(`${base}/api/panel/channels/force_sub`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ channelInput: '@creatorvault' }),
    });
    assert.equal(addFsubA.status, 201);
    const addFsubJson = await addFsubA.json();
    assert.equal(addFsubJson.channel.joinUrl, 'https://t.me/creatorvault');

    // 3. Create, edit, and set Stars price on Premium Plan
    const addPlanRes = await fetch(`${base}/api/panel/plans`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ name: 'VIP Pro', price: '99', durationDays: 30, starsPrice: 50 }),
    });
    assert.equal(addPlanRes.status, 201);
    const planId = (await addPlanRes.json()).plan.id;

    const editPlanRes = await fetch(`${base}/api/panel/plans/${planId}`, {
      method: 'PATCH',
      headers: hA,
      body: JSON.stringify({ name: 'VIP Ultra', price: '149', durationDays: 60 }),
    });
    assert.equal(editPlanRes.status, 200);

    const starsRes = await fetch(`${base}/api/panel/plans/${planId}/stars`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ stars: 75 }),
    });
    assert.equal(starsRes.status, 200);
    assert.equal((await starsRes.json()).starsPrice, 75);

    // 4. Broadcast compose validation & queue
    const badBc = await fetch(`${base}/api/panel/broadcasts`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ deliveryBotId: 1, messageText: 'Hello', buttonText: 'Click', buttonUrl: 'javascript:alert(1)' }),
    });
    assert.equal(badBc.status, 400);

    const goodBc = await fetch(`${base}/api/panel/broadcasts`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ deliveryBotId: 1, messageText: 'New drop ready!', buttonText: 'Open', buttonUrl: 'https://t.me/creatorvault' }),
    });
    assert.equal(goodBc.status, 201);
    assert.equal((await goodBc.json()).totalRecipients, 2);

    // 5. Web UI source verification
    const appJsSrc = await readFile(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
    assert.match(appJsSrc, /Setup &amp; Delivery Bots/);
    assert.match(appJsSrc, /Creator Setup Checklist/);
    assert.match(appJsSrc, /Add Storage Channel/);
    assert.match(appJsSrc, /Add Force-Sub Channel/);
    assert.match(appJsSrc, /Test API/);
    assert.match(appJsSrc, /renderBroadcasts/);
    assert.match(appJsSrc, /Indexed Files/);
    assert.match(appJsSrc, /Clean Unused Files/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  clearCache();
});

test('deleting links cleans up unreferenced files and /api/panel/files allows unused file cleanup with tenant isolation', async () => {
  clearCache();
  const creatorA = 6101;
  const creatorB = 6102;
  const tokenStore = new Map();
  const files = [
    { id: 10, file_code: 'FILE_A1', file_name: 'a1.mp4', file_type: 'video', file_size: 1024, status: 'active', uploaded_by: creatorA, link_count: 1, created_at: new Date() },
    { id: 11, file_code: 'FILE_A2', file_name: 'a2.mp4', file_type: 'video', file_size: 2048, status: 'active', uploaded_by: creatorA, link_count: 0, created_at: new Date() },
    { id: 12, file_code: 'FILE_B1', file_name: 'b1.mp4', file_type: 'video', file_size: 512, status: 'active', uploaded_by: creatorB, link_count: 0, created_at: new Date() },
  ];
  const shareLinks = [{ id: 1, link_code: 's_abc', title: 'Clip', file_id: 10, created_by: creatorA }];

  const pool = {
    async query(sql, params = []) {
      const n = sql.replace(/\s+/g, ' ').trim();
      if (n.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (n.includes('INSERT INTO web_access_tokens')) {
        const record = {
          telegram_user_id: Number(params[0]),
          token_hash: params[1],
          token_prefix: params[2],
          username: 'creator',
          first_name: 'Creator',
          rotated_at: new Date(),
          last_used_at: null,
        };
        tokenStore.set(record.token_hash, record);
        return { rows: [record], rowCount: 1 };
      }
      if (n.includes('FROM web_access_tokens t') && n.includes('WHERE t.token_hash = $1')) {
        const rec = tokenStore.get(params[0]);
        return { rows: rec ? [rec] : [], rowCount: rec ? 1 : 0 };
      }
      if (n.startsWith('UPDATE web_access_tokens SET last_used_at')) return { rows: [], rowCount: 1 };
      if (n.includes('SELECT sli.file_id FROM share_link_items sli')) return { rows: [], rowCount: 0 };
      if (n.includes('DELETE FROM share_links WHERE')) {
        const idx = shareLinks.findIndex((l) => l.id === Number(params[0]) && l.created_by === Number(params[1]));
        if (idx === -1) return { rows: [], rowCount: 0 };
        const [removed] = shareLinks.splice(idx, 1);
        for (const f of files) {
          if (f.id === removed.file_id) f.link_count = 0;
        }
        return { rows: [removed], rowCount: 1 };
      }
      if (n.includes('FROM files f') && n.includes('ORDER BY f.created_at DESC')) {
        const rows = files.filter((f) => f.status === 'active' && f.uploaded_by === Number(params[0]));
        return { rows, rowCount: rows.length };
      }
      if (n.includes('AS in_use FROM files f')) {
        const val = params[0];
        const owner = Number(params[1]);
        const hit = files.find((f) => (f.id === Number(val) || f.file_code === val) && f.status === 'active' && f.uploaded_by === owner);
        return { rows: hit ? [{ ...hit, in_use: hit.link_count > 0 }] : [], rowCount: hit ? 1 : 0 };
      }
      if (n.includes("UPDATE files SET status = 'disabled'") && n.includes('WHERE id = $1')) {
        const hit = files.find((f) => f.id === Number(params[0]));
        if (hit) hit.status = 'disabled';
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (n.includes('UPDATE files f SET status = \'disabled\'') && n.includes('f.id = ANY($1::bigint[])')) {
        const ids = params[0];
        const owner = Number(params[1]);
        let count = 0;
        for (const f of files) {
          if (ids.includes(f.id) && f.uploaded_by === owner && f.status === 'active' && f.link_count === 0) {
            f.status = 'disabled';
            count += 1;
          }
        }
        return { rows: [], rowCount: count };
      }
      if (n.includes('UPDATE files f SET status = \'disabled\'')) {
        const owner = Number(params[0]);
        let count = 0;
        for (const f of files) {
          if (f.uploaded_by === owner && f.status === 'active' && f.link_count === 0) {
            f.status = 'disabled';
            count += 1;
          }
        }
        return { rows: [], rowCount: count };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const tokenA = (await issueOrRegenerateAccessToken(pool, creatorA, { first_name: 'Alice' })).token;
  const tokenB = (await issueOrRegenerateAccessToken(pool, creatorB, { first_name: 'Bob' })).token;
  const server = await startHttpServer({
    port: 0,
    nodeEnv: 'test',
    database: 'connected',
    telegram: 'connected',
    delivery: 'connected',
    pool,
    config: { adminIds: [1] },
  }, { info() {}, warn() {}, error() {} });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const hA = { Authorization: `Bearer ${tokenA}` };
    const hB = { Authorization: `Bearer ${tokenB}` };

    // 1. Cannot delete file attached to active link (409), nor cross-tenant file (404)
    const inUseRes = await fetch(`${base}/api/panel/files/10`, { method: 'DELETE', headers: hA });
    assert.equal(inUseRes.status, 409);

    const crossRes = await fetch(`${base}/api/panel/files/12`, { method: 'DELETE', headers: hA });
    assert.equal(crossRes.status, 404);

    // 2. Deleting share link disables its unreferenced file (FILE_A1) automatically
    const delLinkRes = await fetch(`${base}/api/panel/links/share/1`, { method: 'DELETE', headers: hA });
    assert.equal(delLinkRes.status, 200);
    assert.equal(files.find((f) => f.id === 10).status, 'disabled');

    // 3. Clean unused removes Creator A's leftover file (FILE_A2) without touching Creator B's file (FILE_B1)
    const cleanRes = await fetch(`${base}/api/panel/files/clean-unused`, { method: 'POST', headers: hA });
    assert.equal(cleanRes.status, 200);
    assert.equal((await cleanRes.json()).removedCount, 1);
    assert.equal(files.find((f) => f.id === 11).status, 'disabled');
    assert.equal(files.find((f) => f.id === 12).status, 'active');

    const listB = await fetch(`${base}/api/panel/files`, { headers: hB });
    assert.equal(listB.status, 200);
    assert.equal((await listB.json()).files.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  clearCache();
});


