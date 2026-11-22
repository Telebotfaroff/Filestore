import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  FREE_CREATOR_BOT_SLOTS,
  getBotSlotSettings,
  setBotSlotSettings,
  getCreatorBotSlotQuota,
  unlockSlotWithWallet,
} from '../src/delivery/slot-repository.js';
import { applyVerifiedPayment } from '../src/payments/fulfillment-repository.js';
import { getShareableBotUsername, buildShareableUrl } from '../src/storage/share-links-repository.js';
import { issueOrRegenerateAccessToken } from '../src/web/token-repository.js';
import { startHttpServer } from '../src/server.js';
import { cacheDeletePrefix } from '../src/utils/cache.js';

function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

test('030_delivery_bot_slots migration defines extra_bot_slots, bot_slot_purchases, payment constraints, and defaults', async () => {
  const migration30 = await readFile(
    new URL('../src/database/migrations/030_delivery_bot_slots.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration30, /extra_bot_slots INTEGER NOT NULL DEFAULT 0 CHECK \(extra_bot_slots >= 0\)/);
  assert.match(migration30, /CREATE TABLE IF NOT EXISTS bot_slot_purchases/);
  assert.match(migration30, /payment_transaction_id BIGINT UNIQUE/);
  assert.match(migration30, /'bot_slot'/);
  assert.match(migration30, /'slot_purchase'/);
  assert.match(migration30, /'bot_slot_settings'/);
});

test('slot settings validation enforces >= 1.00 INR and optional Stars price', async () => {
  let stored = null;
  const pool = {
    async query(sql, params = []) {
      const n = normSql(sql);
      if (n.includes('SELECT value FROM app_settings WHERE key = $1')) {
        return { rows: stored ? [{ value: stored }] : [], rowCount: stored ? 1 : 0 };
      }
      if (n.includes('INSERT INTO app_settings')) {
        stored = JSON.parse(params[1]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const initial = await getBotSlotSettings(pool);
  assert.equal(initial.priceMinor, 9900);
  assert.equal(initial.currency, 'INR');
  assert.equal(initial.starsPrice, null);

  await assert.rejects(
    () => setBotSlotSettings(pool, { priceMinor: 50 }, 1),
    /at least ₹1\.00 INR/,
  );

  const saved = await setBotSlotSettings(pool, { priceMinor: 14900, starsPrice: 75 }, 1);
  assert.equal(saved.priceMinor, 14900);
  assert.equal(saved.starsPrice, 75);

  const clearedStars = await setBotSlotSettings(pool, { priceMinor: 19900, starsPrice: 0 }, 1);
  assert.equal(clearedStars.priceMinor, 19900);
  assert.equal(clearedStars.starsPrice, null);
});

test('unlockSlotWithWallet atomically debits wallet and applyVerifiedPayment fulfills bot_slot idempotently', async () => {
  const creatorId = 71001;
  let walletAvailable = 25000;
  let extraSlots = 0;
  const slotPurchases = [];
  const ledger = [];
  const appliedTxIds = new Set();

  const txRow = {
    id: 501,
    user_telegram_id: creatorId,
    method: 'fampay',
    purpose: 'bot_slot',
    plan_id: null,
    file_id: null,
    batch_link_id: null,
    paid_link_id: null,
    amount_minor: 9907,
    currency: 'INR',
    status: 'verified',
    session_id: 901,
  };
  const sessionRow = {
    id: 901,
    status: 'verified',
    user_telegram_id: creatorId,
    purpose: 'bot_slot',
    plan_id: null,
    file_id: null,
    batch_link_id: null,
    paid_link_id: null,
    expected_amount_minor: 9907,
    currency: 'INR',
    metadata: { baseAmountMinor: 9900 },
  };

  const client = {
    async query(sql, params = []) {
      const n = normSql(sql);
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (n.includes('SELECT value FROM app_settings WHERE key = $1')) {
        return { rows: [{ value: { priceMinor: 9900, currency: 'INR', starsPrice: 60 } }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (n.includes('FROM creator_wallets') && n.includes('FOR UPDATE')) {
        return { rows: [{ available_minor: walletAvailable }], rowCount: 1 };
      }
      if (n.includes('UPDATE creator_wallets SET available_minor = available_minor - $2')) {
        const debit = Number(params[1]);
        if (walletAvailable < debit) return { rows: [], rowCount: 0 };
        walletAvailable -= debit;
        return { rows: [{ available_minor: walletAvailable }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO bot_slot_purchases')) {
        const paymentTxId = params.length === 5 ? params[2] : null;
        if (paymentTxId !== null && appliedTxIds.has(Number(paymentTxId))) {
          return { rows: [], rowCount: 0 };
        }
        if (paymentTxId !== null) appliedTxIds.add(Number(paymentTxId));
        slotPurchases.push({ userId: params[0], paymentTxId });
        return { rows: [{ id: slotPurchases.length }], rowCount: 1 };
      }
      if (n.includes('SELECT extra_bot_slots FROM user_creator_settings')) {
        return { rows: [{ extra_bot_slots: extraSlots }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO user_creator_settings') && n.includes('extra_bot_slots + 1')) {
        extraSlots += 1;
        return { rows: [{ extra_bot_slots: extraSlots }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO wallet_ledger')) {
        ledger.push({ entryType: 'slot_purchase', amountMinor: params[1], balanceAfter: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (n.includes('FROM payment_transactions WHERE id = $1')) {
        return { rows: [{ ...txRow }], rowCount: 1 };
      }
      if (n.includes('FROM payment_sessions WHERE id=$1')) {
        return { rows: [{ ...sessionRow }], rowCount: 1 };
      }
      if (n.includes("UPDATE payment_transactions SET status='applied'")) {
        txRow.status = 'applied';
        return { rows: [], rowCount: 1 };
      }
      if (n.includes("UPDATE payment_sessions SET status='applied'")) {
        sessionRow.status = 'applied';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const pool = {
    async connect() { return client; },
    async query(sql, params = []) { return client.query(sql, params); },
  };

  const walletUnlock = await unlockSlotWithWallet(pool, creatorId);
  assert.equal(walletUnlock.ok, true);
  assert.equal(walletUnlock.extraSlots, 1);
  assert.equal(walletUnlock.availableAfterMinor, 15100);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].entryType, 'slot_purchase');
  assert.equal(ledger[0].amountMinor, -9900);

  // Payment gateway fulfillment (+1 slot) & idempotent replay check
  const fulfilled = await applyVerifiedPayment(pool, 501);
  assert.equal(fulfilled.applied, true);
  assert.equal(fulfilled.type, 'bot_slot');
  assert.equal(fulfilled.extraSlots, 2);

  const replay = await applyVerifiedPayment(pool, 501);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(extraSlots, 2);
});

test('Creator 1-free-bot limit, paid slot unlock, Change Bot in-place link continuity, and Owner slot pricing API', async () => {
  cacheDeletePrefix('delivery-bots:');
  cacheDeletePrefix('creator-settings:');

  const ownerId = 1;
  const creatorA = 88001;
  const creatorB = 88002;
  const tokens = new Map();
  const bots = [];
  let extraSlotsByUser = new Map([[creatorA, 0], [creatorB, 0]]);
  let walletByUser = new Map([[creatorA, 20000], [creatorB, 0]]);
  let slotSettings = { priceMinor: 12000, currency: 'INR', starsPrice: 80 };

  const pool = {
    async connect() {
      return {
        async query(sql, params = []) { return pool.query(sql, params); },
        release() {},
      };
    },
    async query(sql, params = []) {
      const n = normSql(sql);
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (n.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (n.includes('INSERT INTO web_access_tokens')) {
        const uid = Number(params[0]);
        const now = new Date();
        const rec = {
          telegram_user_id: uid,
          token_hash: params[1],
          token_prefix: params[2],
          created_at: now,
          rotated_at: now,
          last_used_at: null,
          is_new: true,
          username: uid === ownerId ? 'owner' : `creator_${uid}`,
          first_name: uid === ownerId ? 'Owner' : `Creator${uid}`,
        };
        tokens.set(params[1], rec);
        return { rows: [rec], rowCount: 1 };
      }
      if (n.includes('FROM web_access_tokens t') && n.includes('t.token_hash = $1')) {
        const hit = tokens.get(params[0]);
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (n.includes('UPDATE web_access_tokens SET last_used_at')) return { rows: [], rowCount: 1 };
      if (n.includes('SELECT value FROM app_settings WHERE key = $1')) {
        if (params[0] === 'bot_slot_settings') return { rows: [{ value: slotSettings }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      if (n.includes('INSERT INTO app_settings')) {
        if (params[0] === 'bot_slot_settings') slotSettings = JSON.parse(params[1]);
        return { rows: [], rowCount: 1 };
      }
      if (n.includes('SELECT extra_bot_slots FROM user_creator_settings WHERE user_telegram_id = $1')) {
        const val = extraSlotsByUser.get(Number(params[0])) || 0;
        return { rows: [{ extra_bot_slots: val }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO user_creator_settings') && n.includes('extra_bot_slots + 1')) {
        const uid = Number(params[0]);
        const next = (extraSlotsByUser.get(uid) || 0) + 1;
        extraSlotsByUser.set(uid, next);
        return { rows: [{ extra_bot_slots: next }], rowCount: 1 };
      }
      if (n.includes('SELECT COUNT(*)::int AS used FROM delivery_bots WHERE owner_telegram_id = $1')) {
        const uid = Number(params[0]);
        return { rows: [{ used: bots.filter((b) => b.owner_telegram_id === uid).length }], rowCount: 1 };
      }
      if (n.includes('FROM creator_wallets') && n.includes('FOR UPDATE')) {
        const avail = walletByUser.get(Number(params[0])) || 0;
        return { rows: [{ available_minor: avail }], rowCount: 1 };
      }
      if (n.includes('SELECT available_minor, locked_minor, total_earned_minor, total_withdrawn_minor') && n.includes('creator_wallets')) {
        const avail = walletByUser.get(Number(params[0])) || 0;
        return { rows: [{ currency: 'INR', available_minor: avail, locked_minor: 0, total_earned_minor: avail, total_withdrawn_minor: 0 }], rowCount: 1 };
      }
      if (n.includes('UPDATE creator_wallets SET available_minor = available_minor - $2')) {
        const uid = Number(params[0]);
        const debit = Number(params[1]);
        const avail = walletByUser.get(uid) || 0;
        if (avail < debit) return { rows: [], rowCount: 0 };
        walletByUser.set(uid, avail - debit);
        return { rows: [{ available_minor: avail - debit }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO bot_slot_purchases')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (n.includes('INSERT INTO wallet_ledger')) return { rows: [], rowCount: 1 };
      if (n.includes('FROM delivery_bots') && n.includes('ORDER BY') && n.includes('LIMIT 1')) {
        const uid = Number(params[0]);
        const match = bots.find((b) => b.owner_telegram_id === uid && b.is_enabled) || null;
        return { rows: match ? [{ username: match.username }] : [], rowCount: match ? 1 : 0 };
      }
      if (n.includes('FROM delivery_bots d')) {
        const uid = params.length ? Number(params[0]) : null;
        const matched = uid === null ? bots : bots.filter((b) => b.owner_telegram_id === uid);
        return { rows: matched, rowCount: matched.length };
      }
      if (n.includes('FROM storage_channels')) return { rows: [{ id: 1, owner_telegram_id: creatorA, is_enabled: true }], rowCount: 1 };
      if (n.includes('SELECT 1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  const ownerToken = (await issueOrRegenerateAccessToken(pool, ownerId, { first_name: 'Owner' })).token;
  const tokenA = (await issueOrRegenerateAccessToken(pool, creatorA, { first_name: 'Alice' })).token;
  const tokenB = (await issueOrRegenerateAccessToken(pool, creatorB, { first_name: 'Bob' })).token;

  const deliveryManager = {
    async addToken(rawToken, actorId, ownerScope) {
      const used = bots.filter((b) => b.owner_telegram_id === ownerScope).length;
      const allowed = FREE_CREATOR_BOT_SLOTS + (extraSlotsByUser.get(ownerScope) || 0);
      if (ownerScope !== null && used >= allowed) {
        throw Object.assign(new Error('Bot slot limit reached.'), { code: 'BOT_SLOT_LIMIT_REACHED', statusCode: 402 });
      }
      const nextBot = {
        id: bots.length + 1,
        telegram_bot_id: String(7000 + bots.length + 1),
        username: `CreatorBot${bots.length + 1}`,
        role: used === 0 ? 'primary' : 'backup',
        priority: 10 + used * 10,
        is_enabled: true,
        runtime_status: 'running',
        owner_telegram_id: ownerScope,
        total_users: 12,
        active_users_7d: 5,
        total_interactions: 40,
      };
      bots.push(nextBot);
      return nextBot;
    },
    async replaceToken(botId, rawToken, actorId, ownerScope) {
      const target = bots.find((b) => b.id === Number(botId) && b.owner_telegram_id === ownerScope);
      if (!target) throw Object.assign(new Error('Delivery Bot not found.'), { statusCode: 404 });
      target.telegram_bot_id = '9988';
      target.username = 'ReplacedFreshBot';
      target.runtime_status = 'running';
      cacheDeletePrefix('delivery-bots:');
      return { bot: target, checks: [{ status: 'ok' }] };
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
    deliveryManager,
    config: { adminIds: [ownerId], tokenEncryptionKey: randomBytes(32).toString('base64') },
  }, { info() {}, warn() {}, error() {} });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const hOwner = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };
    const hA = { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' };
    const hB = { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' };

    // 1. Creator cannot set slot price (403); Owner can update it (200)
    const creatorPriceAttempt = await fetch(`${base}/api/panel/owner/bot-slot-settings`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ price: '49' }),
    });
    assert.equal(creatorPriceAttempt.status, 403);

    const ownerPriceSet = await fetch(`${base}/api/panel/owner/bot-slot-settings`, {
      method: 'POST',
      headers: hOwner,
      body: JSON.stringify({ price: '149', starsPrice: 90 }),
    });
    assert.equal(ownerPriceSet.status, 200);
    const ownerPriceJson = await ownerPriceSet.json();
    assert.equal(ownerPriceJson.settings.priceMinor, 14900);
    assert.equal(ownerPriceJson.settings.starsPrice, 90);

    // 2. Creator adds 1st delivery bot for free
    const firstBotRes = await fetch(`${base}/api/panel/bots`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345' }),
    });
    assert.equal(firstBotRes.status, 201);
    const firstBotJson = await firstBotRes.json();
    assert.equal(firstBotJson.slots.usedSlots, 1);
    assert.equal(firstBotJson.slots.remainingSlots, 0);

    // Existing links resolve dynamically to CreatorBot1
    const usernameBefore = await getShareableBotUsername(pool, creatorA);
    assert.equal(usernameBefore, 'CreatorBot1');
    assert.equal(buildShareableUrl(usernameBefore, 's_demo123'), 'https://t.me/CreatorBot1?start=s_demo123');
    assert.equal(buildShareableUrl(usernameBefore, 'pf_demo123'), 'https://t.me/CreatorBot1?start=pf_demo123');
    assert.equal(buildShareableUrl(usernameBefore, 'pb_demo123'), 'https://t.me/CreatorBot1?start=pb_demo123');

    // 3. Adding 2nd delivery bot before unlocking slot returns 402 BOT_SLOT_LIMIT_REACHED
    const blockedRes = await fetch(`${base}/api/panel/bots`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ token: '223456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345' }),
    });
    assert.equal(blockedRes.status, 402);
    const blockedJson = await blockedRes.json();
    assert.equal(blockedJson.code, 'BOT_SLOT_LIMIT_REACHED');

    // 4. Replace existing deleted bot in-place -> succeeds without needing extra slot & updates all existing links
    const crossReplace = await fetch(`${base}/api/panel/bots/1/replace`, {
      method: 'POST',
      headers: hB,
      body: JSON.stringify({ token: '323456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345' }),
    });
    assert.equal(crossReplace.status, 404);

    const replaceRes = await fetch(`${base}/api/panel/bots/1/replace`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ token: '323456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345' }),
    });
    assert.equal(replaceRes.status, 200);
    const replaceJson = await replaceRes.json();
    assert.equal(replaceJson.bot.id, 1);
    assert.equal(replaceJson.bot.username, 'ReplacedFreshBot');

    const usernameAfter = await getShareableBotUsername(pool, creatorA);
    assert.equal(usernameAfter, 'ReplacedFreshBot');
    assert.equal(buildShareableUrl(usernameAfter, 's_demo123'), 'https://t.me/ReplacedFreshBot?start=s_demo123');
    assert.equal(buildShareableUrl(usernameAfter, 'pf_demo123'), 'https://t.me/ReplacedFreshBot?start=pf_demo123');
    assert.equal(buildShareableUrl(usernameAfter, 'pb_demo123'), 'https://t.me/ReplacedFreshBot?start=pb_demo123');

    // 5. Creator unlocks +1 slot using wallet balance -> now 2nd bot succeeds
    const unlockRes = await fetch(`${base}/api/panel/bots/slots/checkout`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ method: 'wallet' }),
    });
    assert.equal(unlockRes.status, 200);
    const unlockJson = await unlockRes.json();
    assert.equal(unlockJson.paid, true);
    assert.equal(unlockJson.slots.totalAllowed, 2);
    assert.equal(unlockJson.slots.remainingSlots, 1);

    const secondBotRes = await fetch(`${base}/api/panel/bots`, {
      method: 'POST',
      headers: hA,
      body: JSON.stringify({ token: '423456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345' }),
    });
    assert.equal(secondBotRes.status, 201);
    const secondBotJson = await secondBotRes.json();
    assert.equal(secondBotJson.slots.usedSlots, 2);
    assert.equal(secondBotJson.slots.remainingSlots, 0);

    // 6. Frontend UI assertions
    const appJs = await readFile(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
    assert.match(appJs, /data-cbot-replace=/);
    assert.match(appJs, /Change Bot/);
    assert.match(appJs, /btn-unlock-bot-slot/);
    assert.match(appJs, /BOT_SLOT_LIMIT_REACHED/);
    assert.match(appJs, /data-owner-slot-price=/);
    assert.match(appJs, /Set Slot Price/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
