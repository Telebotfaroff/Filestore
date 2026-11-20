import { encryptBotToken } from '../security/token-encryption.js';

export async function listShortenerProviders(pool) {
  const { rows } = await pool.query(
    'SELECT id, name, base_url, api_endpoint, api_key_param, target_url_param, response_url_path, response_format, checkpoint_minutes, priority, verification_mode, is_enabled, last_test_status, last_test_error FROM shortener_providers ORDER BY priority ASC, id ASC LIMIT 50',
  );
  return rows;
}

export async function addShortenerProvider(pool, config, input, adminId) {
  const encryptedKey = input.apiKey ? encryptBotToken(input.apiKey, config.tokenEncryptionKey) : null;
  const { rows } = await pool.query(
    `INSERT INTO shortener_providers (name, base_url, api_endpoint, api_key_ciphertext, api_key_param, target_url_param, response_url_path, response_format, checkpoint_minutes, priority, verification_mode, is_enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE, $12)
     ON CONFLICT (name) DO UPDATE SET base_url = EXCLUDED.base_url, api_endpoint = EXCLUDED.api_endpoint,
       api_key_ciphertext = EXCLUDED.api_key_ciphertext, api_key_param = EXCLUDED.api_key_param,
       target_url_param = EXCLUDED.target_url_param, response_url_path = EXCLUDED.response_url_path,
       response_format = EXCLUDED.response_format, checkpoint_minutes = EXCLUDED.checkpoint_minutes,
       priority = EXCLUDED.priority, verification_mode = EXCLUDED.verification_mode,
       is_enabled = FALSE, last_test_status = 'unknown', last_test_error = NULL, updated_at = NOW()
     RETURNING id, name, is_enabled`,
    [input.name, input.baseUrl, input.apiEndpoint, encryptedKey, input.apiKeyParam, input.targetUrlParam, input.responseUrlPath, input.responseFormat, input.checkpointMinutes, input.priority, input.verificationMode, adminId],
  );
  return rows[0];
}

export async function setShortenerEnabled(pool, id, enabled) {
  const { rows } = await pool.query(
    'UPDATE shortener_providers SET is_enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING id, name, verification_mode',
    [id, enabled],
  );
  return rows[0] ?? null;
}

export async function setShortenerDuration(pool, id, minutes) {
  const { rows } = await pool.query(
    'UPDATE shortener_providers SET checkpoint_minutes = $2, updated_at = NOW() WHERE id = $1 RETURNING id, name',
    [minutes, id],
  );
  return rows[0] ?? null;
}

export async function setShortenerPriority(pool, id, priority) {
  const { rows } = await pool.query(
    'UPDATE shortener_providers SET priority = $2, updated_at = NOW() WHERE id = $1 RETURNING id, name',
    [priority, id],
  );
  return rows[0] ?? null;
}

export async function removeShortenerProvider(pool, id) {
  const { rows } = await pool.query(
    'DELETE FROM shortener_providers WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM checkpoint_sessions s WHERE s.provider_id = shortener_providers.id AND s.status = \'pending\') RETURNING id, name',
    [id],
  );
  return rows[0] ?? null;
}

export async function markShortenerTest(pool, id, status, error = null) {
  await pool.query(
    'UPDATE shortener_providers SET last_test_status = $2, last_test_error = $3, updated_at = NOW() WHERE id = $1',
    [status, error?.slice(0, 500) ?? null, id],
  );
}
