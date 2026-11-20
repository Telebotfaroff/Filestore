import { encryptBotToken } from '../security/token-encryption.js';

export async function listPaymentTransactions(pool, status = null, limit = 15) {
  const allowed = new Set(['pending', 'verified', 'applied', 'rejected', 'expired']);
  if (status && !allowed.has(status)) throw new Error('Invalid payment transaction status.');
  const safeLimit = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 15));
  const { rows } = await pool.query(
    `SELECT id, user_telegram_id, method, external_transaction_id, purpose,
       plan_id, file_id, batch_link_id, paid_link_id, amount_minor, currency, status,
       session_id, verified_at, applied_at, created_at
     FROM payment_transactions
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [status, safeLimit],
  );
  return rows;
}

export async function listPaymentMethods(pool) {
  const { rows } = await pool.query(
    'SELECT method, is_enabled, public_config, setup_status, last_test_status, last_test_error, updated_at FROM payment_methods ORDER BY method',
  );
  return rows;
}

export async function configurePaymentMethod(pool, config, method, secret, publicConfig, adminId) {
  const ciphertext = secret ? encryptBotToken(secret, config.tokenEncryptionKey) : null;
  const { rows } = await pool.query(
    `UPDATE payment_methods SET public_config = $2::jsonb, secret_ciphertext = $3,
       setup_status = 'configured', last_test_status = 'unknown', last_test_error = NULL,
       updated_by = $4, updated_at = NOW() WHERE method = $1 RETURNING method, setup_status, is_enabled`,
    [method, JSON.stringify(publicConfig), ciphertext, adminId],
  );
  return rows[0] ?? null;
}

export async function disablePaymentMethod(pool, method, adminId) {
  const { rows } = await pool.query(
    `UPDATE payment_methods SET is_enabled = FALSE, updated_by = $2, updated_at = NOW() WHERE method = $1 RETURNING method`,
    [method, adminId],
  );
  return rows[0] ?? null;
}

export async function markPaymentMethodTest(pool, method, status, error = null) {
  await pool.query(
    'UPDATE payment_methods SET last_test_status = $2, last_test_error = $3, updated_at = NOW() WHERE method = $1',
    [status, error?.slice(0, 500) ?? null, method],
  );
}

export async function listExpiredPaymentSessions(pool, limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const { rows } = await pool.query(
    `SELECT id,user_telegram_id,method,purpose,expected_amount_minor,currency,expires_at,updated_at
     FROM payment_sessions WHERE status='expired'
     ORDER BY expires_at DESC,id DESC LIMIT $1`,
    [safeLimit],
  );
  return rows;
}

export async function listPaymentRecoveryFailures(pool, limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const { rows } = await pool.query(
    `SELECT id,user_telegram_id,method,purpose,amount_minor,currency,recovery_attempts,recovery_next_at,recovery_last_error,verified_at
     FROM payment_transactions WHERE status='verified' AND recovery_attempts > 0
     ORDER BY recovery_next_at ASC,verified_at ASC NULLS FIRST,id ASC LIMIT $1`,
    [safeLimit],
  );
  return rows;
}
