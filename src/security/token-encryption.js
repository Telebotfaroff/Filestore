import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function getEncryptionKey(encodedKey) {
  const key = Buffer.from(String(encodedKey ?? '').trim(), 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

export function encryptBotToken(token, encodedKey) {
  const key = getEncryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptBotToken(envelope, encodedKey) {
  const key = getEncryptionKey(encodedKey);
  const parts = String(envelope).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported token encryption envelope');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed encrypted token envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

const RUNTIME_KEY_SETTING = 'runtime_token_encryption_key';

export async function resolveTokenEncryptionKey(pool, configuredKey = '') {
  const trimmed = String(configuredKey ?? '').trim();
  if (trimmed) {
    getEncryptionKey(trimmed);
    return trimmed;
  }
  if (!pool || pool.isMock) return '';

  const existing = await pool.query(
    'SELECT value->>\'key\' AS key FROM app_settings WHERE key = $1 LIMIT 1',
    [RUNTIME_KEY_SETTING],
  );
  const existingKey = String(existing.rows[0]?.key ?? '').trim();
  if (existingKey && Buffer.from(existingKey, 'base64').length === 32) {
    return existingKey;
  }

  const generated = randomBytes(32).toString('base64');
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ($1, jsonb_build_object('key', $2::text))
     ON CONFLICT (key) DO NOTHING`,
    [RUNTIME_KEY_SETTING, generated],
  );
  const saved = await pool.query(
    'SELECT value->>\'key\' AS key FROM app_settings WHERE key = $1 LIMIT 1',
    [RUNTIME_KEY_SETTING],
  );
  const resolved = String(saved.rows[0]?.key ?? '').trim();
  getEncryptionKey(resolved);
  return resolved;
}
