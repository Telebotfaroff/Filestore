export async function listPremiumPlans(pool) {
  const { rows } = await pool.query('SELECT id, name, price_minor, currency, duration_days, is_enabled FROM premium_plans ORDER BY id ASC LIMIT 50');
  return rows;
}
export async function upsertPremiumPlan(pool, input, adminId) {
  const { rows } = await pool.query(
    `INSERT INTO premium_plans (name, price_minor, currency, duration_days, is_enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET price_minor = EXCLUDED.price_minor, currency = EXCLUDED.currency,
       duration_days = EXCLUDED.duration_days, is_enabled = EXCLUDED.is_enabled, updated_at = NOW()
     RETURNING id, name, price_minor, currency, duration_days, is_enabled`,
    [input.name, input.priceMinor, input.currency, input.durationDays, input.enabled, adminId],
  );
  return rows[0];
}
export async function editPremiumPlan(pool, id, input) {
  const { rows } = await pool.query(
    'UPDATE premium_plans SET name = $2, price_minor = $3, currency = $4, duration_days = $5, is_enabled = $6, updated_at = NOW() WHERE id = $1 RETURNING id, name',
    [id, input.name, input.priceMinor, input.currency, input.durationDays, input.enabled],
  );
  return rows[0] ?? null;
}
export async function removePremiumPlan(pool, id) {
  const { rows } = await pool.query('DELETE FROM premium_plans WHERE id = $1 RETURNING id, name', [id]);
  return rows[0] ?? null;
}
export async function grantPremiumMembership(pool, userId, planId, daysOverride, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING', [userId]);
    const planResult = await client.query('SELECT id, name, duration_days FROM premium_plans WHERE id = $1 AND is_enabled = TRUE FOR UPDATE', [planId]);
    if (!planResult.rowCount) throw new Error('Plan not found or disabled.');
    const days = daysOverride ?? planResult.rows[0].duration_days;
    const currentResult = await client.query(
      `SELECT id, starts_at, expires_at FROM premium_memberships WHERE user_telegram_id = $1 AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY expires_at DESC NULLS FIRST LIMIT 1 FOR UPDATE`,
      [userId],
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
        `UPDATE premium_memberships SET plan_id = $2, starts_at = COALESCE(starts_at, NOW()), expires_at = $3, status = 'active', source = 'admin', granted_by = $4, updated_at = NOW() WHERE id = $1`,
        [currentResult.rows[0].id, planId, expiresAt, adminId],
      );
    } else {
      await client.query(
        `INSERT INTO premium_memberships (user_telegram_id, plan_id, status, starts_at, expires_at, source, granted_by)
         VALUES ($1, $2, 'active', NOW(), $3, 'admin', $4)`,
        [userId, planId, expiresAt, adminId],
      );
    }
    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('premium_granted', $1, $2, $3::jsonb)`,
      [adminId, userId, JSON.stringify({ planId, days, expiresAt })],
    );
    await client.query('COMMIT');
    return { permanent: false, plan: planResult.rows[0].name, days, expiresAt };
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
    `SELECT m.status, m.starts_at, m.expires_at, p.name AS plan_name FROM premium_memberships m
     LEFT JOIN premium_plans p ON p.id = m.plan_id
     WHERE m.user_telegram_id = $1 ORDER BY m.created_at DESC LIMIT 5`,
    [userId],
  );
  return rows;
}
