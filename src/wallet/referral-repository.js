import { randomBytes } from 'node:crypto';
import { cached, cacheDeletePrefix } from '../utils/cache.js';

export const DEFAULT_REFERRAL_REWARD_MINOR = 100; // ₹1.00 INR
export const MAX_REFERRAL_REWARD_MINOR = 10_000_000; // ₹1,00,000.00 INR
export const REFERRAL_SETTINGS_KEY = 'referral_settings';
export const REFERRAL_TOKEN_RE = /^[A-Za-z0-9_-]{8,32}$/;

const SETTINGS_CACHE_KEY = 'referral:settings';
const invalidateReferralSettings = () => cacheDeletePrefix('referral:');

function cleanHandle(username) {
  const clean = String(username ?? '').trim().replace(/^@+/, '');
  return /^[A-Za-z0-9_]{3,64}$/.test(clean) ? clean : null;
}

export function generateUniqueReferralToken() {
  return randomBytes(9).toString('base64url');
}

export function buildReferralDeepLink(botUsername, token) {
  const handle = cleanHandle(botUsername);
  if (!handle || !REFERRAL_TOKEN_RE.test(String(token || ''))) return null;
  return `https://t.me/${handle}?start=ref_${token}`;
}

export async function getReferralSettings(pool) {
  return cached(SETTINGS_CACHE_KEY, 15_000, async () => {
    try {
      const { rows } = await pool.query(
        'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
        [REFERRAL_SETTINGS_KEY],
      );
      const raw = rows[0]?.value;
      const enabled = raw?.enabled === undefined ? true : Boolean(raw.enabled);
      const rewardMinor = Number(raw?.rewardMinor);
      return {
        enabled,
        rewardMinor: Number.isSafeInteger(rewardMinor) && rewardMinor >= 0 && rewardMinor <= MAX_REFERRAL_REWARD_MINOR
          ? rewardMinor
          : DEFAULT_REFERRAL_REWARD_MINOR,
        currency: 'INR',
      };
    } catch {
      return {
        enabled: true,
        rewardMinor: DEFAULT_REFERRAL_REWARD_MINOR,
        currency: 'INR',
      };
    }
  });
}

export async function setReferralSettings(pool, { enabled, rewardMinor }, actorId = null) {
  const cleanReward = Number(rewardMinor);
  if (!Number.isSafeInteger(cleanReward) || cleanReward < 0 || cleanReward > MAX_REFERRAL_REWARD_MINOR) {
    throw new Error('Referral reward must be between ₹0.00 and ₹1,00,000.00 INR.');
  }

  const current = await getReferralSettings(pool);
  const payload = {
    enabled: enabled === undefined ? current.enabled : Boolean(enabled),
    rewardMinor: cleanReward,
    currency: 'INR',
  };

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [REFERRAL_SETTINGS_KEY, JSON.stringify(payload), actorId ? Number(actorId) : null],
  );
  invalidateReferralSettings();
  return payload;
}

export async function getOrCreateReferralToken(pool, userId) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid Telegram user ID.');

  await pool.query(
    'INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING',
    [uid],
  );

  const existing = await pool.query(
    'SELECT token FROM referral_codes WHERE user_telegram_id = $1 LIMIT 1',
    [uid],
  );
  if (existing.rows[0]?.token) {
    return existing.rows[0].token;
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = generateUniqueReferralToken();
    try {
      const ins = await pool.query(
        `INSERT INTO referral_codes (user_telegram_id, token)
         VALUES ($1, $2)
         ON CONFLICT (user_telegram_id) DO NOTHING
         RETURNING token`,
        [uid, candidate],
      );
      if (ins.rows[0]?.token) {
        return ins.rows[0].token;
      }
      const raced = await pool.query(
        'SELECT token FROM referral_codes WHERE user_telegram_id = $1 LIMIT 1',
        [uid],
      );
      if (raced.rows[0]?.token) {
        return raced.rows[0].token;
      }
    } catch (error) {
      if (error?.code === '23505') continue;
      throw error;
    }
  }

  throw new Error('Could not generate a unique referral token. Please try again.');
}

