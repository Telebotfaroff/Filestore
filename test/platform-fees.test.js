import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PLATFORM_FEE_SETTINGS_KEY,
  MAX_PLATFORM_FEE_BPS,
  MAX_PLATFORM_FEE_PERCENT,
  bpsToPercent,
  formatFeePercent,
  parseFeePercentToBps,
  computePlatformFee,
  getPlatformFeeSettings,
  setPlatformFeeSettings,
} from '../src/wallet/fee-repository.js';
import { applyVerifiedPayment } from '../src/payments/fulfillment-repository.js';
import { notifyCreatorSale } from '../src/wallet/notifications.js';
import { issueOrRegenerateAccessToken } from '../src/web/token-repository.js';
import { startHttpServer } from '../src/server.js';
import { cacheDeletePrefix } from '../src/utils/cache.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

test('033_platform_fees migration defines platform_fee_ledger constraints and seeds default settings', async () => {
  const sql = await readFile(
    new URL('../src/database/migrations/033_platform_fees.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS platform_fee_ledger/i);
  assert.match(sql, /payment_transaction_id BIGINT NOT NULL UNIQUE REFERENCES payment_transactions\(id\)/i);
  assert.match(sql, /sale_type TEXT NOT NULL CHECK \(sale_type IN \('paid_file', 'paid_batch', 'premium'\)\)/i);
  assert.match(sql, /fee_bps INTEGER NOT NULL CHECK \(fee_bps >= 0 AND fee_bps <= 9000\)/i);
  assert.match(sql, /INSERT INTO app_settings[\s\S]*'platform_fee_settings'[\s\S]*ON CONFLICT \(key\) DO NOTHING/i);
});

test('fee percentage parsing and exact integer fee calculation handle edge cases safely', () => {
  assert.equal(MAX_PLATFORM_FEE_BPS, 9000);
  assert.equal(MAX_PLATFORM_FEE_PERCENT, 90);

  assert.equal(parseFeePercentToBps('0'), 0);
  assert.equal(parseFeePercentToBps('10'), 1000);
  assert.equal(parseFeePercentToBps('10%'), 1000);
  assert.equal(parseFeePercentToBps('7.5'), 750);
  assert.equal(parseFeePercentToBps('12.34'), 1234);
  assert.equal(parseFeePercentToBps('90'), 9000);

  assert.equal(bpsToPercent(1000), 10);
  assert.equal(bpsToPercent(750), 7.5);
  assert.equal(formatFeePercent(1000), '10%');
  assert.equal(formatFeePercent(750), '7.5%');

  // Rejects invalid percentages
  assert.throws(() => parseFeePercentToBps('-1'), /valid percentage/i);
  assert.throws(() => parseFeePercentToBps('90.01'), /between 0% and 90%/i);
  assert.throws(() => parseFeePercentToBps('10.123'), /up to 2 decimals/i);
  assert.throws(() => parseFeePercentToBps('abc'), /valid percentage/i);
  assert.throws(() => parseFeePercentToBps(''), /required/i);

  // Exact integer half-up math with gross === fee + net invariant
  const tenPctInr = computePlatformFee(10000, 1000); // ₹100.00 @ 10%
  assert.deepEqual(tenPctInr, {
    grossAmountMinor: 10000,
    feeBps: 1000,
    feePercent: 10,
    feeAmountMinor: 1000,
    netAmountMinor: 9000,
  });

  const sevenHalfPctInr = computePlatformFee(9900, 750); // ₹99.00 @ 7.5% -> 742.5 -> 743 paise
  assert.equal(sevenHalfPctInr.feeAmountMinor, 743);
  assert.equal(sevenHalfPctInr.netAmountMinor, 9157);
  assert.equal(sevenHalfPctInr.feeAmountMinor + sevenHalfPctInr.netAmountMinor, 9900);

  const starsFee = computePlatformFee(50, 1000); // 50 XTR @ 10% -> 5 XTR fee, 45 XTR net
  assert.equal(starsFee.feeAmountMinor, 5);
  assert.equal(starsFee.netAmountMinor, 45);

  const zeroFee = computePlatformFee(5000, 0);
  assert.equal(zeroFee.feeAmountMinor, 0);
  assert.equal(zeroFee.netAmountMinor, 5000);
});

test('applyVerifiedPayment deducts configured platform fees on creator sales, skips owner sales, and stays idempotent', async () => {
  cacheDeletePrefix('platform-fee:');
  const ownerId = 100;
  const creatorId = 7777;
  const wallets = new Map();
  const walletLedger = [];
  const feeLedger = [];
  let feeSettings = { enabled: true, paidLinkFeeBps: 1000, premiumFeeBps: 1500 }; // 10% links, 15% premium

  const transactions = new Map([
    // Creator paid file ₹100.00 via FamPay (with ₹0.43 dust -> 10043 paise paid, ₹100.00 list price)
    [1, { id: 1, user_telegram_id: '501', method: 'fampay', purpose: 'paid_file', plan_id: null, file_id: 41, batch_link_id: null, paid_link_id: 301, amount_minor: 10043, currency: 'INR', status: 'verified', session_id: 901 }],
    // Creator paid batch 50 Stars
    [2, { id: 2, user_telegram_id: '502', method: 'telegram_stars', purpose: 'paid_batch', plan_id: null, file_id: null, batch_link_id: 401, paid_link_id: null, amount_minor: 50, currency: 'XTR', status: 'verified', session_id: 902 }],
    // Creator premium membership ₹200.00 via FamPay (with ₹0.19 dust)
    [3, { id: 3, user_telegram_id: '503', method: 'fampay', purpose: 'premium', plan_id: 21, file_id: null, batch_link_id: null, paid_link_id: null, amount_minor: 20019, currency: 'INR', status: 'verified', session_id: 903 }],
    // Owner-owned paid file ₹100.00 -> exempt from creator fee
    [4, { id: 4, user_telegram_id: '504', method: 'fampay', purpose: 'paid_file', plan_id: null, file_id: 42, batch_link_id: null, paid_link_id: 302, amount_minor: 10011, currency: 'INR', status: 'verified', session_id: 904 }],
    // Platform-owned premium plan -> exempt from creator fee
    [5, { id: 5, user_telegram_id: '505', method: 'fampay', purpose: 'premium', plan_id: 1, file_id: null, batch_link_id: null, paid_link_id: null, amount_minor: 14925, currency: 'INR', status: 'verified', session_id: 905 }],
    // Creator paid file when fees are paused
    [6, { id: 6, user_telegram_id: '506', method: 'fampay', purpose: 'paid_file', plan_id: null, file_id: 41, batch_link_id: null, paid_link_id: 301, amount_minor: 10022, currency: 'INR', status: 'verified', session_id: 906 }],
  ]);

  const query = async (sql, params = []) => {
    const n = normSql(sql);
    if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (n.includes('SELECT value FROM app_settings WHERE key = $1')) {
      return params[0] === PLATFORM_FEE_SETTINGS_KEY
        ? { rows: [{ value: feeSettings }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (n.includes('FROM payment_transactions WHERE id = $1')) {
      const tx = transactions.get(Number(params[0]));
      return { rows: tx ? [{ ...tx }] : [], rowCount: tx ? 1 : 0 };
    }
    if (n.includes('FROM payment_sessions WHERE id=$1')) {
      const tx = [...transactions.values()].find((t) => t.session_id === Number(params[0]));
      return tx
        ? {
            rows: [{
              id: tx.session_id,
              status: 'verified',
              user_telegram_id: tx.user_telegram_id,
              purpose: tx.purpose,
              plan_id: tx.plan_id,
              file_id: tx.file_id,
              batch_link_id: tx.batch_link_id,
              paid_link_id: tx.paid_link_id,
              expected_amount_minor: tx.amount_minor,
              currency: tx.currency,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (n.includes('FROM paid_file_links WHERE id=$1')) {
      if (Number(params[0]) === 301) {
        return { rows: [{ id: 301, file_id: 41, public_code: 'pf_creator', title: 'Creator Course', price_minor: 10000, currency: 'INR', created_by: creatorId }], rowCount: 1 };
      }
      return { rows: [{ id: 302, file_id: 42, public_code: 'pf_owner', title: 'Owner Course', price_minor: 10000, currency: 'INR', created_by: ownerId }], rowCount: 1 };
    }
    if (n.includes('FROM paid_batch_links WHERE id=$1')) {
      return { rows: [{ id: 401, public_code: 'pb_creator', title: 'Creator Pack', price_minor: 5000, currency: 'INR', created_by: creatorId }], rowCount: 1 };
    }
    if (n.includes('FROM paid_batch_items')) {
      return { rows: [{ file_id: 51 }], rowCount: 1 };
    }
    if (n.includes('FROM premium_plans WHERE id=$1')) {
      if (Number(params[0]) === 21) {
        return { rows: [{ id: 21, name: 'Creator VIP', price_minor: 20000, currency: 'INR', duration_days: 30, owner_telegram_id: creatorId }], rowCount: 1 };
      }
      return { rows: [{ id: 1, name: 'Platform Pro', price_minor: 14900, currency: 'INR', duration_days: 30, owner_telegram_id: null }], rowCount: 1 };
    }
    if (n.includes('FROM premium_memberships')) return { rows: [], rowCount: 0 };
    if (n.includes('INSERT INTO premium_memberships')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (n.includes('INSERT INTO paid_file_purchases')) return { rows: [{ id: 101 }], rowCount: 1 };
    if (n.includes('INSERT INTO paid_batch_purchases')) return { rows: [{ id: 201 }], rowCount: 1 };
    if (n.includes('INSERT INTO access_grants')) return { rows: [], rowCount: 1 };
    if (n.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };

    if (n.includes('FROM wallet_ledger') && n.includes('payment_transaction_id = $1')) {
      const hit = walletLedger.find((r) => r.payment_transaction_id === Number(params[0]) && r.entry_type === 'sale_credit');
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    }
    if (n.includes('INSERT INTO creator_wallets')) {
      const uid = Number(params[0]);
      const curr = params[1];
      const delta = Number(params[2]);
      const key = `${uid}:${curr}`;
      const existing = wallets.get(key) || { user_telegram_id: uid, currency: curr, available_minor: 0, total_earned_minor: 0 };
      existing.available_minor += delta;
      existing.total_earned_minor += delta;
      wallets.set(key, existing);
      return { rows: [{ ...existing }], rowCount: 1 };
    }
    if (n.includes('INSERT INTO wallet_ledger')) {
      const id = walletLedger.length + 1;
      walletLedger.push({
        id,
        user_telegram_id: Number(params[0]),
        currency: params[1],
        entry_type: 'sale_credit',
        amount_minor: Number(params[2]),
        balance_after_minor: Number(params[3]),
        payment_transaction_id: Number(params[4]),
        reference_code: params[5],
        note: params[6],
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (n.includes('INSERT INTO platform_fee_ledger')) {
      const txId = Number(params[0]);
      if (feeLedger.some((f) => f.payment_transaction_id === txId)) {
        return { rows: [], rowCount: 0 };
      }
      const id = feeLedger.length + 1;
      feeLedger.push({
        id,
        payment_transaction_id: txId,
        creator_telegram_id: Number(params[1]),
        sale_type: params[2],
        reference_code: params[3],
        currency: params[4],
        gross_amount_minor: Number(params[5]),
        fee_bps: Number(params[6]),
        fee_amount_minor: Number(params[7]),
        net_amount_minor: Number(params[8]),
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (n.includes('UPDATE payment_transactions')) {
      transactions.get(Number(params[0])).status = 'applied';
      return { rows: [], rowCount: 1 };
    }
    if (n.includes('UPDATE payment_sessions')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };

  const pool = { query, connect: async () => ({ query, release() {} }) };

  // 1) Creator paid file ₹100.00 @ 10% -> ₹10.00 fee, ₹90.00 net
  const r1 = await applyVerifiedPayment(pool, 1, { adminIds: [ownerId] });
  assert.equal(r1.applied, true);
  assert.equal(r1.creatorCredit.creatorId, creatorId);
  assert.equal(r1.creatorCredit.grossAmountMinor, 10000);
  assert.equal(r1.creatorCredit.feeBps, 1000);
  assert.equal(r1.creatorCredit.feePercent, 10);
  assert.equal(r1.creatorCredit.feeAmountMinor, 1000);
  assert.equal(r1.creatorCredit.amountMinor, 9000);
  assert.equal(r1.creatorCredit.netAmountMinor, 9000);
  assert.equal(wallets.get(`${creatorId}:INR`).available_minor, 9000);
  assert.equal(feeLedger.length, 1);
  assert.equal(feeLedger[0].sale_type, 'paid_file');
  assert.equal(feeLedger[0].fee_amount_minor, 1000);
  assert.equal(feeLedger[0].net_amount_minor, 9000);

  // Idempotent replay of tx 1 does NOT duplicate credit or fee ledger row
  const r1Dup = await applyVerifiedPayment(pool, 1, { adminIds: [ownerId] });
  assert.equal(r1Dup.alreadyApplied, true);
  assert.equal(wallets.get(`${creatorId}:INR`).available_minor, 9000);
  assert.equal(feeLedger.length, 1);

  // 2) Creator paid batch 50 Stars @ 10% -> 5 Stars fee, 45 Stars net
  const r2 = await applyVerifiedPayment(pool, 2, { adminIds: [ownerId] });
  assert.equal(r2.applied, true);
  assert.equal(r2.creatorCredit.grossAmountMinor, 50);
  assert.equal(r2.creatorCredit.feeAmountMinor, 5);
  assert.equal(r2.creatorCredit.amountMinor, 45);
  assert.equal(wallets.get(`${creatorId}:XTR`).available_minor, 45);
  assert.equal(feeLedger.length, 2);
  assert.equal(feeLedger[1].sale_type, 'paid_batch');
  assert.equal(feeLedger[1].currency, 'XTR');
  assert.equal(feeLedger[1].fee_amount_minor, 5);

  // 3) Creator premium plan ₹200.00 @ 15% -> ₹30.00 fee, ₹170.00 net
  const r3 = await applyVerifiedPayment(pool, 3, { adminIds: [ownerId] });
  assert.equal(r3.applied, true);
  assert.equal(r3.creatorCredit.grossAmountMinor, 20000);
  assert.equal(r3.creatorCredit.feeBps, 1500);
  assert.equal(r3.creatorCredit.feeAmountMinor, 3000);
  assert.equal(r3.creatorCredit.amountMinor, 17000);
  assert.equal(wallets.get(`${creatorId}:INR`).available_minor, 9000 + 17000);
  assert.equal(feeLedger.length, 3);
  assert.equal(feeLedger[2].sale_type, 'premium');
  assert.equal(feeLedger[2].fee_amount_minor, 3000);

  // 4 & 5) Owner paid link and platform premium plan incur zero fee & zero creator credit
  const r4 = await applyVerifiedPayment(pool, 4, { adminIds: [ownerId] });
  assert.equal(r4.applied, true);
  assert.equal(r4.creatorCredit, undefined);
  const r5 = await applyVerifiedPayment(pool, 5, { adminIds: [ownerId] });
  assert.equal(r5.applied, true);
  assert.equal(r5.creatorCredit, undefined);
  assert.equal(feeLedger.length, 3);

  // 6) Pausing platform fees credits 100% gross even with non-zero saved percentages
  feeSettings = { enabled: false, paidLinkFeeBps: 1000, premiumFeeBps: 1500 };
  const r6 = await applyVerifiedPayment(pool, 6, { adminIds: [ownerId] });
  assert.equal(r6.applied, true);
  assert.equal(r6.creatorCredit.feeAmountMinor, 0);
  assert.equal(r6.creatorCredit.amountMinor, 10000);
  assert.equal(wallets.get(`${creatorId}:INR`).available_minor, 9000 + 17000 + 10000);
  assert.equal(feeLedger.length, 3);
});

test('notifyCreatorSale displays Sale Price, Platform Fee, and Net Credited when a fee applies', async () => {
  const sent = [];
  const telegram = {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
    },
  };

  await notifyCreatorSale(telegram, {
    creatorId: 7777,
    grossAmountMinor: 10000,
    feeAmountMinor: 1000,
    feePercent: 10,
    amountMinor: 9000,
    currency: 'INR',
    balanceAfterMinor: 9000,
    referenceCode: 'pf_creator',
  }, logger);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 7777);
  assert.match(sent[0].text, /Sale Price:<\/b> <code>100\.00 INR<\/code>/);
  assert.match(sent[0].text, /Platform Fee \(10%\):<\/b> <code>-10\.00 INR<\/code>/);
  assert.match(sent[0].text, /Net Credited:<\/b> <code>\+90\.00 INR<\/code>/);

  // When fee is 0, preserves clean legacy format without fee line
  await notifyCreatorSale(telegram, {
    creatorId: 7777,
    amountMinor: 5000,
    feeAmountMinor: 0,
    currency: 'INR',
    balanceAfterMinor: 14000,
    referenceCode: 'pf_zero',
  }, logger);

  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Amount Added:<\/b> <code>\+50\.00 INR<\/code>/);
  assert.doesNotMatch(sent[1].text, /Platform Fee/);
});

test('Web Panel Owner can configure platform fees with strict RBAC and Creators see read-only fee rates', async () => {
  cacheDeletePrefix('platform-fee:');
  cacheDeletePrefix('referral:');
  const adminId = 1;
  const creatorId = 4455;
  const tokens = new Map();
  let storedFeeSettings = { enabled: true, paidLinkFeeBps: 0, premiumFeeBps: 0 };

  const pool = {
    async query(sql, params = []) {
      const n = normSql(sql);
      if (n.includes('SELECT value FROM app_settings WHERE key = $1')) {
        if (params[0] === PLATFORM_FEE_SETTINGS_KEY) {
          return { rows: [{ value: storedFeeSettings }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (n.includes('INSERT INTO app_settings')) {
        if (params[0] === PLATFORM_FEE_SETTINGS_KEY) {
          storedFeeSettings = JSON.parse(params[1]);
        }
        return { rows: [], rowCount: 1 };
      }
      if (n.includes('INSERT INTO web_access_tokens')) {
        const uid = Number(params[0]);
        const nowIso = new Date().toISOString();
        tokens.set(params[1], {
          telegram_user_id: uid,
          token_hash: params[1],
          token_prefix: params[2],
          username: 'user_' + uid,
          first_name: 'User',
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
      if (n.includes('FROM platform_fee_ledger') && n.includes('GROUP BY currency')) {
        return {
          rows: [
            { currency: 'INR', total_count: 2, total_fee_minor: 4000, total_gross_minor: 30000 },
            { currency: 'XTR', total_count: 1, total_fee_minor: 5, total_gross_minor: 50 },
          ],
          rowCount: 2,
        };
      }
      if (n.includes('FROM platform_fee_ledger f')) {
        return {
          rows: [{
            id: 1,
            payment_transaction_id: 99,
            creator_telegram_id: creatorId,
            sale_type: 'paid_file',
            reference_code: 'pf_demo',
            currency: 'INR',
            gross_amount_minor: 10000,
            fee_bps: 1000,
            fee_amount_minor: 1000,
            net_amount_minor: 9000,
            created_at: new Date().toISOString(),
            creator_username: 'creator_demo',
            creator_first_name: 'Creator',
          }],
          rowCount: 1,
        };
      }
      if (n.includes('SELECT token FROM referral_codes')) {
        return { rows: [{ token: 'TESTREF123' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release() {} }),
  };

  const { token: ownerToken } = await issueOrRegenerateAccessToken(pool, adminId);
  const { token: creatorToken } = await issueOrRegenerateAccessToken(pool, creatorId);

  const server = await startHttpServer(
    {
      port: 0,
      nodeEnv: 'test',
      database: 'connected',
      telegram: 'connected',
      delivery: 'connected',
      botUsername: 'Filestore_advbot',
      pool,
      config: { adminIds: [adminId] },
    },
    logger,
  );
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Non-owner blocked from reading or updating owner fee endpoints
    const forbiddenGet = await fetch(`${baseUrl}/api/panel/owner/fees`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(forbiddenGet.status, 403);

    const forbiddenPost = await fetch(`${baseUrl}/api/panel/owner/fee-settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creatorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, paidLinkFeePercent: 10, premiumFeePercent: 10 }),
    });
    assert.equal(forbiddenPost.status, 403);

    // Invalid rate (> 90%) rejected with 400
    const badRes = await fetch(`${baseUrl}/api/panel/owner/fee-settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, paidLinkFeePercent: 95, premiumFeePercent: 10 }),
    });
    assert.equal(badRes.status, 400);

    // Owner updates Paid Links fee to 10% and Premium Memberships fee to 12.5%
    const saveRes = await fetch(`${baseUrl}/api/panel/owner/fee-settings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, paidLinkFeePercent: '10', premiumFeePercent: '12.5' }),
    });
    assert.equal(saveRes.status, 200);
    const saveJson = await saveRes.json();
    assert.equal(saveJson.ok, true);
    assert.equal(saveJson.settings.enabled, true);
    assert.equal(saveJson.settings.paidLinkFeeBps, 1000);
    assert.equal(saveJson.settings.paidLinkFeePercent, 10);
    assert.equal(saveJson.settings.premiumFeeBps, 1250);
    assert.equal(saveJson.settings.premiumFeePercent, 12.5);

    // Owner reads fee summary + recent deductions
    const feesRes = await fetch(`${baseUrl}/api/panel/owner/fees`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(feesRes.status, 200);
    const feesJson = await feesRes.json();
    assert.equal(feesJson.settings.paidLinkFeePercent, 10);
    assert.equal(feesJson.settings.premiumFeePercent, 12.5);
    assert.equal(feesJson.summary.totalCount, 3);
    assert.equal(feesJson.summary.totalInrFeeMinor, 4000);
    assert.equal(feesJson.summary.totalXtrFeeMinor, 5);
    assert.equal(feesJson.recent.length, 1);
    assert.equal(feesJson.recent[0].feeAmountMinor, 1000);

    // Creator views receive read-only platformFees
    for (const endpoint of ['/api/panel/links', '/api/panel/plans', '/api/panel/wallet']) {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        headers: { Authorization: `Bearer ${creatorToken}` },
      });
      assert.equal(res.status, 200, `${endpoint} should return 200`);
      const json = await res.json();
      assert.equal(json.platformFees.enabled, true);
      assert.equal(json.platformFees.paidLinkFeePercent, 10);
      assert.equal(json.platformFees.premiumFeePercent, 12.5);
    }

    // Repository helpers also work directly
    const direct = await getPlatformFeeSettings(pool, { bypassCache: true });
    assert.equal(direct.paidLinkFeeBps, 1000);
    const updated = await setPlatformFeeSettings(pool, { enabled: false }, adminId);
    assert.equal(updated.enabled, false);
    assert.equal(updated.paidLinkFeeBps, 1000);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
