import { encryptBotToken } from '../security/token-encryption.js';

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
