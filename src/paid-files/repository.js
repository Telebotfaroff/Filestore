import { randomBytes, createHash } from 'node:crypto';

function normalizeCode(code) { return String(code ?? '').trim().toUpperCase(); }
function hashCode(code) { return createHash('sha256').update(normalizeCode(code)).digest('hex'); }

export async function createPaidFileLink(pool, fileCode, priceMinor, currency, expiresAt, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const file = await client.query("SELECT id, file_code, file_name FROM files WHERE file_code = $1 AND status = 'active' LIMIT 1 FOR SHARE", [String(fileCode).trim().toUpperCase()]);
    if (!file.rowCount) throw new Error('File code not found or inactive.');
    const publicCode = randomBytes(10).toString('hex').toUpperCase();
    const hash = hashCode(publicCode);
    const result = await client.query(
      `INSERT INTO paid_file_links (public_code, public_code_hash, file_id, price_minor, currency, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, public_code, file_id, price_minor, currency, expires_at, created_at`,
      [publicCode, hash, file.rows[0].id, priceMinor, currency, expiresAt ?? null, adminId],
    );
    await client.query('COMMIT');
    return { ...result.rows[0], file_code: file.rows[0].file_code, file_name: file.rows[0].file_name };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function listPaidFileLinks(pool, limit = 30) {
  const { rows } = await pool.query(
    `SELECT pfl.id, pfl.public_code, pfl.price_minor, pfl.currency, pfl.is_enabled, pfl.expires_at, pfl.created_at,
       f.file_code, f.file_name, COUNT(p.id)::int AS purchase_count
     FROM paid_file_links pfl JOIN files f ON f.id = pfl.file_id
     LEFT JOIN paid_file_purchases p ON p.paid_link_id = pfl.id
     GROUP BY pfl.id, f.file_code, f.file_name
     ORDER BY pfl.created_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 30, 1), 100)],
  );
  return rows;
}

export async function disablePaidFileLink(pool, publicCode, adminId) {
  const { rows } = await pool.query(
    'UPDATE paid_file_links SET is_enabled = FALSE, updated_at = NOW() WHERE public_code_hash = $1 RETURNING id, public_code',
    [hashCode(publicCode)],
  );
  return rows[0] ?? null;
}

export async function getPaidFileLink(pool, publicCode) {
  const { rows } = await pool.query(
    `SELECT pfl.id, pfl.public_code, pfl.file_id, pfl.price_minor, pfl.currency, pfl.expires_at, pfl.is_enabled,
       f.file_code, f.file_name, f.file_type, f.file_size
     FROM paid_file_links pfl JOIN files f ON f.id = pfl.file_id
     WHERE pfl.public_code_hash = $1 LIMIT 1`,
    [hashCode(publicCode)],
  );
  const link = rows[0] ?? null;
  if (link && (!link.is_enabled || (link.expires_at && new Date(link.expires_at) <= new Date()))) return { ...link, is_active: false };
  if (link) link.is_active = true;
  return link;
}

export async function requestPaidFilePurchase(pool, publicCode, user, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name)
       VALUES ($1, $2, $3, $4) ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name`,
      [user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null],
    );
    const linkResult = await client.query(
      `SELECT id, file_id, price_minor, currency FROM paid_file_links WHERE public_code_hash = $1 AND is_enabled = TRUE
       AND (expires_at IS NULL OR expires_at > $2) FOR UPDATE`,
      [hashCode(publicCode), now],
    );
    if (!linkResult.rowCount) throw new Error('Paid link not found, expired, or disabled.');
    const link = linkResult.rows[0];
    const existing = await client.query(
      `SELECT id, status FROM paid_file_purchases WHERE paid_link_id = $1 AND user_telegram_id = $2 FOR UPDATE`,
      [link.id, user.id],
    );
    if (existing.rowCount && ['paid', 'delivered'].includes(existing.rows[0].status)) {
      await client.query('COMMIT');
      return { alreadyPaid: true, purchaseId: existing.rows[0].id, status: existing.rows[0].status, priceMinor: link.price_minor, currency: link.currency };
    }
    if (existing.rowCount) {
      await client.query('UPDATE paid_file_purchases SET status = $2, updated_at = NOW() WHERE id = $1', [existing.rows[0].id, 'pending']);
    } else {
      await client.query(
        `INSERT INTO paid_file_purchases (paid_link_id, user_telegram_id, status, paid_amount_minor, currency)
         VALUES ($1, $2, 'pending', $3, $4)`,
        [link.id, user.id, link.price_minor, link.currency],
      );
    }
    await client.query('COMMIT');
    return { alreadyPaid: false, priceMinor: link.price_minor, currency: link.currency };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function confirmPaidFilePurchase(pool, publicCode, userId, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const link = await client.query(
      'SELECT id, file_id, price_minor, currency FROM paid_file_links WHERE public_code_hash = $1 FOR UPDATE',
      [hashCode(publicCode)],
    );
    if (!link.rowCount) throw new Error('Paid link not found.');
    const purchase = await client.query(
      `SELECT id, status FROM paid_file_purchases WHERE paid_link_id = $1 AND user_telegram_id = $2 FOR UPDATE`,
      [link.rows[0].id, userId],
    );
    if (!purchase.rowCount) throw new Error('No purchase request from this user. They must open the paid link first.');
    if (['paid', 'delivered'].includes(purchase.rows[0].status)) {
      await client.query('COMMIT');
      return { alreadyConfirmed: true };
    }
    await client.query(
      `UPDATE paid_file_purchases SET status = 'paid', verified_by = $3, verified_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [purchase.rows[0].id, adminId],
    );
    await client.query(
      `INSERT INTO access_grants (user_telegram_id, resource_type, resource_id, grant_reason, created_by)
       VALUES ($1, 'file', $2, $3, $4)
       ON CONFLICT (user_telegram_id, resource_type, resource_id) DO UPDATE SET grant_reason = EXCLUDED.grant_reason, created_by = EXCLUDED.created_by, expires_at = NULL`,
      [userId, link.rows[0].file_id, 'paid_file_purchase:' + purchase.rows[0].id, adminId],
    );
    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('paid_file_purchase_confirmed', $1, $2, $3::jsonb)`,
      [adminId, userId, JSON.stringify({ purchaseId: purchase.rows[0].id, paidLinkId: link.rows[0].id, fileId: link.rows[0].file_id })],
    );
    await client.query('COMMIT');
    return { confirmed: true, fileId: link.rows[0].file_id, purchaseId: purchase.rows[0].id };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function hasPaidFileEntitlement(pool, userId, fileId) {
  const result = await pool.query(
    `SELECT 1 FROM access_grants WHERE user_telegram_id = $1 AND resource_type = 'file' AND resource_id = $2
       AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
    [userId, fileId],
  );
  return result.rowCount > 0;
}

export async function listPendingPaidFilePurchases(pool, limit = 40) {
  const { rows } = await pool.query(
    `SELECT p.id AS purchase_id, p.user_telegram_id, p.status, p.created_at, p.paid_amount_minor, p.currency,
       l.public_code, f.file_code, f.file_name
     FROM paid_file_purchases p
     JOIN paid_file_links l ON l.id = p.paid_link_id
     JOIN files f ON f.id = l.file_id
     WHERE p.status = 'pending'
     ORDER BY p.created_at ASC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 40, 1), 100)],
  );
  return rows;
}