export async function getUserReferralSummary(pool, userId, mainBotUsername = null) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid Telegram user ID.');

  const [settings, token, statsRes, recentRes] = await Promise.all([
    getReferralSettings(pool),
    getOrCreateReferralToken(pool, uid),
    pool.query(
      `SELECT COUNT(*)::int AS total_referrals,
              COALESCE(SUM(reward_minor) FILTER (WHERE status = 'credited'), 0)::bigint AS total_earned_minor
       FROM referrals
       WHERE referrer_telegram_id = $1`,
      [uid],
    ).catch(() => ({ rows: [{ total_referrals: 0, total_earned_minor: 0 }] })),
    pool.query(
      `SELECT r.id, r.referred_telegram_id, r.reward_minor, r.currency, r.status, r.created_at,
              u.username, u.first_name
       FROM referrals r
       LEFT JOIN users u ON u.telegram_id = r.referred_telegram_id
       WHERE r.referrer_telegram_id = $1
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 10`,
      [uid],
    ).catch(() => ({ rows: [] })),
  ]);

  const stats = statsRes.rows[0] ?? {};
  return {
    settings,
    token,
    shareUrl: buildReferralDeepLink(mainBotUsername, token),
    totalReferrals: Number(stats.total_referrals ?? 0),
    totalEarnedMinor: Number(stats.total_earned_minor ?? 0),
    recentReferrals: recentRes.rows.map((r) => ({
      id: Number(r.id),
      referredUserId: String(r.referred_telegram_id),
      username: r.username ?? null,
      firstName: r.first_name ?? null,
      rewardMinor: Number(r.reward_minor ?? 0),
      currency: r.currency || 'INR',
      status: r.status || 'credited',
      createdAt: r.created_at,
    })),
  };
}

export async function listOwnerReferrals(pool, limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const [settings, summaryRes, recentRes] = await Promise.all([
    getReferralSettings(pool),
    pool.query(
      `SELECT COUNT(*)::int AS total_referrals,
              COALESCE(SUM(reward_minor) FILTER (WHERE status = 'credited'), 0)::bigint AS total_rewarded_minor,
              COUNT(DISTINCT referrer_telegram_id)::int AS unique_referrers
       FROM referrals`,
    ).catch(() => ({ rows: [{ total_referrals: 0, total_rewarded_minor: 0, unique_referrers: 0 }] })),
    pool.query(
      `SELECT r.id, r.referrer_telegram_id, r.referred_telegram_id, r.referral_token,
              r.reward_minor, r.currency, r.status, r.created_at,
              rr.username AS referrer_username, rr.first_name AS referrer_first_name,
              rd.username AS referred_username, rd.first_name AS referred_first_name
       FROM referrals r
       LEFT JOIN users rr ON rr.telegram_id = r.referrer_telegram_id
       LEFT JOIN users rd ON rd.telegram_id = r.referred_telegram_id
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $1`,
      [safeLimit],
    ).catch(() => ({ rows: [] })),
  ]);

  const s = summaryRes.rows[0] ?? {};
  return {
    settings,
    summary: {
      totalReferrals: Number(s.total_referrals ?? 0),
      totalRewardedMinor: Number(s.total_rewarded_minor ?? 0),
      uniqueReferrers: Number(s.unique_referrers ?? 0),
    },
    recent: recentRes.rows.map((r) => ({
      id: Number(r.id),
      referrerId: String(r.referrer_telegram_id),
      referrerUsername: r.referrer_username ?? null,
      referrerFirstName: r.referrer_first_name ?? null,
      referredId: String(r.referred_telegram_id),
      referredUsername: r.referred_username ?? null,
      referredFirstName: r.referred_first_name ?? null,
      token: r.referral_token,
      rewardMinor: Number(r.reward_minor ?? 0),
      currency: r.currency || 'INR',
      status: r.status || 'credited',
      createdAt: r.created_at,
    })),
  };
}

/**
 * Atomically claims a referral when a brand-new user opens /start ref_<token>.
 * Guarantees:
 * - Only valid cryptographic tokens in referral_codes are accepted.
 * - Bot accounts and self-referrals are rejected.
 * - Existing/returning users cannot farm referrals (must be new user with no prior activity).
 * - Each referred Telegram user ID can claim at most ONE referral ever (enforced by UNIQUE + TX lock).
 * - Reward is atomically credited to referrer's creator_wallets + wallet_ledger ('referral_reward').
 */
