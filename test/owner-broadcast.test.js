import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerControlCenter } from '../src/bot/control-center.js';
import { createCreatorBroadcastWorker } from '../src/broadcast/worker.js';
import { issueOrRegenerateAccessToken } from '../src/web/token-repository.js';
import { startHttpServer } from '../src/server.js';

function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

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

function createBroadcastPool() {
  const tokens = new Map();
  const users = new Map([
    [1, { telegram_id: 1, username: 'owner_admin', first_name: 'Owner' }],
    [101, { telegram_id: 101, username: 'creator_one', first_name: 'Alice' }],
    [202, { telegram_id: 202, username: 'creator_two', first_name: 'Bob' }],
  ]);
  const deliveryBots = [
    { id: 10, username: 'alice_delivery_bot', role: 'primary', runtime_status: 'running', is_enabled: true, owner_telegram_id: 101, priority: 0 },
    { id: 20, username: 'bob_delivery_bot', role: 'primary', runtime_status: 'running', is_enabled: true, owner_telegram_id: 202, priority: 0 },
    { id: 30, username: 'platform_main_delivery_bot', role: 'primary', runtime_status: 'running', is_enabled: true, owner_telegram_id: null, priority: 0 },
    { id: 31, username: 'disabled_creator_bot', role: 'backup', runtime_status: 'stopped', is_enabled: false, owner_telegram_id: 101, priority: 1 },
  ];
  const activity = [
    { delivery_bot_id: 10, telegram_user_id: 9001 },
    { delivery_bot_id: 10, telegram_user_id: 9002 },
    { delivery_bot_id: 20, telegram_user_id: 9003 },
    { delivery_bot_id: 30, telegram_user_id: 9010 },
    { delivery_bot_id: 30, telegram_user_id: 9011 },
    { delivery_bot_id: 30, telegram_user_id: 9012 },
  ];
  const broadcasts = [];
  const recipients = [];
  let nextBroadcastId = 500;

  const execQuery = async (sql, params = []) => {
    const n = normSql(sql);
    if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [], rowCount: 0 };

    // Auth tokens
    if (n.includes('INSERT INTO web_access_tokens')) {
      const uid = Number(params[0]);
      const nowIso = new Date().toISOString();
      tokens.set(params[1], {
        telegram_user_id: uid,
        token_hash: params[1],
        token_prefix: params[2],
        username: users.get(uid)?.username ?? `user_${uid}`,
        first_name: users.get(uid)?.first_name ?? 'User',
        created_at: nowIso,
        rotated_at: nowIso,
        last_used_at: null,
      });
      return { rows: [{ telegram_user_id: uid, token_prefix: params[2], created_at: nowIso, rotated_at: nowIso, last_used_at: null, is_new: true }], rowCount: 1 };
    }
    if (n.includes('FROM web_access_tokens t') && n.includes('t.token_hash = $1')) {
      const row = tokens.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // Delivery bots queries for Web Panel GET /api/panel/broadcasts
    if (n.includes('FROM delivery_bots d') && n.includes('LEFT JOIN users u ON u.telegram_id = d.owner_telegram_id') && n.includes('WHERE d.is_enabled = TRUE')) {
      const rows = deliveryBots.filter((b) => b.is_enabled).map((b) => {
        const u = b.owner_telegram_id !== null ? users.get(b.owner_telegram_id) : null;
        return {
          ...b,
          owner_username: u?.username ?? null,
          owner_first_name: u?.first_name ?? null,
          total_users: activity.filter((a) => a.delivery_bot_id === b.id).length,
        };
      });
      return { rows, rowCount: rows.length };
    }
    if (n.includes('FROM delivery_bots d') && n.includes('WHERE d.owner_telegram_id = $1')) {
      const ownerId = Number(params[0]);
      const rows = deliveryBots.filter((b) => b.owner_telegram_id === ownerId).map((b) => ({
        ...b,
        total_users: activity.filter((a) => a.delivery_bot_id === b.id).length,
      }));
      return { rows, rowCount: rows.length };
    }

    // Main Bot cc:owner_broadcast creator summary & platform summary
    if (n.includes('FROM delivery_bots d') && n.includes('WHERE d.owner_telegram_id IS NOT NULL AND d.is_enabled = TRUE') && n.includes('GROUP BY')) {
      const byOwner = new Map();
      for (const b of deliveryBots.filter((x) => x.is_enabled && x.owner_telegram_id !== null)) {
        const entry = byOwner.get(b.owner_telegram_id) || {
          owner_telegram_id: b.owner_telegram_id,
          username: users.get(b.owner_telegram_id)?.username ?? null,
          first_name: users.get(b.owner_telegram_id)?.first_name ?? null,
          bots: 0,
          total_users: 0,
        };
        entry.bots += 1;
        entry.total_users += activity.filter((a) => a.delivery_bot_id === b.id).length;
        byOwner.set(b.owner_telegram_id, entry);
      }
      const rows = [...byOwner.values()];
      return { rows, rowCount: rows.length };
    }
    if (n.includes('FROM delivery_bots d') && n.includes('WHERE d.owner_telegram_id IS NULL AND d.is_enabled = TRUE')) {
      const pBots = deliveryBots.filter((x) => x.is_enabled && x.owner_telegram_id === null);
      const totalUsers = pBots.reduce((acc, b) => acc + activity.filter((a) => a.delivery_bot_id === b.id).length, 0);
      return { rows: [{ bots: pBots.length, total_users: totalUsers }], rowCount: 1 };
    }

    // Owner lookup of target delivery bot in POST /api/panel/broadcasts
    if (n === 'SELECT id, owner_telegram_id, is_enabled FROM delivery_bots WHERE id = $1 LIMIT 1') {
      const bot = deliveryBots.find((b) => b.id === Number(params[0]));
      return { rows: bot ? [bot] : [], rowCount: bot ? 1 : 0 };
    }

    // createCreatorBroadcast bot checks
    if (n === 'SELECT id FROM delivery_bots WHERE id=$1 AND owner_telegram_id IS NULL AND is_enabled=TRUE LIMIT 1') {
      const bot = deliveryBots.find((b) => b.id === Number(params[0]) && b.owner_telegram_id === null && b.is_enabled);
      return { rows: bot ? [{ id: bot.id }] : [], rowCount: bot ? 1 : 0 };
    }
    if (n === 'SELECT id FROM delivery_bots WHERE id=$1 AND owner_telegram_id=$2 AND is_enabled=TRUE LIMIT 1') {
      const bot = deliveryBots.find((b) => b.id === Number(params[0]) && b.owner_telegram_id === Number(params[1]) && b.is_enabled);
      return { rows: bot ? [{ id: bot.id }] : [], rowCount: bot ? 1 : 0 };
    }

    // Audience count queries
    if (n.includes('FROM delivery_bot_user_activity WHERE delivery_bot_id=$1')) {
      const botId = Number(params[0]);
      const count = activity.filter((a) => a.delivery_bot_id === botId).length;
      return { rows: [{ total: count, count }], rowCount: 1 };
    }

    // Insert broadcast
    if (n.startsWith('INSERT INTO creator_broadcasts(')) {
      const id = ++nextBroadcastId;
      const row = {
        id,
        owner_telegram_id: Number(params[0]),
        delivery_bot_id: Number(params[1]),
        created_by: Number(params[2]),
        message_text: params[3],
        media_type: params[4],
        media_file_id: params[5],
        caption: params[6],
        buttons: JSON.parse(params[7]),
        total_recipients: Number(params[8]),
        sent_count: 0,
        failed_count: 0,
        status: 'pending',
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        last_error: null,
      };
      broadcasts.unshift(row);
      return { rows: [{ id }], rowCount: 1 };
    }

    // Insert recipients
    if (n.startsWith('INSERT INTO creator_broadcast_recipients(')) {
      const broadcastId = Number(params[0]);
      const botId = Number(params[1]);
      const matched = activity.filter((a) => a.delivery_bot_id === botId);
      for (const a of matched) {
        recipients.push({ broadcast_id: broadcastId, telegram_user_id: a.telegram_user_id, status: 'pending', error_code: null });
      }
      return { rows: [], rowCount: matched.length };
    }

    // List all broadcasts for owner
    if (n.includes('FROM creator_broadcasts b') && n.includes('LEFT JOIN delivery_bots d ON d.id = b.delivery_bot_id') && n.includes('LEFT JOIN users u ON u.telegram_id = b.owner_telegram_id')) {
      const rows = broadcasts.map((b) => {
        const bot = deliveryBots.find((d) => d.id === b.delivery_bot_id);
        const u = users.get(b.owner_telegram_id);
        return {
          ...b,
          bot_username: bot?.username ?? null,
          bot_owner_telegram_id: bot?.owner_telegram_id ?? null,
          owner_username: u?.username ?? null,
          owner_first_name: u?.first_name ?? null,
        };
      });
      return { rows, rowCount: rows.length };
    }

    // List owner-created broadcasts
    if (n.includes('FROM creator_broadcasts b') && n.includes('WHERE b.created_by=$1')) {
      const rows = broadcasts.filter((b) => b.created_by === Number(params[0])).map((b) => ({
        ...b,
        bot_username: deliveryBots.find((d) => d.id === b.delivery_bot_id)?.username ?? null,
      }));
      return { rows, rowCount: rows.length };
    }

    // List creator broadcasts
    if (n.includes('FROM creator_broadcasts WHERE owner_telegram_id=$1')) {
      const rows = broadcasts.filter((b) => b.owner_telegram_id === Number(params[0]));
      return { rows, rowCount: rows.length };
    }

    // getCreatorBroadcast (owner override vs scoped)
    if (n.includes('FROM creator_broadcasts b') && n.includes('WHERE b.id=$1')) {
      const b = broadcasts.find((x) => x.id === Number(params[0]));
      if (!b) return { rows: [], rowCount: 0 };
      const pendingCount = recipients.filter((r) => r.broadcast_id === b.id && r.status === 'pending').length;
      const bot = deliveryBots.find((d) => d.id === b.delivery_bot_id);
      return { rows: [{ ...b, bot_username: bot?.username ?? null, pending_count: pendingCount }], rowCount: 1 };
    }
    if (n.includes('FROM creator_broadcasts b') && n.includes('WHERE b.owner_telegram_id=$1 AND b.id=$2')) {
      const b = broadcasts.find((x) => x.owner_telegram_id === Number(params[0]) && x.id === Number(params[1]));
      if (!b) return { rows: [], rowCount: 0 };
      const pendingCount = recipients.filter((r) => r.broadcast_id === b.id && r.status === 'pending').length;
      return { rows: [{ ...b, pending_count: pendingCount }], rowCount: 1 };
    }

    // setCreatorBroadcastStatus (owner override vs scoped)
    if (n.startsWith('UPDATE creator_broadcasts SET status=$2 WHERE id=$1')) {
      const b = broadcasts.find((x) => x.id === Number(params[0]) && ['pending', 'processing', 'paused'].includes(x.status));
      if (!b) return { rows: [], rowCount: 0 };
      b.status = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (n.startsWith('UPDATE creator_broadcasts SET status=$3 WHERE id=$1 AND owner_telegram_id=$2')) {
      const b = broadcasts.find((x) => x.id === Number(params[0]) && x.owner_telegram_id === Number(params[1]) && ['pending', 'processing', 'paused'].includes(x.status));
      if (!b) return { rows: [], rowCount: 0 };
      b.status = params[2];
      return { rows: [], rowCount: 1 };
    }
    if (n.startsWith("UPDATE creator_broadcast_recipients SET status='skipped'")) {
      let count = 0;
      for (const r of recipients) {
        if (r.broadcast_id === Number(params[0]) && r.status === 'pending') {
          r.status = 'skipped';
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    // retryCreatorBroadcast
    if (n.includes("SELECT id FROM creator_broadcasts WHERE id=$1 AND status IN ('failed','completed','paused')")) {
      const b = broadcasts.find((x) => x.id === Number(params[0]) && ['failed', 'completed', 'paused'].includes(x.status));
      return { rows: b ? [{ id: b.id }] : [], rowCount: b ? 1 : 0 };
    }
    if (n.includes("SELECT id FROM creator_broadcasts WHERE id=$1 AND owner_telegram_id=$2 AND status IN ('failed','completed','paused')")) {
      const b = broadcasts.find((x) => x.id === Number(params[0]) && x.owner_telegram_id === Number(params[1]) && ['failed', 'completed', 'paused'].includes(x.status));
      return { rows: b ? [{ id: b.id }] : [], rowCount: b ? 1 : 0 };
    }
    if (n.startsWith("UPDATE creator_broadcast_recipients SET status='pending',error_code=NULL WHERE broadcast_id=$1 AND status='failed'")) {
      let count = 0;
      for (const r of recipients) {
        if (r.broadcast_id === Number(params[0]) && r.status === 'failed') {
          r.status = 'pending';
          r.error_code = null;
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }
    if (n.startsWith("UPDATE creator_broadcasts SET status='pending',completed_at=NULL,last_error=NULL WHERE id=$1")) {
      const b = broadcasts.find((x) => x.id === Number(params[0]));
      if (b) {
        b.status = 'pending';
        b.completed_at = null;
        b.last_error = null;
        b.failed_count = Math.max(0, Number(b.failed_count || 0) - Number(params[1] || 0));
      }
      return { rows: [], rowCount: b ? 1 : 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    query: execQuery,
    connect: async () => ({ query: execQuery, release() {} }),
    state: { deliveryBots, broadcasts, recipients },
  };
}

test('Web Panel API: Owner broadcasts on behalf of creators and platform bots while creators remain tenant-isolated', async () => {
  const ownerId = 1;
  const creatorA = 101;
  const creatorB = 202;
  const pool = createBroadcastPool();
  const { token: ownerToken } = await issueOrRegenerateAccessToken(pool, ownerId);
  const { token: creatorAToken } = await issueOrRegenerateAccessToken(pool, creatorA);
  const { token: creatorBToken } = await issueOrRegenerateAccessToken(pool, creatorB);

  const server = await startHttpServer(
    {
      port: 0,
      nodeEnv: 'test',
      database: 'connected',
      telegram: 'connected',
      delivery: 'connected',
      botUsername: 'Filestore_advbot',
      pool,
      config: { adminIds: [ownerId] },
    },
    { info() {}, warn() {}, error() {} },
  );

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const api = async (path, token, opts = {}) => {
      const res = await fetch(`${baseUrl}${path}`, {
        ...opts,
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers || {}),
        },
      });
      return { status: res.status, data: await res.json() };
    };

    // 1. Owner sees ALL enabled bots (creator bots + platform bots) with creator metadata
    const ownerList = await api('/api/panel/broadcasts', ownerToken);
    assert.equal(ownerList.status, 200);
    assert.equal(ownerList.data.isOwnerMode, true);
    assert.equal(ownerList.data.bots.length, 3);
    const aliceBot = ownerList.data.bots.find((b) => b.id === 10);
    assert.equal(aliceBot.ownerUsername, 'creator_one');
    assert.equal(aliceBot.ownerId, '101');
    assert.equal(aliceBot.isPlatform, false);
    assert.equal(aliceBot.totalUsers, 2);
    const platformBot = ownerList.data.bots.find((b) => b.id === 30);
    assert.equal(platformBot.isPlatform, true);
    assert.equal(platformBot.ownerId, null);
    assert.equal(platformBot.totalUsers, 3);

    // 2. Owner sends broadcast on behalf of Creator A's delivery bot (#10)
    const createdForCreator = await api('/api/panel/broadcasts', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        deliveryBotId: 10,
        messageText: 'Hello Alice subscribers from Owner!',
        buttons: [{ text: 'Open Site', url: 'https://example.com' }],
      }),
    });
    assert.equal(createdForCreator.status, 201);
    assert.equal(createdForCreator.data.totalRecipients, 2);
    const creatorCampaign = pool.state.broadcasts.find((b) => b.id === createdForCreator.data.id);
    assert.equal(creatorCampaign.owner_telegram_id, creatorA);
    assert.equal(creatorCampaign.created_by, ownerId);
    assert.equal(creatorCampaign.delivery_bot_id, 10);

    // 3. Owner sends broadcast via Platform Delivery Bot (#30)
    const createdForPlatform = await api('/api/panel/broadcasts', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        deliveryBotId: 30,
        messageText: 'Platform-wide announcement!',
      }),
    });
    assert.equal(createdForPlatform.status, 201);
    assert.equal(createdForPlatform.data.totalRecipients, 3);

    // 4. Owner can pause, resume, retry, and cancel a creator-scoped campaign
    const pauseRes = await api(`/api/panel/broadcasts/${creatorCampaign.id}/pause`, ownerToken, { method: 'POST' });
    assert.equal(pauseRes.status, 200);
    assert.equal(creatorCampaign.status, 'paused');

    // Simulate one failed recipient and test Owner retry
    const failedRecip = pool.state.recipients.find((r) => r.broadcast_id === creatorCampaign.id);
    failedRecip.status = 'failed';
    creatorCampaign.failed_count = 1;
    const retryRes = await api(`/api/panel/broadcasts/${creatorCampaign.id}/retry`, ownerToken, { method: 'POST' });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.data.retriedCount, 1);
    assert.equal(creatorCampaign.status, 'pending');
    assert.equal(creatorCampaign.failed_count, 0, 'retry resets the outstanding failed count');

    const cancelRes = await api(`/api/panel/broadcasts/${creatorCampaign.id}/cancel`, ownerToken, { method: 'POST' });
    assert.equal(cancelRes.status, 200);
    assert.equal(creatorCampaign.status, 'cancelled');

    // 5. Creator A sees ONLY their own bots and campaigns
    const creatorAList = await api('/api/panel/broadcasts', creatorAToken);
    assert.equal(creatorAList.status, 200);
    assert.equal(creatorAList.data.isOwnerMode, false);
    assert.equal(creatorAList.data.bots.every((b) => b.ownerId === String(creatorA)), true);
    assert.equal(creatorAList.data.bots.some((b) => b.id === 20 || b.id === 30), false);
    assert.equal(creatorAList.data.campaigns.every((c) => c.deliveryBotId === 10), true);

    // 6. Creator B CANNOT broadcast on Creator A's bot or Platform bot, and CANNOT manage Creator A's campaign
    const crossBotAttempt = await api('/api/panel/broadcasts', creatorBToken, {
      method: 'POST',
      body: JSON.stringify({ deliveryBotId: 10, messageText: 'Unauthorized!' }),
    });
    assert.equal(crossBotAttempt.status, 400);
    assert.match(crossBotAttempt.data.error, /not found or disabled/i);

    const platformBotAttempt = await api('/api/panel/broadcasts', creatorBToken, {
      method: 'POST',
      body: JSON.stringify({ deliveryBotId: 30, messageText: 'Unauthorized platform!' }),
    });
    assert.equal(platformBotAttempt.status, 400);

    const crossCancelAttempt = await api(`/api/panel/broadcasts/${creatorCampaign.id}/pause`, creatorBToken, { method: 'POST' });
    assert.equal(crossCancelAttempt.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Main Bot Owner Broadcast: selects creator or platform bot, previews, confirms, and manages campaigns', async () => {
  const ownerId = 1;
  const creatorA = 101;
  const pool = createBroadcastPool();
  const bot = createFakeBot();
  const deliveryManager = {
    async list(ownerScope) {
      if (ownerScope === null) return pool.state.deliveryBots.filter((b) => b.owner_telegram_id === null);
      if (ownerScope === undefined) return pool.state.deliveryBots;
      return pool.state.deliveryBots.filter((b) => b.owner_telegram_id === Number(ownerScope));
    },
  };

  registerControlCenter(bot, { adminIds: [ownerId], deliveryManager }, { warn() {}, error() {} }, pool);

  // 1. Owner opens cc:owner_broadcast -> sees creator @creator_one AND Platform Bots
  const openAction = findAction(bot, 'cc:owner_broadcast');
  assert.ok(openAction);
  let renderedText = '';
  let renderedMarkup = null;
  await openAction.handler({
    from: { id: ownerId },
    match: openAction.match,
    answerCbQuery: async () => true,
    editMessageText: async (text, opts) => { renderedText = text; renderedMarkup = opts?.reply_markup; },
  });
  const flatButtons = renderedMarkup.inline_keyboard.flat();
  assert.ok(flatButtons.some((b) => b.callback_data === `cc:owner_broadcast:creator:${creatorA}` && b.text.includes('@creator_one')));
  assert.ok(flatButtons.some((b) => b.callback_data === 'cc:owner_broadcast:platform' && b.text.includes('Platform Bots')));

  // 2. Owner selects Creator A -> selects Bot #10 -> sends announcement -> confirms
  const selectCreator = findAction(bot, `cc:owner_broadcast:creator:${creatorA}`);
  assert.ok(selectCreator);
  await selectCreator.handler({
    from: { id: ownerId },
    match: selectCreator.match,
    answerCbQuery: async () => true,
    editMessageText: async (text, opts) => { renderedText = text; renderedMarkup = opts?.reply_markup; },
  });
  assert.ok(renderedMarkup.inline_keyboard.flat().some((b) => b.callback_data === `cc:owner_broadcast:bot:${creatorA}:10`));

  const selectBot = findAction(bot, `cc:owner_broadcast:bot:${creatorA}:10`);
  assert.ok(selectBot);
  await selectBot.handler({
    from: { id: ownerId },
    match: selectBot.match,
    answerCbQuery: async () => true,
    editMessageText: async (text, opts) => { renderedText = text; renderedMarkup = opts?.reply_markup; },
  });
  assert.match(renderedText, /Broadcast on behalf of Creator 101/);
  assert.match(renderedText, /@alice_delivery_bot/);

  // Send text message to preview
  const textHandlers = bot.onHandlers.get('text') || [];
  let previewReply = '';
  let previewMarkup = null;
  for (const h of textHandlers) {
    let nextCalled = false;
    await h({
      from: { id: ownerId },
      chat: { id: ownerId },
      message: { text: 'Special Creator Promo!\nButton: Visit | https://example.com' },
      reply: async (text, opts) => { previewReply = text; previewMarkup = opts?.reply_markup; },
    }, async () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  assert.match(previewReply, /Broadcast Preview/);
  assert.ok(previewMarkup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:broadcast_confirm'));

  // Confirm draft
  const confirmAction = findAction(bot, 'cc:broadcast_confirm');
  assert.ok(confirmAction);
  let queuedText = '';
  await confirmAction.handler({
    from: { id: ownerId },
    chat: { id: ownerId },
    callbackQuery: { message: { message_id: 55, text: previewReply } },
    answerCbQuery: async () => true,
    editMessageText: async (text, opts) => { queuedText = text; renderedMarkup = opts?.reply_markup; },
  });
  assert.match(queuedText, /Broadcast queued/);
  assert.match(queuedText, /Recipients: 2/);
  const saved = pool.state.broadcasts[0];
  assert.equal(saved.owner_telegram_id, creatorA);
  assert.equal(saved.created_by, ownerId);
  assert.equal(saved.delivery_bot_id, 10);

  // 3. Owner opens campaign detail & pauses it via cc:owner_broadcast_manage
  const detailAction = findAction(bot, `cc:owner_broadcast_detail:${saved.id}`);
  assert.ok(detailAction);
  let detailText = '';
  await detailAction.handler({
    from: { id: ownerId },
    match: detailAction.match,
    answerCbQuery: async () => true,
    editMessageText: async (text) => { detailText = text; },
  });
  assert.match(detailText, new RegExp(`Broadcast #${saved.id}`));
  assert.match(detailText, /@alice_delivery_bot/);

  const manageAction = findAction(bot, `cc:owner_broadcast_manage:paused:${saved.id}`);
  assert.ok(manageAction);
  let manageNotice = '';
  await manageAction.handler({
    from: { id: ownerId },
    chat: { id: ownerId },
    callbackQuery: { message: { message_id: 55 } },
    match: manageAction.match,
    answerCbQuery: async (txt) => { manageNotice = txt; },
  });
  assert.equal(manageNotice, 'Broadcast updated.');
  assert.equal(saved.status, 'paused');

  // 4. Non-owner is denied access to owner broadcast controls
  let denied = false;
  await detailAction.handler({
    from: { id: creatorA },
    match: detailAction.match,
    answerCbQuery: async (txt) => { if (/restricted|admin|owner/i.test(String(txt))) denied = true; },
    reply: async (txt) => { if (/restricted|admin|owner/i.test(String(txt))) denied = true; },
  });
  assert.equal(denied, true);

  // 5. Owner can also compose and confirm a broadcast for a Platform Delivery Bot (#30)
  const selectPlatformBot = findAction(bot, 'cc:owner_broadcast:bot:0:30');
  assert.ok(selectPlatformBot);
  await selectPlatformBot.handler({
    from: { id: ownerId },
    match: selectPlatformBot.match,
    answerCbQuery: async () => true,
    editMessageText: async () => true,
  });
  for (const h of textHandlers) {
    let nextCalled = false;
    await h({
      from: { id: ownerId },
      chat: { id: ownerId },
      message: { text: 'Platform maintenance alert' },
      reply: async (text) => { previewReply = text; },
    }, async () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  await confirmAction.handler({
    from: { id: ownerId },
    chat: { id: ownerId },
    callbackQuery: { message: { message_id: 56, text: previewReply } },
    answerCbQuery: async () => true,
    editMessageText: async (text) => { queuedText = text; },
  });
  assert.match(queuedText, /Recipients: 3/);
  assert.equal(pool.state.broadcasts[0].delivery_bot_id, 30);
});

test('Broadcast worker backs off cleanly on error without spin-looping and delivery bots start broadcastWorker for platform bots too', async () => {
  let claimCalls = 0;
  const resetErrors = [];
  const pool = {
    query: async (sql, params = []) => {
      const n = normSql(sql);
      if (n.includes("UPDATE creator_broadcasts SET status='processing'")) {
        claimCalls += 1;
        return {
          rows: [{
            id: 77,
            delivery_bot_id: 30,
            owner_telegram_id: 1,
            message_text: 'Media promo',
            media_type: 'photo',
            media_file_id: 'AgAC_FAKE',
            caption: 'Promo',
            buttons: [],
          }],
          rowCount: 1,
        };
      }
      if (n.includes("UPDATE creator_broadcasts SET status='pending',last_error=$2 WHERE id=$1")) {
        resetErrors.push(params);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  // Source telegram returns null -> triggers error in resolveCampaignMedia.
  // Before the fix, processOne() returned true and caused an infinite spin loop.
  const worker = createCreatorBroadcastWorker(
    { sendMessage: async () => true },
    pool,
    { info() {}, warn() {}, error() {} },
    30,
    () => null,
  );
  worker.start();
  await new Promise((r) => setTimeout(r, 80));
  worker.stop();

  assert.equal(claimCalls, 1, 'Worker must stop claiming after an error instead of tight spin-retrying');
  assert.equal(resetErrors.length, 1);
  assert.equal(resetErrors[0][0], 77);
  assert.match(resetErrors[0][1], /Media source bot is unavailable/);

  const deliveryBotSrc = await readFile(new URL('../src/delivery/bot.js', import.meta.url), 'utf8');
  assert.match(deliveryBotSrc, /function ensureBroadcastWorker\(/);
  assert.match(deliveryBotSrc, /startBroadcastWorker\(deliveryBotId\)/);
  assert.doesNotMatch(deliveryBotSrc, /if \(workerScope\.deliveryBotId && workerScope\.ownerTelegramId\)/);
});
