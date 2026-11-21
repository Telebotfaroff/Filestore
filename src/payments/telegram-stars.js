import { createHmac, timingSafeEqual } from 'node:crypto';
import { createPaymentSession, recordProviderEvent, markProviderEvent, recordVerifiedPayment } from './verification-repository.js';
import { applyVerifiedPayment } from './fulfillment-repository.js';
import { markPaymentMethodTest } from './repository.js';

const METHOD = 'telegram_stars';
const CURRENCY = 'XTR';
const EXPIRY_MS = 10 * 60 * 1000;
const ALLOWED_PURPOSES = new Set(['premium', 'paid_file', 'paid_batch']);

function pricesMap(config, purpose) {
  const map = config?.stars_prices?.[purpose];
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}
function keyFor(purpose, target) {
  if (purpose === 'premium') return String(target.planId);
  if (purpose === 'paid_file') return String(target.paidLinkId);
  if (purpose === 'paid_batch') return String(target.batchLinkId);
  return '';
}
export function getTelegramStarsPrice(config, purpose, target) {
  const amount = Number(pricesMap(config, purpose)[keyFor(purpose, target)]);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) return null;
  return amount;
}
export function hasConfiguredStarsPrices(config) {
  const prices = config?.stars_prices;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return false;
  return [...ALLOWED_PURPOSES].some((purpose) => {
    const bucket = prices[purpose];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return false;
    return Object.values(bucket).some((n) => Number.isSafeInteger(Number(n)) && Number(n) > 0 && Number(n) <= 100000000);
  });
}
export function countConfiguredStarsPrices(config) {
  const counts = { premium: 0, paid_file: 0, paid_batch: 0, total: 0 };
  const prices = config?.stars_prices;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return counts;
  for (const purpose of ALLOWED_PURPOSES) {
    const bucket = prices[purpose];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const val of Object.values(bucket)) {
      const n = Number(val);
      if (Number.isSafeInteger(n) && n > 0 && n <= 100000000) {
        counts[purpose] += 1;
        counts.total += 1;
      }
    }
  }
  return counts;
}
export async function loadStarsConfig(pool) {
  const { rows } = await pool.query(
    'SELECT is_enabled, public_config, setup_status, last_test_status, last_test_error FROM payment_methods WHERE method = $1 LIMIT 1',
    [METHOD],
  );
  const row = rows[0] ?? {};
  const publicConfig = row.public_config && typeof row.public_config === 'object' ? row.public_config : {};
  const starsPrices = {
    premium: { ...pricesMap(publicConfig, 'premium') },
    paid_file: { ...pricesMap(publicConfig, 'paid_file') },
    paid_batch: { ...pricesMap(publicConfig, 'paid_batch') },
  };
  const counts = countConfiguredStarsPrices({ stars_prices: starsPrices });
  return {
    isEnabled: Boolean(row.is_enabled),
    setupStatus: row.setup_status ?? 'not_configured',
    lastTestStatus: row.last_test_status ?? 'unknown',
    lastTestError: row.last_test_error ?? null,
    starsPrices,
    counts,
    isConfigured: counts.total > 0,
  };
}
export async function setTelegramStarsPrice(pool, purpose, targetId, starsAmount, adminId = null) {
  if (!ALLOWED_PURPOSES.has(purpose)) {
    throw new Error('Stars price purpose must be premium, paid_file, or paid_batch.');
  }
  const cleanId = Number(targetId);
  if (!Number.isSafeInteger(cleanId) || cleanId <= 0) {
    throw new Error('Target ID must be a positive integer.');
  }
  const stars = Number(starsAmount);
  if (!Number.isSafeInteger(stars) || stars < 0 || stars > 100000000) {
    throw new Error('Stars price must be an integer between 0 and 100000000 (0 removes the Stars price).');
  }

  const currentRes = await pool.query('SELECT is_enabled, public_config FROM payment_methods WHERE method = $1 LIMIT 1', [METHOD]);
  const existingConfig = currentRes.rows[0]?.public_config && typeof currentRes.rows[0].public_config === 'object'
    ? currentRes.rows[0].public_config
    : {};
  const existingPrices = existingConfig.stars_prices && typeof existingConfig.stars_prices === 'object' && !Array.isArray(existingConfig.stars_prices)
    ? existingConfig.stars_prices
    : {};
  const nextPurposeMap = {
    ...(existingPrices[purpose] && typeof existingPrices[purpose] === 'object' && !Array.isArray(existingPrices[purpose]) ? existingPrices[purpose] : {}),
  };

  if (stars === 0) {
    delete nextPurposeMap[String(cleanId)];
  } else {
    nextPurposeMap[String(cleanId)] = stars;
  }

  const nextPublicConfig = {
    ...existingConfig,
    stars_prices: {
      ...existingPrices,
      [purpose]: nextPurposeMap,
    },
  };
  const configured = hasConfiguredStarsPrices(nextPublicConfig);
  const setupStatus = configured ? 'configured' : 'not_configured';
  const nextEnabled = configured ? Boolean(currentRes.rows[0]?.is_enabled) : false;

  await pool.query(
    `UPDATE payment_methods
     SET public_config = $2::jsonb,
         setup_status = $3,
         is_enabled = $4,
         last_test_status = 'unknown',
         last_test_error = NULL,
         updated_by = $5,
         updated_at = NOW()
     WHERE method = $1`,
    [METHOD, JSON.stringify(nextPublicConfig), setupStatus, nextEnabled, adminId],
  );
  return loadStarsConfig(pool);
}
export async function enableTelegramStars(pool, adminId = null) {
  const cfg = await loadStarsConfig(pool);
  if (!cfg.isConfigured) {
    throw new Error('Set at least one Telegram Stars price (for a Premium plan, Paid Link, or Batch Link) first.');
  }
  await pool.query(
    `UPDATE payment_methods
     SET is_enabled = TRUE, setup_status = 'configured', updated_by = $2, updated_at = NOW()
     WHERE method = $1`,
    [METHOD, adminId],
  );
  return loadStarsConfig(pool);
}
export async function testTelegramStars(telegram, pool) {
  const cfg = await loadStarsConfig(pool);
  if (!cfg.isConfigured) {
    const err = 'No Telegram Stars prices configured yet.';
    await markPaymentMethodTest(pool, METHOD, 'failed', err).catch(() => {});
    throw new Error(err);
  }
  try {
    const me = telegram ? await telegram.getMe() : null;
    await markPaymentMethodTest(pool, METHOD, 'ok');
    return {
      ok: true,
      botUsername: me?.username ?? null,
      counts: cfg.counts,
      isEnabled: cfg.isEnabled,
    };
  } catch (error) {
    const msg = String(error?.message ?? 'Telegram API check failed');
    await markPaymentMethodTest(pool, METHOD, 'failed', msg).catch(() => {});
    throw new Error(`Telegram Stars check failed: ${msg}`);
  }
}

