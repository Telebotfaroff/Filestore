import { cached, cacheDeletePrefix } from '../utils/cache.js';

export const PLATFORM_FEE_SETTINGS_KEY = 'platform_fee_settings';
export const MAX_PLATFORM_FEE_BPS = 9000; // 90.00% maximum
export const MAX_PLATFORM_FEE_PERCENT = 90;

const SETTINGS_CACHE_KEY = 'platform-fee:settings';
const invalidatePlatformFeeCache = () => cacheDeletePrefix('platform-fee:');

function normalizeBps(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_PLATFORM_FEE_BPS) return 0;
  return n;
}

export function bpsToPercent(bps) {
  return Number((normalizeBps(bps) / 100).toFixed(2));
}

export function formatFeePercent(bps) {
  const pct = bpsToPercent(bps);
  return `${Number.isInteger(pct) ? pct : pct.toString()}%`;
}

export function parseFeePercentToBps(rawValue, label = 'Platform fee') {
  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
    throw new Error(`${label} percentage is required (0–${MAX_PLATFORM_FEE_PERCENT}%).`);
  }
  const cleaned = String(rawValue).trim().replace(/%$/, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`${label} must be a valid percentage between 0 and ${MAX_PLATFORM_FEE_PERCENT} (up to 2 decimals).`);
  }
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0 || num > MAX_PLATFORM_FEE_PERCENT) {
    throw new Error(`${label} must be between 0% and ${MAX_PLATFORM_FEE_PERCENT}%.`);
  }
  const bps = Math.round(num * 100);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > MAX_PLATFORM_FEE_BPS) {
    throw new Error(`${label} must be between 0% and ${MAX_PLATFORM_FEE_PERCENT}%.`);
  }
  return bps;
}

export function computePlatformFee(grossMinor, feeBps) {
  const gross = Number(grossMinor);
  if (!Number.isSafeInteger(gross) || gross <= 0) {
    return {
      grossAmountMinor: 0,
      feeBps: 0,
      feePercent: 0,
      feeAmountMinor: 0,
      netAmountMinor: 0,
    };
  }
  const safeBps = normalizeBps(feeBps);
  const rawFee = safeBps > 0 ? Math.floor((gross * safeBps + 5000) / 10000) : 0;
  const feeAmountMinor = Math.min(gross, Math.max(0, rawFee));
  const netAmountMinor = gross - feeAmountMinor;
  return {
    grossAmountMinor: gross,
    feeBps: safeBps,
    feePercent: bpsToPercent(safeBps),
    feeAmountMinor,
    netAmountMinor,
  };
}

function shapeSettings(raw) {
  const enabled = raw?.enabled === undefined ? true : Boolean(raw.enabled);
  const paidLinkFeeBps = normalizeBps(raw?.paidLinkFeeBps);
  const premiumFeeBps = normalizeBps(raw?.premiumFeeBps);
  return {
    enabled,
    paidLinkFeeBps,
    premiumFeeBps,
    paidLinkFeePercent: bpsToPercent(paidLinkFeeBps),
    premiumFeePercent: bpsToPercent(premiumFeeBps),
  };
}

async function fetchPlatformFeeSettingsDirect(db) {
  try {
    const { rows } = await db.query(
      'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
      [PLATFORM_FEE_SETTINGS_KEY],
    );
    if (!rows.length || !rows[0]?.value) {
      return shapeSettings(null);
    }
    return shapeSettings(rows[0].value);
  } catch {
    return shapeSettings(null);
  }
}

export async function getPlatformFeeSettings(db, { bypassCache = false } = {}) {
  if (bypassCache) {
    return fetchPlatformFeeSettingsDirect(db);
  }
  return cached(SETTINGS_CACHE_KEY, 15_000, () => fetchPlatformFeeSettingsDirect(db));
}

export async function setPlatformFeeSettings(
  pool,
  { enabled, paidLinkFeeBps, premiumFeeBps, paidLinkFeePercent, premiumFeePercent } = {},
  actorId = null,
) {
  const current = await getPlatformFeeSettings(pool, { bypassCache: true });

  let nextPaidLinkBps = current.paidLinkFeeBps;
  if (paidLinkFeeBps !== undefined && paidLinkFeeBps !== null && paidLinkFeeBps !== '') {
    const n = Number(paidLinkFeeBps);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_PLATFORM_FEE_BPS) {
      throw new Error(`Paid link fee must be between 0% and ${MAX_PLATFORM_FEE_PERCENT}%.`);
    }
    nextPaidLinkBps = n;
  } else if (paidLinkFeePercent !== undefined && paidLinkFeePercent !== null && String(paidLinkFeePercent).trim() !== '') {
    nextPaidLinkBps = parseFeePercentToBps(paidLinkFeePercent, 'Paid link fee');
  }

  let nextPremiumBps = current.premiumFeeBps;
  if (premiumFeeBps !== undefined && premiumFeeBps !== null && premiumFeeBps !== '') {
    const n = Number(premiumFeeBps);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_PLATFORM_FEE_BPS) {
      throw new Error(`Premium membership fee must be between 0% and ${MAX_PLATFORM_FEE_PERCENT}%.`);
    }
    nextPremiumBps = n;
  } else if (premiumFeePercent !== undefined && premiumFeePercent !== null && String(premiumFeePercent).trim() !== '') {
    nextPremiumBps = parseFeePercentToBps(premiumFeePercent, 'Premium membership fee');
  }

  const nextEnabled = enabled === undefined ? current.enabled : Boolean(enabled);
  const stored = {
    enabled: nextEnabled,
    paidLinkFeeBps: nextPaidLinkBps,
    premiumFeeBps: nextPremiumBps,
  };

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [PLATFORM_FEE_SETTINGS_KEY, JSON.stringify(stored), actorId ? Number(actorId) : null],
  );
  invalidatePlatformFeeCache();
  return shapeSettings(stored);
}

