import { createHash } from 'node:crypto';

const METHODS = new Set(['fampay', 'telegram_stars', 'stripe', 'crypto']);
const PURPOSES = new Set(['premium', 'paid_file', 'paid_batch']);

function safeHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function validatePaymentSessionInput(input) {
  if (!input || !METHODS.has(input.method)) throw new Error('Unsupported payment method.');
  if (!PURPOSES.has(input.purpose)) throw new Error('Unsupported payment purpose.');
  if (!Number.isSafeInteger(Number(input.amountMinor)) || Number(input.amountMinor) <= 0) throw new Error('Invalid payment amount.');
  const currency = String(input.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency.');
  if (!Number.isFinite(new Date(input.expiresAt).getTime()) || new Date(input.expiresAt).getTime() <= Date.now()) throw new Error('Session expiry must be in the future.');
  if (!Number.isSafeInteger(Number(input.userId)) || Number(input.userId) <= 0) throw new Error('Invalid Telegram user ID.');
  if (input.purpose === 'premium' && (!Number.isSafeInteger(Number(input.planId)) || Number(input.planId) <= 0)) throw new Error('Premium session requires planId.');
  if (input.purpose === 'paid_file' && (!Number.isSafeInteger(Number(input.fileId)) || Number(input.fileId) <= 0)) throw new Error('Paid-file session requires fileId.');
  if (input.purpose === 'paid_file' && (!Number.isSafeInteger(Number(input.paidLinkId)) || Number(input.paidLinkId) <= 0)) throw new Error('Paid-file session requires paidLinkId.');
  if (input.purpose === 'paid_batch' && (!Number.isSafeInteger(Number(input.batchLinkId)) || Number(input.batchLinkId) <= 0)) throw new Error('Paid-batch session requires batchLinkId.');
  return { ...input, amountMinor: Number(input.amountMinor), currency };
}

export async function createPaymentSession(pool, input) {
  const normalized = validatePaymentSessionInput(input);
  const { rows } = await pool.query(
    `INSERT INTO payment_sessions (user_telegram_id, method, purpose, plan_id, file_id, batch_link_id, paid_link_id, expected_amount_minor, currency, expires_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     RETURNING id, user_telegram_id, method, purpose, plan_id, file_id, expected_amount_minor, currency, status, expires_at, created_at`,
    [normalized.userId, normalized.method, normalized.purpose, normalized.planId ?? null, normalized.fileId ?? null, normalized.batchLinkId ?? null, normalized.paidLinkId ?? null, normalized.amountMinor, normalized.currency, normalized.expiresAt, JSON.stringify(normalized.metadata ?? {})],
  );
  return rows[0];
}

/**
 * Idempotently records provider webhook/event receipt. The event is only a receipt:
 * this function does NOT mark any transaction paid or grant access.
 */
export async function recordProviderEvent(pool, { method, eventId, eventType, payload }) {
  if (!METHODS.has(method)) throw new Error('Unsupported payment method.');
  const id = String(eventId ?? '').trim();
  if (!id || id.length > 255) throw new Error('Provider event ID is required (max 255 characters).');
  const type = String(eventType ?? '').trim();
  if (!type || type.length > 100) throw new Error('Provider event type is required (max 100 characters).');
  const hash = safeHash(payload ?? {});
  const { rows } = await pool.query(
    `INSERT INTO payment_provider_events (method, provider_event_id, event_type, payload_hash)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (method, provider_event_id) DO NOTHING
     RETURNING id, method, provider_event_id, event_type, payload_hash, processing_status, received_at`,
    [method, id, type, hash],
  );
  if (rows[0]) return { duplicate: false, event: rows[0] };
  const prior = await pool.query(
    'SELECT id, method, provider_event_id, event_type, payload_hash, processing_status, received_at FROM payment_provider_events WHERE method = $1 AND provider_event_id = $2 LIMIT 1',
    [method, id],
  );
  const event = prior.rows[0];
  if (event.payload_hash !== hash) throw new Error('Provider event ID reused with different payload.');
  return { duplicate: true, event };
}

export async function markProviderEvent(pool, eventId, status, transactionId = null, error = null) {
  if (!['processed', 'ignored', 'failed'].includes(status)) throw new Error('Invalid event status.');
  const { rows } = await pool.query(
    `UPDATE payment_provider_events SET processing_status = $2, payment_transaction_id = $3,
       processed_at = CASE WHEN $2 IN ('processed','ignored') THEN NOW() ELSE processed_at END,
       last_error = $4 WHERE id = $1 RETURNING id, processing_status, payment_transaction_id, processed_at`,
    [eventId, status, transactionId, error ? String(error).slice(0, 500) : null],
  );
  return rows[0] ?? null;
}

/**
 * Provider adapters must independently verify signatures and fetch/validate the
 * provider's authoritative payment state before calling this function.
 * Unique provider transaction IDs prevent the same payment being applied twice.
 */
export async function recordVerifiedPayment(pool, payment) {
  const method = payment.method;
  if (!METHODS.has(method)) throw new Error('Unsupported payment method.');
  const transactionId = String(payment.externalTransactionId ?? '').trim();
  if (!transactionId || transactionId.length > 255) throw new Error('Verified external transaction ID is required.');
  const sessionId = Number(payment.sessionId);
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new Error('Payment session ID is required.');
  const userId = Number(payment.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid Telegram user ID.');
  const amountMinor = Number(payment.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Invalid verified amount.');
  const currency = String(payment.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid verified currency.');
  const purpose = payment.purpose;
  if (!PURPOSES.has(purpose)) throw new Error('Invalid payment purpose.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query(
      'SELECT id, user_telegram_id, method, purpose, plan_id, file_id, batch_link_id, paid_link_id, expected_amount_minor, currency, status, expires_at FROM payment_sessions WHERE id = $1 FOR UPDATE',
      [sessionId],
    );
    if (!sessionResult.rowCount) throw new Error('Payment session not found.');
    const session = sessionResult.rows[0];
    const sessionMatches = String(session.user_telegram_id) === String(userId) && session.method === method &&
      session.purpose === purpose && Number(session.expected_amount_minor) === amountMinor && session.currency === currency &&
      (session.plan_id == null ? payment.planId == null : String(session.plan_id) === String(payment.planId)) &&
      (session.file_id == null ? payment.fileId == null : String(session.file_id) === String(payment.fileId)) &&
      (session.batch_link_id == null ? payment.batchLinkId == null : String(session.batch_link_id) === String(payment.batchLinkId)) &&
      (session.paid_link_id == null ? payment.paidLinkId == null : String(session.paid_link_id) === String(payment.paidLinkId));
    if (!sessionMatches) throw new Error('Verified payment does not match the checkout session.');
    if (new Date(session.expires_at) <= new Date() && session.status === 'pending' && !(payment.method === 'telegram_stars' && payment.allowExpiredSession === true)) throw new Error('Payment session expired.');
    const prior = await client.query(
      'SELECT id, user_telegram_id, method, external_transaction_id, purpose, plan_id, file_id, batch_link_id, paid_link_id, amount_minor, currency, status, session_id, verified_at FROM payment_transactions WHERE method = $1 AND external_transaction_id = $2 LIMIT 1 FOR UPDATE',
      [method, transactionId],
    );
    if (prior.rowCount) {
      const tx = prior.rows[0];
      const matches = String(tx.user_telegram_id) === String(userId) && tx.purpose === purpose &&
        Number(tx.amount_minor) === amountMinor && tx.currency === currency &&
        String(tx.session_id) === String(sessionId) &&
        (tx.plan_id == null ? payment.planId == null : String(tx.plan_id) === String(payment.planId)) &&
        (tx.file_id == null ? payment.fileId == null : String(tx.file_id) === String(payment.fileId)) &&
        (tx.batch_link_id == null ? payment.batchLinkId == null : String(tx.batch_link_id) === String(payment.batchLinkId)) &&
        (tx.paid_link_id == null ? payment.paidLinkId == null : String(tx.paid_link_id) === String(payment.paidLinkId));
      if (!matches) throw new Error('Transaction ID already exists but does not match this payment.');
      await client.query('COMMIT');
      return { duplicate: true, transaction: tx };
    }
    if (session.status !== 'pending') throw new Error('Payment session is no longer pending.');
    const inserted = await client.query(
      `INSERT INTO payment_transactions (user_telegram_id, method, external_transaction_id, purpose, plan_id, file_id, batch_link_id, paid_link_id, amount_minor, currency, status, session_id, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'verified',$11,NOW())
       RETURNING id, user_telegram_id, method, external_transaction_id, purpose, plan_id, file_id, batch_link_id, paid_link_id, amount_minor, currency, status, session_id, verified_at`,
      [userId, method, transactionId, purpose, payment.planId ?? null, payment.fileId ?? null, payment.batchLinkId ?? null, payment.paidLinkId ?? null, amountMinor, currency, sessionId],
    );
    await client.query(
      `UPDATE payment_sessions SET status = 'verified', updated_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    await client.query('COMMIT');
    return { duplicate: false, transaction: inserted.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