function signature(token, sessionId) {
  return createHmac('sha256', token).update('FileStoreStars:' + sessionId).digest('hex').slice(0, 32);
}
export function createStarsPayload(token, sessionId) {
  return 'fsstars:' + sessionId + ':' + signature(token, sessionId);
}
function parsePayload(token, payload) {
  const match = /^fsstars:(\d+):([a-f0-9]{32})$/.exec(String(payload ?? ''));
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const expected = Buffer.from(signature(token, id));
  const supplied = Buffer.from(match[2]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  return id;
}
async function readMethodConfig(pool) {
  const result = await pool.query('SELECT is_enabled, public_config FROM payment_methods WHERE method=$1', [METHOD]);
  if (!result.rowCount || !result.rows[0].is_enabled) throw new Error('Telegram Stars checkout is disabled.');
  return result.rows[0].public_config ?? {};
}
export async function sendStarsInvoice(bot, pool, ctx, purpose, target, label, description, token) {
  if (ctx.chat?.type !== 'private') throw new Error('Stars checkout is only available in private chats.');
  const publicConfig = await readMethodConfig(pool);
  const stars = getTelegramStarsPrice(publicConfig, purpose, target);
  if (!stars) throw new Error('No Telegram Stars price is configured for this purchase.');
  const session = await createPaymentSession(pool, {
    method: METHOD, purpose, userId: ctx.from.id, amountMinor: stars, currency: CURRENCY,
    expiresAt: new Date(Date.now() + EXPIRY_MS),
    planId: target.planId ?? null, fileId: target.fileId ?? null,
    paidLinkId: target.paidLinkId ?? null, batchLinkId: target.batchLinkId ?? null,
    metadata: { starsPrice: stars, label: String(label).slice(0, 120) },
  });
  const payload = createStarsPayload(token, session.id);
  const cleanTitle = String(label || 'FileStore Purchase').trim().slice(0, 32) || 'Purchase';
  const cleanDescription = String(description || cleanTitle).trim().slice(0, 255) || cleanTitle;
  try {
    await bot.telegram.sendInvoice(ctx.chat.id, {
      title: cleanTitle,
      description: cleanDescription,
      payload,
      provider_token: '',
      currency: CURRENCY,
      prices: [{ label: cleanTitle, amount: stars }],
    });
  } catch (error) {
    await pool.query("UPDATE payment_sessions SET status='failed',updated_at=NOW() WHERE id=$1 AND status='pending'", [session.id]).catch(() => {});
    throw error;
  }
  return { sessionId: session.id, stars };
}
async function loadPendingSession(pool, sessionId, userId) {
  const result = await pool.query(
    'SELECT id,user_telegram_id,method,purpose,plan_id,file_id,batch_link_id,paid_link_id,expected_amount_minor,currency,status,expires_at FROM payment_sessions WHERE id=$1',
    [sessionId],
  );
  const session = result.rows[0];
  if (!session || String(session.user_telegram_id) !== String(userId) || session.method !== METHOD || session.status !== 'pending' || new Date(session.expires_at) <= new Date()) return null;
  return session;
}
export async function handleStarsPreCheckout(bot, pool, ctx, token, logger) {
  const query = ctx.preCheckoutQuery;
  const sessionId = parsePayload(token, query.invoice_payload);
  if (!sessionId) return ctx.telegram.answerPreCheckoutQuery(query.id, false, 'Invalid checkout. Please restart the purchase.');
  try {
    const session = await loadPendingSession(pool, sessionId, query.from.id);
    if (!session || session.currency !== CURRENCY || Number(session.expected_amount_minor) !== Number(query.total_amount) || query.currency !== CURRENCY) {
      return ctx.telegram.answerPreCheckoutQuery(query.id, false, 'Checkout expired or amount mismatch. Please try again.');
    }
    await ctx.telegram.answerPreCheckoutQuery(query.id, true);
  } catch (error) {
    logger.warn({ error: error.message, sessionId }, 'Telegram Stars pre-checkout rejected');
    await ctx.telegram.answerPreCheckoutQuery(query.id, false, 'Payment check unavailable. Try again later.');
  }
}
export async function handleStarsSuccessfulPayment(pool, ctx, token, logger, adminIds = [], notifyTelegram = null) {
  const payment = ctx.message?.successful_payment;
  if (!payment || payment.currency !== CURRENCY) return false;
  const sessionId = parsePayload(token, payment.invoice_payload);
  if (!sessionId) {
    await ctx.reply('Payment received but checkout reference is invalid. Contact the administrator with your charge ID.');
    logger.error({ userId: ctx.from?.id, chargeId: payment.telegram_payment_charge_id }, 'Invalid Stars payment payload');
    return true;
  }
  let event;
  try {
    const sessionResult = await pool.query('SELECT id,user_telegram_id,method,purpose,plan_id,file_id,batch_link_id,paid_link_id,expected_amount_minor,currency,status,expires_at FROM payment_sessions WHERE id=$1', [sessionId]);
    const session = sessionResult.rows[0];
    if (!session || String(session.user_telegram_id) !== String(ctx.from.id) || session.method !== METHOD || !['pending','expired','verified','applied'].includes(session.status)) throw new Error('Payment session is invalid.');
    if (Number(session.expected_amount_minor) !== Number(payment.total_amount) || session.currency !== CURRENCY) throw new Error('Stars charge amount does not match the checkout.');
    const receipt = await recordProviderEvent(pool, { method: METHOD, eventId: payment.telegram_payment_charge_id, eventType: 'successful_payment', payload: { userId: ctx.from.id, amount: payment.total_amount, currency: payment.currency, payload: payment.invoice_payload, providerChargeId: payment.provider_payment_charge_id } });
    event = receipt.event;
    const result = await recordVerifiedPayment(pool, {
      method: METHOD, sessionId, externalTransactionId: payment.telegram_payment_charge_id,
      userId: ctx.from.id, purpose: session.purpose,
      planId: session.plan_id ?? null, fileId: session.file_id ?? null,
      paidLinkId: session.paid_link_id ?? null, batchLinkId: session.batch_link_id ?? null,
      amountMinor: payment.total_amount, currency: CURRENCY, allowExpiredSession: true,
    });
    const fulfilled = await applyVerifiedPayment(pool, result.transaction.id, { adminIds });
    await markProviderEvent(pool, event.id, 'processed', result.transaction.id);
    if (fulfilled.creatorCredit) {
      const { notifyCreatorSale } = await import('../wallet/notifications.js');
      await notifyCreatorSale(notifyTelegram ?? ctx.telegram, fulfilled.creatorCredit, logger).catch(() => {});
    }
    if (fulfilled.alreadyApplied) {
      await ctx.reply('✅ Your Telegram Stars payment was already processed. Your access is active.');
    } else if (fulfilled.type === 'premium') {
      await ctx.reply(`✅ Telegram Stars payment successful!\nPlan: ${fulfilled.plan ?? 'Premium'}\nYour Premium access is now active. Check /access_status anytime.`);
    } else if (fulfilled.type === 'paid_batch') {
      await ctx.reply(`✅ Telegram Stars payment successful!\nAll ${fulfilled.fileCount ?? ''} files in the batch are unlocked. Open the batch again or use /batch_get <code> to receive them.`.trim());
    } else {
      await ctx.reply('✅ Telegram Stars payment successful! Your file is now unlocked. Use /get <file_code> or open your share link again to receive it.');
    }
  } catch (error) {
    if (event?.id) await markProviderEvent(pool, event.id, 'failed', null, error.message).catch(() => {});
    logger.error({ error: error.message, userId: ctx.from?.id, sessionId }, 'Telegram Stars fulfillment failed');
    await ctx.reply('Payment was received, but activation is pending automatic recovery. Please keep your payment receipt; no second payment is needed.');
  }
  return true;
}
