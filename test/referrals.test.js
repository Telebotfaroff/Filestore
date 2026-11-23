import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_REFERRAL_REWARD_MINOR,
  REFERRAL_TOKEN_RE,
  generateUniqueReferralToken,
  buildReferralDeepLink,
  getReferralSettings,
  setReferralSettings,
  getOrCreateReferralToken,
  claimReferralOnStart,
} from '../src/wallet/referral-repository.js';
import { createMainBot } from '../src/bot/main.js';
import { issueOrRegenerateAccessToken } from '../src/web/token-repository.js';
import { startHttpServer } from '../src/server.js';
import { cacheDeletePrefix } from '../src/utils/cache.js';

function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function createReferralPool(initial = {}) {
  const users = new Map(initial.users || []);
  const codesByUser = new Map(initial.codesByUser || []);
  const userByCode = new Map(
    [...codesByUser.entries()].map(([uid, token]) => [token, uid]),
  );
  const referralsByReferred = new Map();
  const referralsList = [];
  const wallets = new Map(initial.wallets || []);
  const ledger = [];
  let settings = initial.settings || {
    enabled: true,
    rewardMinor: DEFAULT_REFERRAL_REWARD_MINOR,
    currency: 'INR',
  };
  let nextRefId = 1;

  const query = async (sql, params = []) => {
    const n = normSql(sql);
    if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK' || n.includes('pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 };
    }

    if (n.includes('SELECT value FROM app_settings WHERE key = $1')) {
      return { rows: settings ? [{ value: settings }] : [], rowCount: settings ? 1 : 0 };
    }
    if (n.includes('INSERT INTO app_settings')) {
      settings = JSON.parse(params[1]);
      return { rows: [], rowCount: 1 };
    }

    if (n.includes('SELECT telegram_id FROM users WHERE telegram_id = $1')) {
      const uid = Number(params[0]);
      return users.has(uid) ? { rows: [{ telegram_id: uid }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (n.includes('INSERT INTO users')) {
      const uid = Number(params[0]);
      const isNew = !users.has(uid);
      if (isNew) {
        users.set(uid, {
          telegram_id: uid,
          username: params[1] ?? null,
          first_name: params[2] ?? null,
          last_name: params[3] ?? null,
          started_at: new Date(),
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (n.includes('SELECT token FROM referral_codes WHERE user_telegram_id = $1')) {
      const tok = codesByUser.get(Number(params[0]));
      return tok ? { rows: [{ token: tok }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (n.includes('INSERT INTO referral_codes')) {
      const uid = Number(params[0]);
      const tok = String(params[1]);
      if (codesByUser.has(uid)) return { rows: [], rowCount: 0 };
      if (userByCode.has(tok)) {
        const err = new Error('duplicate token');
        err.code = '23505';
        throw err;
      }
      codesByUser.set(uid, tok);
      userByCode.set(tok, uid);
      return { rows: [{ token: tok }], rowCount: 1 };
    }
    if (n.includes('SELECT user_telegram_id FROM referral_codes WHERE token = $1')) {
      const uid = userByCode.get(String(params[0]));
      return uid ? { rows: [{ user_telegram_id: uid }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (n.includes('SELECT id FROM referrals WHERE referred_telegram_id = $1')) {
      const row = referralsByReferred.get(Number(params[0]));
      return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (n.includes('AS old_user') && n.includes('AS has_payments')) {
      const uid = Number(params[0]);
      const u = users.get(uid);
      const oldUser = Boolean(u?.started_at && (Date.now() - new Date(u.started_at).getTime()) > 30_000);
      return {
        rows: [{
          old_user: oldUser,
          has_code: codesByUser.has(uid),
          has_referred: referralsList.some((r) => r.referrer_telegram_id === uid),
          has_files: false,
          has_links: false,
          has_bot_activity: false,
          has_payments: false,
        }],
        rowCount: 1,
      };
    }

    if (n.includes('INSERT INTO referrals')) {
      const referrerId = Number(params[0]);
      const referredId = Number(params[1]);
      if (referralsByReferred.has(referredId)) return { rows: [], rowCount: 0 };
      const row = {
        id: nextRefId++,
        referrer_telegram_id: referrerId,
        referred_telegram_id: referredId,
        referral_token: params[2],
        reward_minor: Number(params[3]),
        currency: params[4],
        status: 'credited',
        created_at: new Date().toISOString(),
      };
      referralsByReferred.set(referredId, row);
      referralsList.unshift(row);
      return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
    }

    if (n.includes('INSERT INTO creator_wallets')) {
      const uid = Number(params[0]);
      const currency = params[1];
      const delta = Number(params[2]);
      const key = `${uid}:${currency}`;
      const cur = wallets.get(key) || {
        currency,
        available_minor: 0,
        locked_minor: 0,
        total_earned_minor: 0,
        total_withdrawn_minor: 0,
      };
      cur.available_minor += delta;
      cur.total_earned_minor += delta;
      wallets.set(key, cur);
      return { rows: [{ available_minor: cur.available_minor }], rowCount: 1 };
    }

    if (n.includes('SELECT currency, available_minor, locked_minor')) {
      const uid = Number(params[0]);
      const inr = wallets.get(`${uid}:INR`);
      return { rows: inr ? [inr] : [], rowCount: inr ? 1 : 0 };
    }

    if (n.includes('INSERT INTO wallet_ledger')) {
      ledger.push({
        id: ledger.length + 1,
        user_telegram_id: Number(params[0]),
        currency: params[1],
        entry_type: 'referral_reward',
        amount_minor: Number(params[2]),
        balance_after_minor: Number(params[3]),
        reference_code: params[4],
        note: params[5],
        created_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (n.includes('FROM wallet_ledger') && n.includes('WHERE user_telegram_id = $1')) {
      const uid = Number(params[0]);
      const rows = ledger.filter((l) => l.user_telegram_id === uid).slice().reverse();
      return { rows, rowCount: rows.length };
    }

    if (n.includes('SELECT COUNT(*)::int AS total_referrals') && n.includes('WHERE referrer_telegram_id = $1')) {
      const uid = Number(params[0]);
      const mine = referralsList.filter((r) => r.referrer_telegram_id === uid);
      return {
        rows: [{
          total_referrals: mine.length,
          total_earned_minor: mine.reduce((s, r) => s + r.reward_minor, 0),
        }],
        rowCount: 1,
      };
    }

    if (n.includes('FROM referrals r') && n.includes('WHERE r.referrer_telegram_id = $1')) {
      const uid = Number(params[0]);
      const rows = referralsList
        .filter((r) => r.referrer_telegram_id === uid)
        .map((r) => {
          const rd = users.get(r.referred_telegram_id) || {};
          return { ...r, username: rd.username ?? null, first_name: rd.first_name ?? null };
        });
      return { rows, rowCount: rows.length };
    }

    if (n.includes('COUNT(DISTINCT referrer_telegram_id)::int AS unique_referrers')) {
      const unique = new Set(referralsList.map((r) => r.referrer_telegram_id)).size;
      const totalRewarded = referralsList.reduce((s, r) => s + r.reward_minor, 0);
      return {
        rows: [{
          total_referrals: referralsList.length,
          total_rewarded_minor: totalRewarded,
          unique_referrers: unique,
        }],
        rowCount: 1,
      };
    }

    if (n.includes('FROM referrals r') && n.includes('LIMIT $1')) {
      const rows = referralsList.slice(0, Number(params[0]) || 50).map((r) => {
        const rr = users.get(r.referrer_telegram_id) || {};
        const rd = users.get(r.referred_telegram_id) || {};
        return {
          ...r,
          referrer_username: rr.username ?? null,
          referrer_first_name: rr.first_name ?? null,
          referred_username: rd.username ?? null,
          referred_first_name: rd.first_name ?? null,
        };
      });
      return { rows, rowCount: rows.length };
    }

    if (n.includes('FROM user_creator_settings WHERE user_telegram_id = $1')) {
      return { rows: [{ user_telegram_id: Number(params[0]), checkpoint_enabled: false, force_sub_enabled: false, payout_upi_id: null, extra_bot_slots: 0 }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    query,
    connect: async () => ({ query, release() {} }),
    state: { users, codesByUser, referralsList, wallets, ledger, getSettings: () => settings },
  };
}

test('032_referrals migration defines referral_codes, referrals, referral_reward ledger type, and default ₹1 setting', async () => {
  const sql = await readFile(
    new URL('../src/database/migrations/032_referrals.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS referral_codes/);
  assert.match(sql, /token TEXT NOT NULL UNIQUE/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS referrals/);
  assert.match(sql, /referred_telegram_id BIGINT NOT NULL UNIQUE/);
  assert.match(sql, /CHECK \(referrer_telegram_id <> referred_telegram_id\)/);
  assert.match(sql, /'referral_reward'/);
  assert.match(sql, /'referral_settings'/);
  assert.match(sql, /"rewardMinor":\s*100/);
});

test('Referral tokens are unique URL-safe strings and deep links format properly', async () => {
  cacheDeletePrefix('referral:');
  const pool = createReferralPool();
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const tok = generateUniqueReferralToken();
    assert.match(tok, REFERRAL_TOKEN_RE);
    assert.ok(!seen.has(tok), 'Tokens must be unique');
    seen.add(tok);
  }

  const tok1 = await getOrCreateReferralToken(pool, 1001);
  const tok1Again = await getOrCreateReferralToken(pool, 1001);
  const tok2 = await getOrCreateReferralToken(pool, 1002);
  assert.equal(tok1, tok1Again);
  assert.notEqual(tok1, tok2);
  assert.equal(
    buildReferralDeepLink('@Filestore_advbot', tok1),
    `https://t.me/Filestore_advbot?start=ref_${tok1}`,
  );
});

test('claimReferralOnStart blocks self-referrals, bots, existing users, duplicate claims, and paused program, and atomically credits new referrals', async () => {
  cacheDeletePrefix('referral:');
  const pool = createReferralPool({
    users: [
      [5001, { telegram_id: 5001, username: 'referrer', first_name: 'Ref', started_at: new Date(Date.now() - 120_000) }],
      [5002, { telegram_id: 5002, username: 'olduser', first_name: 'Old', started_at: new Date(Date.now() - 120_000) }],
    ],
  });
  const token = await getOrCreateReferralToken(pool, 5001);

  // 1. Self-referral rejected
  const selfRes = await claimReferralOnStart(pool, {
    referredUser: { id: 5001, is_bot: false, first_name: 'Ref' },
    token,
    isNewUser: false,
  });
  assert.equal(selfRes.credited, false);
  assert.equal(selfRes.reason, 'self_referral');

  // 2. Bot account rejected
  const botRes = await claimReferralOnStart(pool, {
    referredUser: { id: 9001, is_bot: true, first_name: 'SpamBot' },
    token,
    isNewUser: true,
  });
  assert.equal(botRes.credited, false);
  assert.equal(botRes.reason, 'invalid_user');

  // 3. Invalid token rejected
  const badTokRes = await claimReferralOnStart(pool, {
    referredUser: { id: 9002, is_bot: false, first_name: 'New' },
    token: 'NONEXISTENT99',
    isNewUser: true,
  });
  assert.equal(badTokRes.credited, false);
  assert.equal(badTokRes.reason, 'invalid_token');

  // 4. Existing/returning user rejected
  const oldRes = await claimReferralOnStart(pool, {
    referredUser: { id: 5002, is_bot: false, first_name: 'Old' },
    token,
    isNewUser: false,
  });
  assert.equal(oldRes.credited, false);
  assert.equal(oldRes.reason, 'already_registered');

  // 5. Genuine new user credited ₹1.00 (100 paise)
  const okRes = await claimReferralOnStart(pool, {
    referredUser: { id: 6001, is_bot: false, username: 'fresh_user', first_name: 'Fresh' },
    token,
    isNewUser: true,
  });
  assert.equal(okRes.credited, true);
  assert.equal(okRes.rewardMinor, 100);
  assert.equal(okRes.balanceAfterMinor, 100);
  assert.equal(pool.state.wallets.get('5001:INR').available_minor, 100);
  assert.equal(pool.state.ledger.length, 1);
  assert.equal(pool.state.ledger[0].entry_type, 'referral_reward');

  // 6. Same referred user cannot claim again (even with another token)
  const tokOther = await getOrCreateReferralToken(pool, 5002);
  const dupRes = await claimReferralOnStart(pool, {
    referredUser: { id: 6001, is_bot: false, first_name: 'Fresh' },
    token: tokOther,
    isNewUser: true,
  });
  assert.equal(dupRes.credited, false);
  assert.equal(dupRes.reason, 'already_referred');

  // 7. Paused program rejects new referrals; updated reward ₹2.50 credits ₹2.50 when re-enabled
  await setReferralSettings(pool, { enabled: false, rewardMinor: 250 }, 1);
  const pausedRes = await claimReferralOnStart(pool, {
    referredUser: { id: 6002, is_bot: false, first_name: 'Waiter' },
    token,
    isNewUser: true,
  });
  assert.equal(pausedRes.credited, false);
  assert.equal(pausedRes.reason, 'disabled');

  await setReferralSettings(pool, { enabled: true, rewardMinor: 250 }, 1);
  const ok2 = await claimReferralOnStart(pool, {
    referredUser: { id: 6002, is_bot: false, first_name: 'Waiter' },
    token,
    isNewUser: true,
  });
  assert.equal(ok2.credited, true);
  assert.equal(ok2.rewardMinor, 250);
  assert.equal(pool.state.wallets.get('5001:INR').available_minor, 350);
});

test('Main Bot /start ref_<token> credits new referral, notifies referrer, and /referral shows unique link', async () => {
  cacheDeletePrefix('referral:');
  const pool = createReferralPool();
  const refToken = await getOrCreateReferralToken(pool, 7001);

  const notifications = [];
  const mainBot = createMainBot(
    {
      mainBotToken: '123456:TESTTOKEN',
      adminIds: [1],
      tokenEncryptionKey: randomBytes(32).toString('base64'),
      deliveryManager: { list: async () => [] },
      notifyTelegram: {
        sendMessage: async (chatId, text, extra) => {
          notifications.push({ chatId, text, extra });
        },
      },
    },
    { warn() {}, error() {}, info() {} },
    pool,
  );
  mainBot.botInfo = { id: 123456, is_bot: true, first_name: 'Main', username: 'FileStoreMainBot' };
  const sent = [];
  mainBot.context.reply = async function (text, extra) {
    sent.push({ chatId: this.chat?.id, text, extra });
    return { message_id: sent.length };
  };
  mainBot.context.answerCbQuery = async () => true;

  // Brand-new user joins via /start ref_<token>
  await mainBot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 7002, type: 'private' },
      from: { id: 7002, is_bot: false, username: 'newbie', first_name: 'Newbie' },
      text: `/start ref_${refToken}`,
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pool.state.wallets.get('7001:INR').available_minor, 100);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].chatId, 7001);
  assert.match(notifications[0].text, /New Successful Referral!/);
  assert.match(notifications[0].text, /\+1\.00 INR/);
  assert.ok(sent.some((m) => /Welcome via Referral!/i.test(m.text)));
  assert.ok(sent.some((m) => /FileStore Creator Hub/i.test(m.text)));

  // Existing user 7002 repeating /start ref_<token> does NOT double-credit
  await mainBot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 7002, type: 'private' },
      from: { id: 7002, is_bot: false, username: 'newbie', first_name: 'Newbie' },
      text: `/start ref_${refToken}`,
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });
  assert.equal(pool.state.wallets.get('7001:INR').available_minor, 100);

  // User 7001 opens /referral and receives their unique token & link
  await mainBot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 7001, type: 'private' },
      from: { id: 7001, is_bot: false, first_name: 'Referrer' },
      text: '/referral',
      entities: [{ offset: 0, length: 9, type: 'bot_command' }],
    },
  });
  const refCard = sent.at(-1);
  assert.match(refCard.text, /Refer &amp; Earn Program/);
  assert.match(refCard.text, new RegExp(`ref_${refToken}`));
  assert.match(refCard.text, /Total Referrals:<\/b> <code>1<\/code>/);
});

test('Web Panel Owner can configure referral reward and Creators receive referral info in /api/panel/wallet', async () => {
  cacheDeletePrefix('referral:');
  const adminId = 1;
  const creatorId = 4455;
  const tokens = new Map();
  let storedReferralSettings = { enabled: true, rewardMinor: 100, currency: 'INR' };

  const pool = {
    async query(sql, params = []) {
      const n = normSql(sql);
      if (n.includes('SELECT value FROM app_settings WHERE key = $1')) {
        return { rows: [{ value: storedReferralSettings }], rowCount: 1 };
      }
      if (n.includes('INSERT INTO app_settings')) {
        storedReferralSettings = JSON.parse(params[1]);
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
      if (n.includes('SELECT token FROM referral_codes')) {
        return { rows: [{ token: 'TESTTOKEN123' }], rowCount: 1 };
      }
      if (n.includes('SELECT COUNT(*)::int AS total_referrals') && n.includes('WHERE referrer_telegram_id = $1')) {
        return { rows: [{ total_referrals: 3, total_earned_minor: 300 }], rowCount: 1 };
      }
      if (n.includes('COUNT(DISTINCT referrer_telegram_id)::int AS unique_referrers')) {
        return { rows: [{ total_referrals: 3, total_rewarded_minor: 300, unique_referrers: 1 }], rowCount: 1 };
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
    { warn() {}, error() {}, info() {} },
  );
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Non-owner blocked from owner referral endpoints
    const forbidden = await fetch(`${baseUrl}/api/panel/owner/referrals`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(forbidden.status, 403);

    // Owner updates reward to ₹5.00 (500 paise)
    const updateRes = await fetch(`${baseUrl}/api/panel/owner/referral-settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true, reward: '5.00' }),
    });
    assert.equal(updateRes.status, 200);
    const updateJson = await updateRes.json();
    assert.equal(updateJson.settings.rewardMinor, 500);

    // Owner reads referral overview
    const ownerList = await fetch(`${baseUrl}/api/panel/owner/referrals`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerList.status, 200);
    const ownerJson = await ownerList.json();
    assert.equal(ownerJson.settings.rewardMinor, 500);
    assert.equal(ownerJson.summary.totalReferrals, 3);

    // Creator wallet endpoint exposes unique referral token, shareUrl, and updated reward rate
    const walletRes = await fetch(`${baseUrl}/api/panel/wallet`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(walletRes.status, 200);
    const walletJson = await walletRes.json();
    assert.equal(walletJson.referral.token, 'TESTTOKEN123');
    assert.equal(walletJson.referral.shareUrl, 'https://t.me/Filestore_advbot?start=ref_TESTTOKEN123');
    assert.equal(walletJson.referral.settings.rewardMinor, 500);
    assert.equal(walletJson.referral.totalReferrals, 3);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
