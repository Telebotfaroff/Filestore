import { getCheckpointRequirement } from './checkpoint-engine.js';

async function isPremiumActive(pool, userId, now = new Date()) {
  const result = await pool.query(
    `SELECT 1 FROM premium_memberships
     WHERE user_telegram_id = $1 AND status = 'active'
       AND starts_at <= $2 AND (expires_at IS NULL OR expires_at > $2)
     ORDER BY expires_at DESC NULLS FIRST LIMIT 1`,
    [userId, now],
  );
  return result.rowCount > 0;
}

async function checkpointEnabled(pool) {
  const result = await pool.query("SELECT value FROM app_settings WHERE key = 'checkpoint_enabled' LIMIT 1");
  return result.rowCount ? result.rows[0].value === true : false;
}

export async function evaluateAccess(pool, request, forceSubResult, now = new Date()) {
  if (!forceSubResult?.passed) {
    return { allowed: false, reason: 'force_subscription_required', missingChannels: forceSubResult?.missing ?? [] };
  }
  if (!request?.userId || !Number.isSafeInteger(Number(request.userId)) || Number(request.userId) <= 0) {
    return { allowed: false, reason: 'invalid_user' };
  }

  const userId = Number(request.userId);
  if (request.type === 'paid_file') {
    if (!Number.isSafeInteger(Number(request.resourceId))) return { allowed: false, reason: 'invalid_resource' };
    const grants = await pool.query(
      `SELECT 1 FROM access_grants WHERE user_telegram_id = $1 AND resource_type = 'file' AND resource_id = $2
       AND (expires_at IS NULL OR expires_at > $3) LIMIT 1`,
      [userId, Number(request.resourceId), now],
    );
    return grants.rowCount ? { allowed: true, reason: 'paid_file_entitlement' } : { allowed: false, reason: 'purchase_required' };
  }

  if (!['free_file', 'batch'].includes(request.type)) return { allowed: false, reason: 'unsupported_access_type' };
  const premium = await isPremiumActive(pool, userId, now);
  if (premium) return { allowed: true, reason: 'premium' };

  if (!await checkpointEnabled(pool)) return { allowed: true, reason: 'checkpoint_disabled' };
  const checkpoint = await getCheckpointRequirement(pool, userId);
  if (checkpoint.reason === 'checkpoint_active') return { allowed: true, reason: 'checkpoint_active', expiresAt: checkpoint.expiresAt };
  if (checkpoint.reason === 'no_active_providers') return { allowed: false, reason: 'checkpoint_provider_unavailable' };
  if (checkpoint.blocked) return { allowed: false, reason: 'checkpoint_verification_unavailable', provider: checkpoint.provider };
  return { allowed: false, reason: 'checkpoint_required', provider: checkpoint.provider, step: checkpoint.step, total: checkpoint.total };
}

export async function grantAccess(pool, userId, resourceType, resourceId, reason, expiresAt, adminId) {
  if (!['file', 'batch'].includes(resourceType)) throw new Error('Unsupported access grant type.');
  const id = Number(resourceId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid resource ID.');
  const user = Number(userId);
  if (!Number.isSafeInteger(user) || user <= 0) throw new Error('Invalid Telegram user ID.');
  const { rows } = await pool.query(
    `INSERT INTO access_grants (user_telegram_id, resource_type, resource_id, grant_reason, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_telegram_id, resource_type, resource_id) DO UPDATE SET grant_reason = EXCLUDED.grant_reason,
       expires_at = EXCLUDED.expires_at, created_by = EXCLUDED.created_by
     RETURNING id`,
    [user, resourceType, id, String(reason).slice(0, 100), expiresAt ?? null, adminId],
  );
  return rows[0];
}
