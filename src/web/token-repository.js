import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAdmin } from '../bot/admin-guard.js';

export const WEB_TOKEN_PREFIX = 'fs_';

export function generateRawAccessToken() {
  return WEB_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashAccessToken(rawToken) {
  const normalized = String(rawToken ?? '').trim();
  if (!normalized) return '';
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function isPlausibleAccessToken(rawToken) {
  const value = String(rawToken ?? '').trim();
  return value.startsWith(WEB_TOKEN_PREFIX) && value.length >= 32 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function getAccessTokenMetadata(pool, telegramUserId) {
  const uid = Number(telegramUserId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;
  const { rows } = await pool.query(
    `SELECT telegram_user_id, token_prefix, created_at, rotated_at, last_used_at
     FROM web_access_tokens
     WHERE telegram_user_id = $1
     LIMIT 1`,
    [uid],
  );
  return rows[0] ?? null;
}

export async function issueOrRegenerateAccessToken(pool, telegramUserId, userMeta = {}) {
  const uid = Number(telegramUserId);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error('Invalid Telegram user ID.');
  }

  // Ensure the user row exists before creating the token foreign key
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [uid, userMeta.username ?? null, userMeta.first_name ?? null],
  );

  const rawToken = generateRawAccessToken();
  const tokenHash = hashAccessToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 10);

  const { rows } = await pool.query(
    `INSERT INTO web_access_tokens (telegram_user_id, token_hash, token_prefix, created_at, rotated_at, last_used_at)
     VALUES ($1, $2, $3, NOW(), NOW(), NULL)
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       token_prefix = EXCLUDED.token_prefix,
       rotated_at = NOW(),
       last_used_at = NULL
     RETURNING telegram_user_id, token_prefix, created_at, rotated_at, last_used_at, (xmax = 0) AS is_new`,
    [uid, tokenHash, tokenPrefix],
  );

  const row = rows[0];
  return {
    token: rawToken,
    prefix: row.token_prefix,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    isNew: Boolean(row.is_new),
  };
}

export async function revokeAccessToken(pool, telegramUserId) {
  const uid = Number(telegramUserId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return false;
  const { rowCount } = await pool.query(
    'DELETE FROM web_access_tokens WHERE telegram_user_id = $1',
    [uid],
  );
  return rowCount > 0;
}

export async function verifyAccessToken(pool, rawToken, adminIds = []) {
  if (!isPlausibleAccessToken(rawToken)) return null;
  const candidateHash = hashAccessToken(rawToken);
  if (!candidateHash) return null;

  const { rows } = await pool.query(
    `SELECT t.telegram_user_id, t.token_hash, t.token_prefix, t.created_at, t.rotated_at, t.last_used_at,
            u.username, u.first_name
     FROM web_access_tokens t
     JOIN users u ON u.telegram_id = t.telegram_user_id
     WHERE t.token_hash = $1
     LIMIT 1`,
    [candidateHash],
  );

  const row = rows[0];
  if (!row || typeof row.token_hash !== 'string') return null;

  const expectedBuf = Buffer.from(row.token_hash, 'utf8');
  const candidateBuf = Buffer.from(candidateHash, 'utf8');
  if (expectedBuf.length !== candidateBuf.length || !timingSafeEqual(expectedBuf, candidateBuf)) {
    return null;
  }

  const userId = Number(row.telegram_user_id);
  const isOwner = Array.isArray(adminIds) && adminIds.length > 0 && isAdmin(userId, adminIds);

  // Best-effort last_used_at update
  void pool.query(
    'UPDATE web_access_tokens SET last_used_at = NOW() WHERE telegram_user_id = $1',
    [userId],
  ).catch(() => {});

  return {
    userId,
    username: row.username ?? null,
    firstName: row.first_name ?? null,
    isOwner,
    role: isOwner ? 'owner' : 'creator',
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    lastUsedAt: row.last_used_at,
  };
}
