import { createHmac, timingSafeEqual } from 'node:crypto';
import { createPaymentSession, recordProviderEvent, markProviderEvent, recordVerifiedPayment } from './verification-repository.js';
import { applyVerifiedPayment } from './fulfillment-repository.js';

const METHOD = 'telegram_stars';
const CURRENCY = 'XTR';
const EXPIRY_MS = 10 * 60 * 1000;

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
  await bot.telegram.sendInvoice(ctx.chat.id, String(label).slice(0, 32), String(description).slice(0, 255), payload, '', CURRENCY, [{ label: String(label).slice(0, 32), amount: stars }]);
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
export async function handleStarsSuccessfulPayment(pool, ctx, token, logger) {
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
    const session = await loadPendingSession(pool, sessionId, ctx.from.id);
    if (!session && payment.invoice_payload) {
      const verifiedSession = await pool.query('SELECT id,user_telegram_id,method,purpose,plan_id,file_id,batch_link_id,paid_link_id,expected_amount_minor,currency,status,expires_at FROM payment_sessions WHERE id=$1', [sessionId]);
      const row = verifiedSession.rows[0];
      if (!row || String(row.user_telegram_id) !== String(ctx.from.id) || row.method !== METHOD || row.status !== 'verified') throw new Error('Payment session is invalid or already handled.');
      if (Number(row.expected_amount_minor) !== Number(payment.total_amount) || row.currency !== CURRENCY) throw new Error('Stars charge amount does not match the checkout.');
    }
    const receipt = await recordProviderEvent(pool, { method: METHOD, eventId: payment.telegram_payment_charge_id, eventType: 'successful_payment', payload: { userId: ctx.from.id, amount: payment.total_amount, currency: payment.currency, payload: payment.invoice_payload, providerChargeId: payment.provider_payment_charge_id } });
    event = receipt.event;
    const result = await recordVerifiedPayment(pool, {
      method: METHOD, sessionId, externalTransactionId: payment.telegram_payment_charge_id,
      userId: ctx.from.id, purpose: session?.purpose ?? (await pool.query('SELECT purpose FROM payment_sessions WHERE id=$1',[sessionId])).rows[0].purpose,
      planId: session?.plan_id ?? null, fileId: session?.file_id ?? null,
      paidLinkId: session?.paid_link_id ?? null, batchLinkId: session?.batch_link_id ?? null,
      amountMinor: payment.total_amount, currency: CURRENCY,
    });
    const fulfilled = await applyVerifiedPayment(pool, result.transaction.id);
    await markProviderEvent(pool, event.id, 'processed', result.transaction.id);
    await ctx.reply(fulfilled.alreadyApplied ? 'Your Stars payment was already processed. Your access is ready.' : 'Payment successful! Your access has been activated. Use /get or /batch_get to request your files.');
  } catch (error) {
    if (event?.id) await markProviderEvent(pool, event.id, 'failed', null, error.message).catch(() => {});
    logger.error({ error: error.message, userId: ctx.from?.id, sessionId }, 'Telegram Stars fulfillment failed');
    await ctx.reply('Payment was received, but activation is pending automatic recovery. Please keep your payment receipt; no second payment is needed.');
  }
  return true;
}
