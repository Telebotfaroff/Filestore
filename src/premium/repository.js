import { cached, cacheDeletePrefix } from '../utils/cache.js';
const PLAN_TTL = 60_000;
const ownerKey = (ownerId) => ownerId == null ? 'main' : String(Number(ownerId));
const invalidatePlanCache = (ownerId) => { cacheDeletePrefix(`premium-plan:${ownerKey(ownerId)}:`); cacheDeletePrefix('premium-plan:any:'); };
function normalizeOwnerId(ownerId) {
  if (ownerId === null || ownerId === undefined) return null;
  const n = Number(ownerId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function ownerWhere(ownerId, paramIdx) {
  const normalized = normalizeOwnerId(ownerId);
  if (normalized === null) {
    return { clause: 'owner_telegram_id IS NULL', params: [] };
  }
  return { clause: `owner_telegram_id = $${paramIdx}`, params: [normalized] };
}

export async function listPremiumPlans(pool, ownerId = null) {
  return cached(`premium-plan:${ownerKey(ownerId)}:list`, PLAN_TTL, async () => {
  const scope = ownerWhere(ownerId, 1);
  const { rows } = await pool.query(
    `SELECT id, name, price_minor, currency, duration_days, is_enabled, owner_telegram_id
     FROM premium_plans
     WHERE ${scope.clause}
     ORDER BY id ASC LIMIT 50`,
    scope.params,
  );
  return rows;
  });
}

export async function getPremiumPlanById(pool, id, ownerId = undefined) {
  const planId = Number(id);
  if (!Number.isSafeInteger(planId) || planId <= 0) return null;
  const keyScope = ownerId === undefined ? 'any' : ownerKey(ownerId);
  return cached(`premium-plan:${keyScope}:id:${planId}`, PLAN_TTL, async () => {
  if (ownerId !== undefined) {
    const scope = ownerWhere(ownerId, 2);
    const { rows } = await pool.query(
      `SELECT id, name, price_minor, currency, duration_days, is_enabled, owner_telegram_id FROM premium_plans WHERE id = $1 AND ${scope.clause} LIMIT 1`,
      [planId, ...scope.params],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(
    'SELECT id, name, price_minor, currency, duration_days, is_enabled, owner_telegram_id FROM premium_plans WHERE id = $1 LIMIT 1',
    [planId],
  );
  return rows[0] ?? null;
  });
}

export async function upsertPremiumPlan(pool, input, actorId, ownerId = null) {
  const normalizedOwner = normalizeOwnerId(ownerId);
  const { rows } = await pool.query(
    `INSERT INTO premium_plans (name, price_minor, currency, duration_days, is_enabled, created_by, owner_telegram_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (COALESCE(owner_telegram_id, 0), name) DO UPDATE SET
       price_minor = EXCLUDED.price_minor,
       currency = EXCLUDED.currency,
       duration_days = EXCLUDED.duration_days,
       is_enabled = EXCLUDED.is_enabled,
       updated_at = NOW()
     RETURNING id, name, price_minor, currency, duration_days, is_enabled, owner_telegram_id`,
    [input.name, input.priceMinor, input.currency, input.durationDays, input.enabled, actorId, normalizedOwner],
  );
  invalidatePlanCache(ownerId);
  return rows[0];
}
export async function setPremiumPlanEnabled(pool, id, enabled, ownerId = undefined) {
  const planId = Number(id);
  if (!Number.isSafeInteger(planId) || planId <= 0) return null;
  if (ownerId !== undefined) {
    const scope = ownerWhere(ownerId, 3);
    const { rows } = await pool.query(
      `UPDATE premium_plans SET is_enabled = $2, updated_at = NOW()
       WHERE id = $1 AND ${scope.clause}
       RETURNING id, name, is_enabled, owner_telegram_id`,
      [planId, Boolean(enabled), ...scope.params],
    );
    const row = rows[0] ?? null;
    if (row) invalidatePlanCache(row.owner_telegram_id ?? null);
    return row;
  }
  const { rows } = await pool.query(
    `UPDATE premium_plans SET is_enabled = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, is_enabled, owner_telegram_id`,
    [planId, Boolean(enabled)],
  );
  const row = rows[0] ?? null;
  if (row) invalidatePlanCache(row.owner_telegram_id ?? null);
  return row;
}

export async function editPremiumPlan(pool, id, input, ownerId = undefined) {
  const planId = Number(id);
  if (!Number.isSafeInteger(planId) || planId <= 0) return null;
  if (ownerId !== undefined) {
    const scope = ownerWhere(ownerId, 7);
    const { rows } = await pool.query(
      `UPDATE premium_plans
       SET name = $2, price_minor = $3, currency = $4, duration_days = $5, is_enabled = $6, updated_at = NOW()
       WHERE id = $1 AND ${scope.clause}
       RETURNING id, name, owner_telegram_id`,
      [planId, input.name, input.priceMinor, input.currency, input.durationDays, input.enabled, ...scope.params],
    );
    const row = rows[0] ?? null;
    if (row) invalidatePlanCache(row.owner_telegram_id ?? null);
    return row;
  }
  const { rows } = await pool.query(
    'UPDATE premium_plans SET name = $2, price_minor = $3, currency = $4, duration_days = $5, is_enabled = $6, updated_at = NOW() WHERE id = $1 RETURNING id, name, owner_telegram_id',
    [planId, input.name, input.priceMinor, input.currency, input.durationDays, input.enabled],
  );
  const row = rows[0] ?? null;
  if (row) invalidatePlanCache(row.owner_telegram_id ?? null);
  return row;
}

export async function removePremiumPlan(pool, id, ownerId = undefined) {
  const planId = Number(id);
  if (!Number.isSafeInteger(planId) || planId <= 0) return null;
  if (ownerId !== undefined) {
    const scope = ownerWhere(ownerId, 2);
    const { rows } = await pool.query(
      `DELETE FROM premium_plans WHERE id = $1 AND ${scope.clause} RETURNING id, name, owner_telegram_id`,
      [planId, ...scope.params],
    );
    const row = rows[0] ?? null;
    if (row) invalidatePlanCache(row.owner_telegram_id ?? null);
    return row;
  }
  const { rows } = await pool.query('DELETE FROM premium_plans WHERE id = $1 RETURNING id, name, owner_telegram_id', [planId]);
  const row = rows[0] ?? null;
  if (row) invalidatePlanCache(row.owner_telegram_id ?? null);
  return row;
}

export async function grantPremiumMembership(pool, userId, planId, daysOverride, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING', [userId]);
    const planResult = await client.query(
      'SELECT id, name, duration_days, owner_telegram_id FROM premium_plans WHERE id = $1 AND is_enabled = TRUE FOR UPDATE',
      [planId],
    );
    if (!planResult.rowCount) throw new Error('Plan not found or disabled.');
    const planOwnerId = normalizeOwnerId(planResult.rows[0].owner_telegram_id);
    const days = daysOverride ?? planResult.rows[0].duration_days;
    const currentResult = await client.query(
      `SELECT id, starts_at, expires_at FROM premium_memberships
       WHERE user_telegram_id = $1 AND owner_telegram_id IS NOT DISTINCT FROM $2 AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY expires_at DESC NULLS FIRST LIMIT 1 FOR UPDATE`,
      [userId, planOwnerId],
    );
    if (currentResult.rowCount && currentResult.rows[0].expires_at === null) {
      await client.query('COMMIT');
      return { permanent: true, plan: planResult.rows[0].name };
    }
    const startAt = currentResult.rowCount ? currentResult.rows[0].expires_at : new Date();
    const expiresAt = new Date(startAt);
    expiresAt.setDate(expiresAt.getDate() + days);
    if (currentResult.rowCount) {
      await client.query(
        `UPDATE premium_memberships SET plan_id = $2, owner_telegram_id = $3, starts_at = COALESCE(starts_at, NOW()), expires_at = $4, status = 'active', source = 'admin', granted_by = $5, updated_at = NOW() WHERE id = $1`,
        [currentResult.rows[0].id, planId, planOwnerId, expiresAt, adminId],
      );
    } else {
      await client.query(
        `INSERT INTO premium_memberships (user_telegram_id, plan_id, owner_telegram_id, status, starts_at, expires_at, source, granted_by)
         VALUES ($1, $2, $3, 'active', NOW(), $4, 'admin', $5)`,
        [userId, planId, planOwnerId, expiresAt, adminId],
      );
    }
    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('premium_granted', $1, $2, $3::jsonb)`,
      [adminId, userId, JSON.stringify({ planId, days, expiresAt, ownerTelegramId: planOwnerId })],
    );
    await client.query('COMMIT');
    return { permanent: false, plan: planResult.rows[0].name, days, expiresAt, ownerTelegramId: planOwnerId };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function revokePremiumMembership(pool, userId, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE premium_memberships SET status = 'revoked', updated_at = NOW()
       WHERE user_telegram_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW()) RETURNING id`,
      [userId],
    );
    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('premium_revoked', $1, $2, $3::jsonb)`,
      [adminId, userId, JSON.stringify({ membershipsRevoked: result.rowCount })],
    );
    await client.query('COMMIT');
    return result.rowCount;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function getPremiumStatus(pool, userId) {
  const { rows } = await pool.query(
    `SELECT m.status, m.starts_at, m.expires_at, m.owner_telegram_id, p.name AS plan_name, u.username AS creator_username
     FROM premium_memberships m
     LEFT JOIN premium_plans p ON p.id = m.plan_id
     LEFT JOIN users u ON u.telegram_id = m.owner_telegram_id
     WHERE m.user_telegram_id = $1
     ORDER BY m.created_at DESC LIMIT 10`,
    [userId],
  );
  return rows;
}