export async function claimReferralOnStart(pool, { referredUser, token, isNewUser = null }) {
  const referredId = Number(referredUser?.id);
  if (!Number.isSafeInteger(referredId) || referredId <= 0 || referredUser?.is_bot) {
    return { credited: false, reason: 'invalid_user' };
  }

  const cleanToken = String(token ?? '').trim();
  if (!REFERRAL_TOKEN_RE.test(cleanToken)) {
    return { credited: false, reason: 'invalid_token' };
  }

  const settings = await getReferralSettings(pool);
  if (!settings.enabled) {
    return { credited: false, reason: 'disabled' };
  }

  const codeRes = await pool.query(
    'SELECT user_telegram_id FROM referral_codes WHERE token = $1 LIMIT 1',
    [cleanToken],
  );
  const referrerId = Number(codeRes.rows[0]?.user_telegram_id);
  if (!Number.isSafeInteger(referrerId) || referrerId <= 0) {
    return { credited: false, reason: 'invalid_token' };
  }

  if (referrerId === referredId) {
    return { credited: false, reason: 'self_referral', referrerId };
  }

  if (isNewUser === false) {
    return { credited: false, reason: 'already_registered' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [74290311]);

    // Ensure referred user row exists (for direct calls where middleware did not insert yet)
    await client.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name, language_code, started_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (telegram_id) DO NOTHING`,
      [
        referredId,
        referredUser.username ?? null,
        referredUser.first_name ?? null,
        referredUser.last_name ?? null,
        referredUser.language_code ?? null,
      ],
    );

    const existingRef = await client.query(
      'SELECT id FROM referrals WHERE referred_telegram_id = $1 LIMIT 1',
      [referredId],
    );
    if (existingRef.rowCount) {
      await client.query('ROLLBACK');
      return { credited: false, reason: 'already_referred' };
    }

    if (isNewUser !== true) {
      const priorRes = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM users WHERE telegram_id = $1 AND started_at < NOW() - INTERVAL '30 seconds') AS old_user,
           EXISTS(SELECT 1 FROM referral_codes WHERE user_telegram_id = $1) AS has_code,
           EXISTS(SELECT 1 FROM referrals WHERE referrer_telegram_id = $1) AS has_referred,
           EXISTS(SELECT 1 FROM files WHERE uploaded_by = $1) AS has_files,
           EXISTS(SELECT 1 FROM share_links WHERE created_by = $1) AS has_links,
           EXISTS(SELECT 1 FROM delivery_bot_user_activity WHERE telegram_user_id = $1) AS has_bot_activity,
           EXISTS(SELECT 1 FROM payment_transactions WHERE user_telegram_id = $1) AS has_payments`,
        [referredId],
      );
      const p = priorRes.rows[0] ?? {};
      if (p.old_user || p.has_code || p.has_referred || p.has_files || p.has_links || p.has_bot_activity || p.has_payments) {
        await client.query('ROLLBACK');
        return { credited: false, reason: 'already_registered' };
      }
    }

    const rewardMinor = Number(settings.rewardMinor || 0);
    const currency = settings.currency || 'INR';

    const insRef = await client.query(
      `INSERT INTO referrals
         (referrer_telegram_id, referred_telegram_id, referral_token, reward_minor, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'credited')
       ON CONFLICT (referred_telegram_id) DO NOTHING
       RETURNING id, created_at`,
      [referrerId, referredId, cleanToken, rewardMinor, currency],
    );
    if (!insRef.rowCount) {
      await client.query('ROLLBACK');
      return { credited: false, reason: 'already_referred' };
    }

    const referralId = Number(insRef.rows[0].id);
    let balanceAfterMinor = null;

    if (rewardMinor > 0) {
      await client.query(
        'INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING',
        [referrerId],
      );
      const walletRes = await client.query(
        `INSERT INTO creator_wallets (user_telegram_id, currency, available_minor, total_earned_minor)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (user_telegram_id, currency) DO UPDATE SET
           available_minor = creator_wallets.available_minor + EXCLUDED.available_minor,
           total_earned_minor = creator_wallets.total_earned_minor + EXCLUDED.total_earned_minor,
           updated_at = NOW()
         RETURNING available_minor`,
        [referrerId, currency, rewardMinor],
      );
      balanceAfterMinor = Number(walletRes.rows[0]?.available_minor ?? rewardMinor);

      const invitedLabel = referredUser.username
        ? `@${referredUser.username}`
        : (referredUser.first_name || `User ${referredId}`);
      await client.query(
        `INSERT INTO wallet_ledger
           (user_telegram_id, currency, entry_type, amount_minor, balance_after_minor, reference_code, note)
         VALUES ($1, $2, 'referral_reward', $3, $4, $5, $6)`,
        [
          referrerId,
          currency,
          rewardMinor,
          balanceAfterMinor,
          `REF#${referralId}`,
          `Referral reward for inviting ${String(invitedLabel).slice(0, 120)}`,
        ],
      );
    }

    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('referral_completed', $1, $2, $3::jsonb)`,
      [
        referrerId,
        referredId,
        JSON.stringify({ referralId, token: cleanToken, rewardMinor, currency }),
      ],
    ).catch(() => {});

    await client.query('COMMIT');
    return {
      credited: true,
      referralId,
      referrerId,
      referredId,
      rewardMinor,
      currency,
      balanceAfterMinor,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
