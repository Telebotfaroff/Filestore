import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  listPremiumPlans,
  getPremiumPlanById,
  upsertPremiumPlan,
  setPremiumPlanEnabled,
  removePremiumPlan,
} from '../src/premium/repository.js';
import { applyVerifiedPayment } from '../src/payments/fulfillment-repository.js';
import { evaluateAccess } from '../src/access/access-manager.js';
import { notifyCreatorSale } from '../src/wallet/notifications.js';
import { buildPublicMenuKeyboard, registerControlCenter } from '../src/bot/control-center.js';
import { createDeliveryBot } from '../src/delivery/bot.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function createWalletMockState() {
  const wallets = new Map();
  const ledger = [];
  const query = async (sql, params = []) => {
    if (sql.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM wallet_ledger') && sql.includes('payment_transaction_id = $1')) {
      const hit = ledger.find((r) => r.payment_transaction_id === Number(params[0]) && r.entry_type === 'sale_credit');
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO creator_wallets')) {
      const uid = Number(params[0]);
      const curr = params[1];
      const amt = Number(params[2]);
      const key = `${uid}:${curr}`;
      const existing = wallets.get(key) ?? {
        user_telegram_id: uid,
        currency: curr,
        available_minor: 0,
        locked_minor: 0,
        total_earned_minor: 0,
        total_withdrawn_minor: 0,
      };
      existing.available_minor += amt;
      existing.total_earned_minor += amt;
      wallets.set(key, existing);
      return { rows: [{ ...existing }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO wallet_ledger')) {
      const id = ledger.length + 1;
      ledger.push({
        id,
        user_telegram_id: Number(params[0]),
        currency: params[1],
        entry_type: 'sale_credit',
        amount_minor: Number(params[2]),
        balance_after_minor: Number(params[3]),
        payment_transaction_id: params[4] ? Number(params[4]) : null,
        reference_code: params[5] ?? null,
        note: params[6] ?? null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { wallets, ledger, query };
}

test('023_creator_premium_plans migration adds owner_telegram_id to plans and memberships with per-owner name uniqueness', async () => {
  const sql = await readFile(new URL('../src/database/migrations/023_creator_premium_plans.sql', import.meta.url), 'utf8');
  assert.match(sql, /ALTER TABLE premium_plans[\s\S]*owner_telegram_id BIGINT NULL REFERENCES users\(telegram_id\)/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS premium_plans_name_key/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS premium_plans_owner_name_idx[\s\S]*COALESCE\(owner_telegram_id, 0\), name/);
  assert.match(sql, /ALTER TABLE premium_memberships[\s\S]*owner_telegram_id BIGINT NULL REFERENCES users\(telegram_id\)/);
});

test('premium repository enforces tenant scoping for creator plans vs platform owner plans', async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO premium_plans')) {
        return {
          rowCount: 1,
          rows: [{
            id: 11,
            name: params[0],
            price_minor: params[1],
            currency: params[2],
            duration_days: params[3],
            is_enabled: params[4],
            owner_telegram_id: params[6],
          }],
        };
      }
      if (sql.includes('UPDATE premium_plans SET is_enabled')) {
        return params[2] === 7777
          ? { rowCount: 1, rows: [{ id: 11, name: 'VIP', is_enabled: params[1], owner_telegram_id: 7777 }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('DELETE FROM premium_plans')) {
        return params[1] === 7777
          ? { rowCount: 1, rows: [{ id: 11, name: 'VIP', owner_telegram_id: 7777 }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM premium_plans WHERE id = $1')) {
        return params[1] === 7777
          ? { rowCount: 1, rows: [{ id: 11, name: 'VIP', price_minor: 9900, currency: 'INR', duration_days: 30, is_enabled: true, owner_telegram_id: 7777 }] }
          : { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  const created = await upsertPremiumPlan(pool, { name: 'VIP', priceMinor: 9900, currency: 'INR', durationDays: 30, enabled: true }, 7777, 7777);
  assert.equal(created.owner_telegram_id, 7777);

  await listPremiumPlans(pool, null);
  assert.match(calls.at(-1).sql, /owner_telegram_id IS NULL/);

  await listPremiumPlans(pool, 7777);
  assert.match(calls.at(-1).sql, /owner_telegram_id = \$1/);
  assert.deepEqual(calls.at(-1).params, [7777]);

  // Creator 7777 can read/toggle/delete own plan, Creator 8888 gets null
  assert.equal((await getPremiumPlanById(pool, 11, 7777))?.id, 11);
  assert.equal(await getPremiumPlanById(pool, 11, 8888), null);
  assert.equal((await setPremiumPlanEnabled(pool, 11, false, 7777))?.is_enabled, false);
  assert.equal(await setPremiumPlanEnabled(pool, 11, false, 8888), null);
  assert.equal(await removePremiumPlan(pool, 11, 8888), null);
  assert.equal((await removePremiumPlan(pool, 11, 7777))?.id, 11);
});

test('applyVerifiedPayment credits creator wallet for creator Premium plans (FamPay dust excluded + Stars XTR) and scopes membership to creator', async () => {
  const walletState = createWalletMockState();
  const insertedMemberships = [];
  const transactions = new Map([
    [10, { id: 10, user_telegram_id: '555', method: 'fampay', purpose: 'premium', plan_id: 21, file_id: null, batch_link_id: null, paid_link_id: null, amount_minor: 9937, currency: 'INR', status: 'verified', session_id: 201 }],
    [11, { id: 11, user_telegram_id: '556', method: 'telegram_stars', purpose: 'premium', plan_id: 21, file_id: null, batch_link_id: null, paid_link_id: null, amount_minor: 50, currency: 'XTR', status: 'verified', session_id: 202 }],
    [12, { id: 12, user_telegram_id: '557', method: 'fampay', purpose: 'premium', plan_id: 1, file_id: null, batch_link_id: null, paid_link_id: null, amount_minor: 14921, currency: 'INR', status: 'verified', session_id: 203 }],
  ]);
  const sessions = new Map([
    [201, { id: 201, status: 'verified', user_telegram_id: '555', purpose: 'premium', plan_id: 21, file_id: null, batch_link_id: null, paid_link_id: null, expected_amount_minor: 9937, currency: 'INR' }],
    [202, { id: 202, status: 'verified', user_telegram_id: '556', purpose: 'premium', plan_id: 21, file_id: null, batch_link_id: null, paid_link_id: null, expected_amount_minor: 50, currency: 'XTR' }],
    [203, { id: 203, status: 'verified', user_telegram_id: '557', purpose: 'premium', plan_id: 1, file_id: null, batch_link_id: null, paid_link_id: null, expected_amount_minor: 14921, currency: 'INR' }],
  ]);

  const query = async (sql, params = []) => {
    if (sql.includes('FROM payment_transactions WHERE id = $1')) return { rows: [transactions.get(params[0])], rowCount: 1 };
    if (sql.includes('FROM payment_sessions WHERE id=$1')) return { rows: [sessions.get(params[0])], rowCount: 1 };
    if (sql.includes('FROM premium_plans WHERE id=$1')) {
      if (params[0] === 21) {
        return { rows: [{ id: 21, name: 'VIP Monthly', price_minor: 9900, currency: 'INR', duration_days: 30, owner_telegram_id: 7777 }], rowCount: 1 };
      }
      return { rows: [{ id: 1, name: 'Platform Pro', price_minor: 14900, currency: 'INR', duration_days: 30, owner_telegram_id: null }], rowCount: 1 };
    }
    if (sql.includes('FROM premium_memberships')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO premium_memberships')) {
      insertedMemberships.push({ userId: params[0], planId: params[1], ownerId: params[2], expiresAt: params[3] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE payment_transactions')) {
      transactions.get(params[0]).status = 'applied';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE payment_sessions')) {
      sessions.get(params[0]).status = 'applied';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('INSERT INTO activity_logs')) return { rows: [], rowCount: 1 };
    return walletState.query(sql, params);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };

  // 1. FamPay UPI purchase of creator plan (₹99.37 with 37p dust -> exact ₹99.00 credited to creator 7777)
  const r1 = await applyVerifiedPayment(pool, 10, { adminIds: [1] });
  assert.equal(r1.applied, true);
  assert.equal(r1.ownerTelegramId, 7777);
  assert.equal(r1.creatorCredit.creatorId, 7777);
  assert.equal(r1.creatorCredit.amountMinor, 9900);
  assert.equal(r1.creatorCredit.currency, 'INR');
  assert.equal(r1.creatorCredit.saleType, 'premium_plan');
  assert.equal(r1.creatorCredit.planName, 'VIP Monthly');
  assert.equal(walletState.wallets.get('7777:INR').available_minor, 9900);
  assert.equal(insertedMemberships[0].ownerId, 7777);

  // Idempotent replay produces alreadyApplied and does NOT double-credit
  const replay = await applyVerifiedPayment(pool, 10, { adminIds: [1] });
  assert.equal(replay.alreadyApplied, true);
  assert.equal(walletState.wallets.get('7777:INR').available_minor, 9900);

  // 2. Telegram Stars purchase of creator plan -> credits XTR bucket, INR unchanged
  const r2 = await applyVerifiedPayment(pool, 11, { adminIds: [1] });
  assert.equal(r2.applied, true);
  assert.equal(r2.creatorCredit.amountMinor, 50);
  assert.equal(r2.creatorCredit.currency, 'XTR');
  assert.equal(walletState.wallets.get('7777:XTR').available_minor, 50);
  assert.equal(walletState.wallets.get('7777:INR').available_minor, 9900);

  // 3. Platform Owner plan -> NO creator wallet credit
  const r3 = await applyVerifiedPayment(pool, 12, { adminIds: [1] });
  assert.equal(r3.applied, true);
  assert.equal(r3.creatorCredit, undefined);
  assert.equal(insertedMemberships[2].ownerId, null);

  // 4. Creator sale notification formats Premium Plan sale clearly
  const sent = [];
  await notifyCreatorSale(
    { sendMessage: async (chatId, text) => sent.push({ chatId, text }) },
    r1.creatorCredit,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 7777);
  assert.match(sent[0].text, /New Premium Plan Sale Credited/);
  assert.match(sent[0].text, /VIP Monthly/);
  assert.match(sent[0].text, /\+99\.00 INR/);
});

test('evaluateAccess isolates Creator A Premium from Creator B and Platform Owner checkpoints', async () => {
  // User 555 has active Premium ONLY for Creator 7777
  const activeMemberships = [{ userId: 555, ownerId: 7777 }];
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('FROM premium_memberships')) {
        const userId = Number(params[0]);
        if (sql.includes('owner_telegram_id = $3 OR owner_telegram_id IS NULL')) {
          const reqOwner = Number(params[2]);
          const matched = activeMemberships.some((m) => m.userId === userId && (m.ownerId === reqOwner || m.ownerId === null));
          return { rowCount: matched ? 1 : 0, rows: matched ? [{ '?column?': 1 }] : [] };
        }
        // Platform file check (owner_telegram_id IS NULL)
        const matched = activeMemberships.some((m) => m.userId === userId && m.ownerId === null);
        return { rowCount: matched ? 1 : 0, rows: matched ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('FROM user_creator_settings')) {
        return { rowCount: 1, rows: [{ checkpoint_enabled: true }] };
      }
      if (sql.includes("key = 'checkpoint_enabled'")) {
        return { rowCount: 1, rows: [{ value: true }] };
      }
      if (sql.includes('FROM shortener_providers')) {
        return { rowCount: 1, rows: [{ id: 1, name: 'TestShort', base_url: 'https://s.test', api_endpoint: 'https://s.test/api', api_key_ciphertext: 'enc', verification_mode: 'signed_callback', checkpoint_minutes: 60, priority: 10 }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  // Creator A's file -> bypassed by Creator A's Premium!
  const allowA = await evaluateAccess(pool, { userId: 555, type: 'free_file', resourceId: 1, ownerId: 7777 }, { passed: true });
  assert.equal(allowA.allowed, true);
  assert.equal(allowA.reason, 'premium');

  // Creator B's file -> NOT bypassed by Creator A's Premium!
  const blockB = await evaluateAccess(pool, { userId: 555, type: 'free_file', resourceId: 2, ownerId: 8888 }, { passed: true });
  assert.equal(blockB.allowed, false);
  assert.equal(blockB.reason, 'checkpoint_required');

  // Platform Owner's file -> NOT bypassed by Creator A's Premium!
  const blockOwner = await evaluateAccess(pool, { userId: 555, type: 'free_file', resourceId: 3, ownerId: null }, { passed: true });
  assert.equal(blockOwner.allowed, false);
  assert.equal(blockOwner.reason, 'checkpoint_required');
});

test('Main Bot directs creators to Web Setup (/token) while preserving /my_plans command and tenant plan creation', async () => {
  const publicMenu = buildPublicMenuKeyboard();
  const callbacks = publicMenu.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(callbacks.includes('cc:webtok'), 'Public menu should include cc:webtok for Web Setup');
  assert.ok(!callbacks.includes('cc:plans'), 'Public menu must NOT include owner-only cc:plans');

  const actions = new Map();
  const commands = new Map();
  const textHandlers = [];
  const bot = {
    command(name, fn) {
      for (const n of (Array.isArray(name) ? name : [name])) commands.set(n, fn);
    },
    action(pattern, fn) { actions.set(pattern, fn); },
    on(event, fn) { if (event === 'text') textHandlers.push(fn); },
  };

  const plans = [];
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO premium_plans')) {
        const plan = {
          id: plans.length + 101,
          name: params[0],
          price_minor: params[1],
          currency: params[2],
          duration_days: params[3],
          is_enabled: params[4],
          owner_telegram_id: params[6],
        };
        plans.push(plan);
        return { rowCount: 1, rows: [plan] };
      }
      if (sql.includes('FROM premium_plans WHERE id = $1')) {
        const found = plans.find((p) => p.id === Number(params[0]) && p.owner_telegram_id === Number(params[1]));
        return { rowCount: found ? 1 : 0, rows: found ? [found] : [] };
      }
      if (sql.includes('FROM premium_plans')) {
        const filtered = sql.includes('owner_telegram_id = $1')
          ? plans.filter((p) => p.owner_telegram_id === Number(params[0]))
          : plans.filter((p) => p.owner_telegram_id === null);
        return { rowCount: filtered.length, rows: filtered };
      }
      if (sql.includes('FROM delivery_bots')) {
        return { rowCount: 1, rows: [{ username: 'SharedDelivBot' }] };
      }
      if (sql.includes('FROM payment_methods')) {
        return { rowCount: 1, rows: [{ is_enabled: true, public_config: { upi_id: 'owner@fam', gmail_email: 'o@gmail.com', stars_prices: { premium: {} } }, secret_ciphertext: 'enc', setup_status: 'configured' }] };
      }
      if (sql.includes('UPDATE payment_methods')) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  registerControlCenter(bot, { adminIds: [1], tokenEncryptionKey: '0'.repeat(64), deliveryManager: { list: async () => [] } }, logger, pool);

  // Trigger /my_plans as Creator 7777
  const replies = [];
  const ctxCreator = {
    from: { id: 7777, first_name: 'Alice' },
    chat: { id: 7777, type: 'private' },
    reply: async (text, extra) => { replies.push({ text, extra }); },
    editMessageText: async (text, extra) => { replies.push({ text, extra }); },
    answerCbQuery: async () => {},
  };
  await commands.get('my_plans')(ctxCreator);
  assert.match(replies.at(-1).text, /My Premium Membership Plans/);

  // Trigger cc:prompt:cplan_add
  const promptAction = [...actions.entries()].find(([k]) => k instanceof RegExp && k.test('cc:prompt:cplan_add'))[1];
  await promptAction({ ...ctxCreator, match: 'cc:prompt:cplan_add'.match(/^cc:prompt:([a-z_]+)$/) });

  // Send plan text: VIP Monthly|99|30
  const textCtx = { ...ctxCreator, message: { text: 'VIP Monthly|99|30' } };
  let handled = false;
  for (const h of textHandlers) {
    let calledNext = false;
    await h(textCtx, async () => { calledNext = true; });
    if (!calledNext) { handled = true; break; }
  }
  assert.equal(handled, true);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].owner_telegram_id, 7777);
  assert.equal(plans[0].price_minor, 9900);
  assert.match(replies.at(-1).text, /Premium Plan Saved/);
  assert.match(replies.at(-1).text, /start=prem_101/);
});

test('Delivery Bot handles /start prem_<id>, /start cprem_<creatorId>, and creator bot /premium', async () => {
  const creatorPlan = { id: 21, name: 'VIP Monthly', price_minor: 9900, currency: 'INR', duration_days: 30, is_enabled: true, owner_telegram_id: 7777 };
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO users')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM premium_plans WHERE id = $1')) {
        return Number(params[0]) === 21 ? { rowCount: 1, rows: [creatorPlan] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM premium_plans')) {
        if (sql.includes('owner_telegram_id = $1') && Number(params[0]) === 7777) {
          return { rowCount: 1, rows: [creatorPlan] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM payment_methods') && params[0] === 'telegram_stars') {
        return { rowCount: 1, rows: [{ is_enabled: true, public_config: { stars_prices: { premium: { '21': 50 } } } }] };
      }
      if (sql.includes('FROM payment_methods') && params[0] === 'fampay') {
        return { rowCount: 1, rows: [{ is_enabled: true, public_config: { upi_id: 'owner@fam', gmail_email: 'o@gmail.com', merchant_name: 'FileStore' }, secret_ciphertext: null, setup_status: 'configured' }] };
      }
      if (sql.includes('INSERT INTO payment_sessions')) {
        return { rowCount: 1, rows: [{ id: 801 }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  const replies = [];
  const invoices = [];
  const runtime = createDeliveryBot(
    { adminIds: [1], tokenEncryptionKey: '0'.repeat(64) },
    logger,
    pool,
    '123456:TESTTOKEN',
    { deliveryBotId: 5, includeGlobal: false, ownerTelegramId: 7777 },
  );
  runtime.bot.botInfo = { id: 999, is_bot: true, first_name: 'CreatorDelivBot', username: 'CreatorDelivBot' };
  runtime.bot.context.reply = async function (text, extra) { replies.push({ text, extra }); };
  runtime.bot.context.editMessageText = async function (text, extra) { replies.push({ text, extra }); };
  runtime.bot.context.answerCbQuery = async function () {};
  runtime.bot.telegram.sendInvoice = async (chatId, payload) => {
    invoices.push({ chatId, payload });
    return { message_id: 2 };
  };

  // 1. /premium on Creator 7777's own Delivery Bot lists Creator 7777's plans
  await runtime.bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1700000000,
      chat: { id: 900, type: 'private' },
      from: { id: 900, is_bot: false, first_name: 'Buyer' },
      text: '/premium',
      entities: [{ offset: 0, length: 8, type: 'bot_command' }],
    },
  });
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /Creator Premium Plans/);
  assert.match(JSON.stringify(replies[0].extra.reply_markup), /fs_premium_21/);

  // 2. /start cprem_7777 opens Creator 7777's storefront
  replies.length = 0;
  await runtime.bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: 1700000001,
      chat: { id: 900, type: 'private' },
      from: { id: 900, is_bot: false, first_name: 'Buyer' },
      text: '/start cprem_7777',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /Creator Premium Plans/);
  assert.match(JSON.stringify(replies[0].extra.reply_markup), /VIP Monthly/);

  // 3. /start prem_21 opens direct checkout (Stars invoice when only Stars is configured in mock)
  replies.length = 0;
  await runtime.bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      date: 1700000002,
      chat: { id: 900, type: 'private' },
      from: { id: 900, is_bot: false, first_name: 'Buyer' },
      text: '/start prem_21',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].payload.currency, 'XTR');
  assert.equal(invoices[0].payload.prices[0].amount, 50);
});