export async function recordPlatformFee(
  client,
  {
    paymentTransactionId,
    creatorId,
    saleType,
    referenceCode = null,
    currency = 'INR',
    grossAmountMinor,
    feeBps,
    feeAmountMinor,
    netAmountMinor,
  },
) {
  const txId = Number(paymentTransactionId);
  const uid = Number(creatorId);
  const gross = Number(grossAmountMinor);
  const fee = Number(feeAmountMinor);
  const net = Number(netAmountMinor);
  const bps = normalizeBps(feeBps);
  const curr = String(currency || 'INR').toUpperCase();
  if (!Number.isSafeInteger(txId) || txId <= 0 || !Number.isSafeInteger(uid) || uid <= 0) {
    return { recorded: false };
  }
  if (!['paid_file', 'paid_batch', 'premium'].includes(saleType)) {
    throw new Error('Invalid platform fee sale type.');
  }
  if (!Number.isSafeInteger(gross) || gross <= 0 || !Number.isSafeInteger(fee) || fee <= 0 || !Number.isSafeInteger(net) || net < 0) {
    return { recorded: false };
  }

  const { rows } = await client.query(
    `INSERT INTO platform_fee_ledger
       (payment_transaction_id, creator_telegram_id, sale_type, reference_code, currency, gross_amount_minor, fee_bps, fee_amount_minor, net_amount_minor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (payment_transaction_id) DO NOTHING
     RETURNING id`,
    [txId, uid, saleType, referenceCode ? String(referenceCode).slice(0, 120) : null, curr, gross, bps, fee, net],
  );
  return { recorded: Boolean(rows[0]?.id), id: rows[0]?.id ?? null };
}

export async function getOwnerPlatformFeeSummary(pool, limit = 30) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const [settings, totalsRes, recentRes] = await Promise.all([
    getPlatformFeeSettings(pool),
    pool.query(
      `SELECT currency,
              COUNT(*)::int AS total_count,
              COALESCE(SUM(fee_amount_minor), 0)::bigint AS total_fee_minor,
              COALESCE(SUM(gross_amount_minor), 0)::bigint AS total_gross_minor
       FROM platform_fee_ledger
       GROUP BY currency`,
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT f.id, f.payment_transaction_id, f.creator_telegram_id, f.sale_type, f.reference_code,
              f.currency, f.gross_amount_minor, f.fee_bps, f.fee_amount_minor, f.net_amount_minor, f.created_at,
              u.username AS creator_username, u.first_name AS creator_first_name
       FROM platform_fee_ledger f
       LEFT JOIN users u ON u.telegram_id = f.creator_telegram_id
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT $1`,
      [safeLimit],
    ).catch(() => ({ rows: [] })),
  ]);

  let totalCount = 0;
  const totalFeeByCurrency = {};
  const totalGrossByCurrency = {};
  for (const row of totalsRes.rows || []) {
    const curr = String(row.currency || 'INR').toUpperCase();
    totalCount += Number(row.total_count || 0);
    totalFeeByCurrency[curr] = Number(row.total_fee_minor || 0);
    totalGrossByCurrency[curr] = Number(row.total_gross_minor || 0);
  }

  return {
    settings,
    summary: {
      totalCount,
      totalFeeByCurrency,
      totalGrossByCurrency,
      totalInrFeeMinor: Number(totalFeeByCurrency.INR || 0),
      totalXtrFeeMinor: Number(totalFeeByCurrency.XTR || 0),
    },
    recent: (recentRes.rows || []).map((r) => ({
      id: Number(r.id),
      transactionId: Number(r.payment_transaction_id),
      creatorId: String(r.creator_telegram_id),
      creatorUsername: r.creator_username ?? null,
      creatorFirstName: r.creator_first_name ?? null,
      saleType: r.sale_type,
      referenceCode: r.reference_code ?? null,
      currency: r.currency,
      grossAmountMinor: Number(r.gross_amount_minor),
      feeBps: Number(r.fee_bps),
      feePercent: bpsToPercent(r.fee_bps),
      feeAmountMinor: Number(r.fee_amount_minor),
      netAmountMinor: Number(r.net_amount_minor),
      createdAt: r.created_at,
    })),
  };
}
