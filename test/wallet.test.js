import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_WITHDRAWAL_INR_MINOR,
  creditCreatorSale,
  requestWithdrawal,
  approveWithdrawalPaid,
  rejectWithdrawalRefund,
} from '../src/wallet/repository.js';
import { applyVerifiedPayment } from '../src/payments/fulfillment-repository.js';
import { registerWalletUi } from '../src/bot/wallet-ui.js';

function createFakeBot() {
  const commands = new Map();
  const actions = [];
  return {
    command(name, handler) { commands.set(name, handler); },
    action(pattern, handler) { actions.push({ pattern, handler }); },
    commands,
    actions,
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

function createWalletMockDb() {
  const wallets = new Map();
  const settings = new Map();
  const ledger = [];
  const withdrawals = [];
  const activityLogs = [];
  let nextLedgerId = 1;
  let nextWdId = 1;

  const getWallet = (uid, currency) => wallets.get(`${uid}:${currency}`);

  const query = async (sql, params = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };

    if (sql.includes('FROM user_creator_settings WHERE user_telegram_id = $1')) {
      const s = settings.get(Number(params[0]));
      return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
    }

    if (sql.includes('INSERT INTO user_creator_settings') && sql.includes('payout_upi_id')) {
      const uid = Number(params[0]);
      const prev = settings.get(uid) ?? { user_telegram_id: uid, checkpoint_enabled: false, force_sub_enabled: false, payout_upi_id: null };
      const next = { ...prev, payout_upi_id: params[1], updated_at: new Date() };
      settings.set(uid, next);
      return { rows: [next], rowCount: 1 };
    }

    if (sql.includes('FROM wallet_ledger') && sql.includes('payment_transaction_id = $1')) {
      const dup = ledger.find((l) => l.payment_transaction_id === params[0] && l.entry_type === 'sale_credit');
      return { rows: dup ? [dup] : [], rowCount: dup ? 1 : 0 };
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
        updated_at: new Date(),
      };
      existing.available_minor += amt;
      existing.total_earned_minor += amt;
      existing.updated_at = new Date();
      wallets.set(key, existing);
      return { rows: [existing], rowCount: 1 };
    }

    if (sql.includes('FROM creator_wallets') && sql.includes('WHERE user_telegram_id = $1 AND currency = $2')) {
      const w = getWallet(Number(params[0]), params[1]);
      return { rows: w ? [w] : [], rowCount: w ? 1 : 0 };
    }

    if (sql.includes('FROM creator_wallets WHERE user_telegram_id = $1 ORDER BY currency')) {
      const uid = Number(params[0]);
      const rows = [...wallets.values()].filter((w) => w.user_telegram_id === uid);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('UPDATE creator_wallets') && sql.includes('available_minor = available_minor - $3')) {
      const w = getWallet(Number(params[0]), params[1]);
      const amt = Number(params[2]);
      if (!w || w.available_minor < amt) return { rows: [], rowCount: 0 };
      w.available_minor -= amt;
      w.locked_minor += amt;
      w.updated_at = new Date();
      return { rows: [w], rowCount: 1 };
    }

    if (sql.includes('UPDATE creator_wallets') && sql.includes('total_withdrawn_minor = total_withdrawn_minor + $3')) {
      const w = getWallet(Number(params[0]), params[1]);
      const amt = Number(params[2]);
      if (!w || w.locked_minor < amt) return { rows: [], rowCount: 0 };
      w.locked_minor -= amt;
      w.total_withdrawn_minor += amt;
      w.updated_at = new Date();
      return { rows: [w], rowCount: 1 };
    }

    if (sql.includes('UPDATE creator_wallets') && sql.includes('available_minor = available_minor + $3')) {
      const w = getWallet(Number(params[0]), params[1]);
      const amt = Number(params[2]);
      if (!w || w.locked_minor < amt) return { rows: [], rowCount: 0 };
      w.locked_minor -= amt;
      w.available_minor += amt;
      w.updated_at = new Date();
      return { rows: [w], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO withdrawal_requests')) {
      const row = {
        id: nextWdId++,
        user_telegram_id: Number(params[0]),
        currency: params[1],
        amount_minor: Number(params[2]),
        upi_id: params[3],
        status: 'pending',
        payout_reference: null,
        admin_note: null,
        processed_by: null,
        processed_at: null,
        created_at: new Date(),
      };
      withdrawals.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('SELECT * FROM withdrawal_requests WHERE id = $1')) {
      const row = withdrawals.find((w) => w.id === Number(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM withdrawal_requests w') && sql.includes('WHERE w.id = $1')) {
      const row = withdrawals.find((w) => w.id === Number(params[0]));
      return { rows: row ? [{ ...row, username: 'creator', first_name: 'Creator' }] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('SELECT COUNT(*)::int AS total FROM withdrawal_requests')) {
      const rows = params.length ? withdrawals.filter((w) => w.status === params[0]) : withdrawals;
      return { rows: [{ total: rows.length }], rowCount: 1 };
    }

    if (sql.includes('FROM withdrawal_requests w') && sql.includes('LIMIT')) {
      const filtered = params.length === 3 ? withdrawals.filter((w) => w.status === params[0]) : withdrawals;
      return { rows: filtered.map((w) => ({ ...w, username: 'creator', first_name: 'Creator' })), rowCount: filtered.length };
    }

    if (sql.includes('FROM withdrawal_requests WHERE user_telegram_id = $1')) {
      const rows = withdrawals.filter((w) => w.user_telegram_id === Number(params[0])).slice().reverse();
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('UPDATE withdrawal_requests') && sql.includes("SET status = 'paid'")) {
      const row = withdrawals.find((w) => w.id === Number(params[0]));
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'paid';
      row.payout_reference = params[1];
      row.admin_note = params[2];
      row.processed_by = params[3];
      row.processed_at = new Date();
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('UPDATE withdrawal_requests') && sql.includes("SET status = 'rejected'")) {
      const row = withdrawals.find((w) => w.id === Number(params[0]));
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'rejected';
      row.admin_note = params[1];
      row.processed_by = params[2];
      row.processed_at = new Date();
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO wallet_ledger')) {
      const entryType = sql.includes("'sale_credit'")
        ? 'sale_credit'
        : sql.includes("'withdrawal_hold'")
          ? 'withdrawal_hold'
          : sql.includes("'withdrawal_paid'")
            ? 'withdrawal_paid'
            : 'withdrawal_refund';
      const entry = {
        id: nextLedgerId++,
        user_telegram_id: Number(params[0]),
        currency: params[1],
        entry_type: entryType,
        amount_minor: Number(params[2]),
        balance_after_minor: Number(params[3]),
        payment_transaction_id: entryType === 'sale_credit' ? params[4] : null,
        withdrawal_request_id: entryType === 'sale_credit' ? null : params[4],
        reference_code: params[5],
        note: params[6],
        created_at: new Date(),
      };
      ledger.push(entry);
      return { rows: [entry], rowCount: 1 };
    }

    if (sql.includes('FROM wallet_ledger WHERE user_telegram_id = $1')) {
      const rows = ledger.filter((l) => l.user_telegram_id === Number(params[0])).slice().reverse();
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('INSERT INTO activity_logs')) {
      activityLogs.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    wallets,
    settings,
    ledger,
    withdrawals,
    activityLogs,
    pool: {
      query,
      connect: async () => ({ query, release() {} }),
    },
  };
}

test('creditCreatorSale is idempotent per transaction and supports INR + XTR', async () => {
  const db = createWalletMockDb();
  const client = await db.pool.connect();

  const first = await creditCreatorSale(client, {
    creatorId: 5001,
    currency: 'INR',
    amountMinor: 9900,
    paymentTransactionId: 10,
    referenceCode: 'LINK01',
  });
  assert.equal(first.credited, true);
  assert.equal(first.balanceAfterMinor, 9900);

  // Replay with same paymentTransactionId does not double credit
  const dup = await creditCreatorSale(client, {
    creatorId: 5001,
    currency: 'INR',
    amountMinor: 9900,
    paymentTransactionId: 10,
    referenceCode: 'LINK01',
  });
  assert.equal(dup.credited, false);
  assert.equal(dup.duplicate, true);
  assert.equal(db.wallets.get('5001:INR').available_minor, 9900);

  // Stars sale goes into separate XTR bucket
  const stars = await creditCreatorSale(client, {
    creatorId: 5001,
    currency: 'XTR',
    amountMinor: 50,
    paymentTransactionId: 11,
    referenceCode: 'LINK01',
  });
  assert.equal(stars.credited, true);
  assert.equal(db.wallets.get('5001:XTR').total_earned_minor, 50);
  assert.equal(db.wallets.get('5001:INR').available_minor, 9900);
});

test('applyVerifiedPayment routes creator paid link revenue to creator wallet, excluding FamPay dust, admin links, and premium', async () => {
  const walletDb = createWalletMockDb();
  const transactions = new Map([
    [1, { id: 1, user_telegram_id: '888', method: 'fampay', purpose: 'premium', plan_id: 1, file_id: null, batch_link_id: null, paid_link_id: null, amount_minor: 9912, currency: 'INR', status: 'verified', session_id: 101 }],
    [2, { id: 2, user_telegram_id: '888', method: 'fampay', purpose: 'paid_file', plan_id: null, file_id: 22, batch_link_id: null, paid_link_id: 301, amount_minor: 5047, currency: 'INR', status: 'verified', session_id: 102 }],
    [3, { id: 3, user_telegram_id: '888', method: 'fampay', purpose: 'paid_file', plan_id: null, file_id: 23, batch_link_id: null, paid_link_id: 302, amount_minor: 7519, currency: 'INR', status: 'verified', session_id: 103 }],
    [4, { id: 4, user_telegram_id: '888', method: 'telegram_stars', purpose: 'paid_batch', plan_id: null, file_id: null, batch_link_id: 401, paid_link_id: null, amount_minor: 60, currency: 'XTR', status: 'verified', session_id: 104 }],
  ]);
  const sessions = new Map([
    [101, { id: 101, status: 'verified', user_telegram_id: '888', purpose: 'premium', plan_id: 1, file_id: null, batch_link_id: null, paid_link_id: null, expected_amount_minor: 9912, currency: 'INR' }],
    [102, { id: 102, status: 'verified', user_telegram_id: '888', purpose: 'paid_file', plan_id: null, file_id: 22, batch_link_id: null, paid_link_id: 301, expected_amount_minor: 5047, currency: 'INR' }],
    [103, { id: 103, status: 'verified', user_telegram_id: '888', purpose: 'paid_file', plan_id: null, file_id: 23, batch_link_id: null, paid_link_id: 302, expected_amount_minor: 7519, currency: 'INR' }],
    [104, { id: 104, status: 'verified', user_telegram_id: '888', purpose: 'paid_batch', plan_id: null, file_id: null, batch_link_id: 401, paid_link_id: null, expected_amount_minor: 60, currency: 'XTR' }],
  ]);

  const query = async (sql, params = []) => {
    if (sql.includes('FROM payment_transactions WHERE id = $1')) return { rows: [transactions.get(params[0])], rowCount: 1 };
    if (sql.includes('FROM payment_sessions WHERE id=$1')) return { rows: [sessions.get(params[0])], rowCount: 1 };
    if (sql.includes('FROM premium_plans WHERE id=$1')) return { rows: [{ id: 1, name: 'Pro', price_minor: 9900, currency: 'INR', duration_days: 30 }], rowCount: 1 };
    if (sql.includes('FROM premium_memberships')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM paid_file_links WHERE id=$1')) {
      if (params[0] === 301) return { rows: [{ id: 301, file_id: 22, price_minor: 5000, currency: 'INR', public_code: 'CREATORFILE', created_by: 7777 }], rowCount: 1 };
      return { rows: [{ id: 302, file_id: 23, price_minor: 7500, currency: 'INR', public_code: 'OWNERFILE', created_by: 1 }], rowCount: 1 };
    }
    if (sql.includes('FROM paid_batch_links WHERE id=$1')) {
      return { rows: [{ id: 401, title: 'Creator Pack', price_minor: 10000, currency: 'INR', public_code: 'CRBATCH', created_by: 7777 }], rowCount: 1 };
    }
    if (sql.includes('FROM paid_batch_items')) return { rows: [{ file_id: 31 }, { file_id: 32 }], rowCount: 2 };
    if (sql.includes('INSERT INTO paid_file_purchases') || sql.includes('INSERT INTO paid_batch_purchases')) return { rows: [{ id: 90 }], rowCount: 1 };
    if (sql.includes('UPDATE payment_transactions')) {
      transactions.get(params[0]).status = 'applied';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE payment_sessions')) {
      sessions.get(params[0]).status = 'applied';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('INSERT INTO access_grants') || sql.includes('INSERT INTO premium_memberships')) {
      return { rows: [], rowCount: 1 };
    }
    return walletDb.pool.query(sql, params);
  };

  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  };

  // 1. Premium purchase -> 100% owner revenue, zero creator credit
  const resPrem = await applyVerifiedPayment(pool, 1, { adminIds: [1] });
  assert.equal(resPrem.applied, true);
  assert.equal(resPrem.creatorCredit, undefined);
  assert.equal(walletDb.wallets.size, 0);

  // 2. Owner-created paid file -> zero creator wallet credit
  const resOwnerLink = await applyVerifiedPayment(pool, 3, { adminIds: [1] });
  assert.equal(resOwnerLink.applied, true);
  assert.equal(resOwnerLink.creatorCredit, undefined);
  assert.equal(walletDb.wallets.size, 0);

  // 3. Creator paid file via FamPay (₹50.47 including 47 paise dust) -> credits exact ₹50.00 (5000 minor)
  const resCreatorFile = await applyVerifiedPayment(pool, 2, { adminIds: [1] });
  assert.equal(resCreatorFile.applied, true);
  assert.equal(resCreatorFile.creatorCredit.creatorId, 7777);
  assert.equal(resCreatorFile.creatorCredit.amountMinor, 5000);
  assert.equal(walletDb.wallets.get('7777:INR').available_minor, 5000);

  // 4. Creator paid batch via Telegram Stars -> credits 60 XTR
  const resCreatorBatch = await applyVerifiedPayment(pool, 4, { adminIds: [1] });
  assert.equal(resCreatorBatch.applied, true);
  assert.equal(resCreatorBatch.creatorCredit.currency, 'XTR');
  assert.equal(resCreatorBatch.creatorCredit.amountMinor, 60);
  assert.equal(walletDb.wallets.get('7777:XTR').total_earned_minor, 60);
});

test('withdrawal lifecycle atomically holds, pays with UTR, or refunds on rejection', async () => {
  const db = createWalletMockDb();
  const client = await db.pool.connect();
  await creditCreatorSale(client, { creatorId: 6001, currency: 'INR', amountMinor: 25000, paymentTransactionId: 501, referenceCode: 'SALE1' });

  // Fails if UPI is not set yet
  await assert.rejects(
    () => requestWithdrawal(db.pool, { userId: 6001, amountMinor: 10000 }),
    /Set your payout UPI ID first/,
  );

  // Fails below minimum ₹1.00
  await assert.rejects(
    () => requestWithdrawal(db.pool, { userId: 6001, amountMinor: MIN_WITHDRAWAL_INR_MINOR - 1, upiId: 'creator@fam' }),
    /at least ₹1\.00 INR/,
  );

  // Fails above available balance
  await assert.rejects(
    () => requestWithdrawal(db.pool, { userId: 6001, amountMinor: 30000, upiId: 'creator@fam' }),
    /Insufficient balance/,
  );

  // Request #1: ₹150.00 -> moves available 25000 -> 10000, locked -> 15000
  const wd1 = await requestWithdrawal(db.pool, { userId: 6001, amountMinor: 15000 });
  assert.equal(wd1.withdrawal.status, 'pending');
  assert.equal(wd1.availableAfterMinor, 10000);
  assert.equal(wd1.lockedAfterMinor, 15000);

  // Request #2: remaining ₹100.00 -> available 0, locked 25000
  const wd2 = await requestWithdrawal(db.pool, { userId: 6001 });
  assert.equal(wd2.withdrawal.amount_minor, 10000);
  assert.equal(wd2.availableAfterMinor, 0);
  assert.equal(wd2.lockedAfterMinor, 25000);

  // Owner marks #1 paid with UTR
  const paidRes = await approveWithdrawalPaid(db.pool, wd1.withdrawal.id, 1, { payoutReference: 'UTR123456789012' });
  assert.equal(paidRes.paid, true);
  assert.equal(paidRes.request.payout_reference, 'UTR123456789012');
  assert.equal(db.wallets.get('6001:INR').locked_minor, 10000);
  assert.equal(db.wallets.get('6001:INR').total_withdrawn_minor, 15000);

  // Re-approving is idempotent
  const paidDup = await approveWithdrawalPaid(db.pool, wd1.withdrawal.id, 1);
  assert.equal(paidDup.alreadyProcessed, true);
  assert.equal(db.wallets.get('6001:INR').total_withdrawn_minor, 15000);

  // Owner rejects #2 -> refunds 10000 back to available
  const rejRes = await rejectWithdrawalRefund(db.pool, wd2.withdrawal.id, 1, { adminNote: 'Invalid UPI handle' });
  assert.equal(rejRes.rejected, true);
  assert.equal(db.wallets.get('6001:INR').locked_minor, 0);
  assert.equal(db.wallets.get('6001:INR').available_minor, 10000);
});

test('wallet UI supports /me, UPI input, withdrawal submission, and restricts /withdrawals to Owner admins', async () => {
  const db = createWalletMockDb();
  const client = await db.pool.connect();
  await creditCreatorSale(client, { creatorId: 9001, currency: 'INR', amountMinor: 12000, paymentTransactionId: 777, referenceCode: 'PACK99' });

  const bot = createFakeBot();
  const sentNotifications = [];
  const telegram = {
    sendMessage: async (chatId, text, extra) => { sentNotifications.push({ chatId, text, extra }); },
  };
  const ui = registerWalletUi(bot, { adminIds: [1] }, { warn() {}, error() {} }, db.pool);

  // Creator runs /me
  let reply;
  await bot.commands.get('me')({
    from: { id: 9001 },
    reply: async (text, options) => { reply = { text, options }; },
  });
  assert.match(reply.text, /Available Balance: 120\.00 INR/);
  assert.ok(reply.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:me_upi'));
  assert.ok(reply.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:me_wd'));

  // Non-admin blocked from Owner payout queue
  let deniedReply;
  await bot.commands.get('withdrawals')({
    from: { id: 9001 },
    reply: async (text) => { deniedReply = text; },
  });
  assert.match(deniedReply, /restricted to the platform owner/i);

  // Creator saves UPI ID via interactive prompt & submits full withdrawal
  const setUpiAction = findAction(bot, 'cc:me_upi');
  let edited;
  await setUpiAction.handler({
    from: { id: 9001 },
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Set Payout UPI ID/);

  const replies = [];
  const handled = await ui.handleTextMessage({
    from: { id: 9001 },
    message: { text: 'myname@fam' },
    reply: async (text, options) => { replies.push({ text, options }); },
  });
  assert.equal(handled, true);
  assert.match(replies[0].text, /Payout UPI ID saved: myname@fam/);

  const submitAllAction = findAction(bot, 'cc:me_wd_all');
  await submitAllAction.handler({
    from: { id: 9001 },
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Confirm Withdrawal Request/);

  const confirmAction = findAction(bot, 'cc:me_wd_ok:12000');
  await confirmAction.handler({
    from: { id: 9001 },
    match: confirmAction.match,
    telegram,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Withdrawal Request #1 Submitted/);
  assert.equal(db.wallets.get('9001:INR').available_minor, 0);
  assert.equal(db.wallets.get('9001:INR').locked_minor, 12000);
  // Owner admin (1) notified of new withdrawal request
  assert.equal(sentNotifications.length, 1);
  assert.equal(sentNotifications[0].chatId, 1);
  assert.match(sentNotifications[0].text, /New Withdrawal Request #1/);
});
