import { randomBytes } from 'node:crypto';
import { normalizeUpperCode, hashUpperCode } from '../utils/validation.js';
import { setTelegramStarsPrice } from '../payments/telegram-stars.js';
import { cleanupUnreferencedFiles } from '../storage/file-cleanup.js';

function parsePaidIdOrHash(idOrCode) {
  const raw = String(idOrCode ?? '').trim();
  if (!raw) throw new Error('Paid link ID or code is required.');
  if (/^\d+$/.test(raw)) {
    return { column: 'id', value: Number(raw) };
  }
  return { column: 'public_code_hash', value: hashUpperCode(raw) };
}

export async function createPaidFileLink(pool, fileCode, priceMinor, currency, expiresAt, adminId, ownerId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const file = await client.query("SELECT id, file_code, file_name, uploaded_by FROM files WHERE file_code = $1 AND status = 'active' LIMIT 1 FOR SHARE", [normalizeUpperCode(fileCode)]);
    if (!file.rowCount) throw new Error('File code not found or inactive.');
    if (ownerId !== null && ownerId !== undefined && String(file.rows[0].uploaded_by ?? '') !== String(ownerId)) {
      throw new Error('You can only create paid links for your own uploaded files.');
    }
    const publicCode = randomBytes(10).toString('hex').toUpperCase();
    const hash = hashUpperCode(publicCode);
    const result = await client.query(
      `INSERT INTO paid_file_links (public_code, public_code_hash, file_id, price_minor, currency, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, public_code, file_id, price_minor, currency, expires_at, created_by, created_at`,
      [publicCode, hash, file.rows[0].id, priceMinor, currency, expiresAt ?? null, adminId],
    );
    await client.query('COMMIT');
    return { ...result.rows[0], file_code: file.rows[0].file_code, file_name: file.rows[0].file_name };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function listPaidFileLinks(pool, limit = 30, ownerId = null) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      `SELECT pfl.id, pfl.public_code, pfl.price_minor, pfl.currency, pfl.is_enabled, pfl.expires_at, pfl.created_by, pfl.created_at,
         f.file_code, f.file_name, COUNT(p.id)::int AS purchase_count,
         (SELECT COUNT(*)::int FROM link_open_events e WHERE e.link_kind='paid_file' AND e.link_id=pfl.id) AS view_count
       FROM paid_file_links pfl JOIN files f ON f.id = pfl.file_id
       LEFT JOIN paid_file_purchases p ON p.paid_link_id = pfl.id
       WHERE pfl.created_by = $2
       GROUP BY pfl.id, f.file_code, f.file_name
       ORDER BY pfl.created_at DESC LIMIT $1`,
      [safeLimit, Number(ownerId)],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT pfl.id, pfl.public_code, pfl.price_minor, pfl.currency, pfl.is_enabled, pfl.expires_at, pfl.created_by, pfl.created_at,
       f.file_code, f.file_name, COUNT(p.id)::int AS purchase_count,
       (SELECT COUNT(*)::int FROM link_open_events e WHERE e.link_kind='paid_file' AND e.link_id=pfl.id) AS view_count
     FROM paid_file_links pfl JOIN files f ON f.id = pfl.file_id
     LEFT JOIN paid_file_purchases p ON p.paid_link_id = pfl.id
     GROUP BY pfl.id, f.file_code, f.file_name
     ORDER BY pfl.created_at DESC LIMIT $1`,
    [safeLimit],
  );
  return rows;
}

export async function disablePaidFileLink(pool, publicCode, adminId, ownerId = null) {
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      'UPDATE paid_file_links SET is_enabled = FALSE, updated_at = NOW() WHERE public_code_hash = $1 AND created_by = $2 RETURNING id, public_code',
      [hashUpperCode(publicCode), Number(ownerId)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(
    'UPDATE paid_file_links SET is_enabled = FALSE, updated_at = NOW() WHERE public_code_hash = $1 RETURNING id, public_code',
    [hashUpperCode(publicCode)],
  );
  return rows[0] ?? null;
}

export async function updatePaidFileLinkPrice(pool, idOrCode, priceMinor, currency = null, ownerId = null) {
  const { column, value } = parsePaidIdOrHash(idOrCode);
  const price = Number(priceMinor);
  if (!Number.isSafeInteger(price) || price < 1) throw new Error('Price must be a positive integer in minor currency units.');
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(`UPDATE paid_file_links SET price_minor=$2, currency=COALESCE($3,currency), updated_at=NOW() WHERE ${column}=$1 AND created_by=$4 RETURNING id, public_code, price_minor, currency`, [value, price, currency, Number(ownerId)]);
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(`UPDATE paid_file_links SET price_minor=$2, currency=COALESCE($3,currency), updated_at=NOW() WHERE ${column}=$1 RETURNING id, public_code, price_minor, currency`, [value, price, currency]);
  return rows[0] ?? null;
}


export async function setPaidFileLinkEnabled(pool, idOrCode, enabled, ownerId = null) {
  const { column, value } = parsePaidIdOrHash(idOrCode);
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      `UPDATE paid_file_links SET is_enabled = $2, updated_at = NOW() WHERE ${column} = $1 AND created_by = $3 RETURNING id, public_code, is_enabled`,
      [value, Boolean(enabled), Number(ownerId)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(
    `UPDATE paid_file_links SET is_enabled = $2, updated_at = NOW() WHERE ${column} = $1 RETURNING id, public_code, is_enabled`,
    [value, Boolean(enabled)],
  );
  return rows[0] ?? null;
}

export async function getPaidFileLink(pool, publicCode) {
  const { rows } = await pool.query(
    `SELECT pfl.id, pfl.public_code, pfl.file_id, pfl.price_minor, pfl.currency, pfl.expires_at, pfl.is_enabled, pfl.created_by,
       f.file_code, f.file_name, f.file_type, f.file_size
     FROM paid_file_links pfl JOIN files f ON f.id = pfl.file_id
     WHERE pfl.public_code_hash = $1 LIMIT 1`,
    [hashUpperCode(publicCode)],
  );
  const link = rows[0] ?? null;
  if (link && (!link.is_enabled || (link.expires_at && new Date(link.expires_at) <= new Date()))) return { ...link, is_active: false };
  if (link) link.is_active = true;
  return link;
}

export async function getPaidFileLinkByIdOrCode(pool, idOrCode, ownerId = null) {
  const { column, value } = parsePaidIdOrHash(idOrCode);
  const { rows } = await pool.query(
    `SELECT pfl.id, pfl.public_code, pfl.file_id, pfl.price_minor, pfl.currency, pfl.expires_at, pfl.is_enabled, pfl.created_by, pfl.created_at,
       f.file_code, f.file_name, f.file_type, f.file_size, COUNT(p.id)::int AS purchase_count
     FROM paid_file_links pfl
     JOIN files f ON f.id = pfl.file_id
     LEFT JOIN paid_file_purchases p ON p.paid_link_id = pfl.id
     WHERE pfl.${column} = $1
     GROUP BY pfl.id, f.file_code, f.file_name, f.file_type, f.file_size
     LIMIT 1`,
    [value],
  );
  const row = rows[0] ?? null;
  if (!row) return null;
  if (ownerId !== null && ownerId !== undefined && String(row.created_by ?? '') !== String(ownerId)) {
    return null;
  }
  return row;
}

export async function deletePaidFileLink(pool, idOrCode, ownerId = null) {
  const { column, value } = parsePaidIdOrHash(idOrCode);
  const client = await pool.connect();
  let deleted = null;
  try {
    await client.query('BEGIN');
    const existing = ownerId !== null && ownerId !== undefined
      ? await client.query(
          `SELECT id, public_code, file_id FROM paid_file_links WHERE ${column} = $1 AND created_by = $2 LIMIT 1 FOR UPDATE`,
          [value, Number(ownerId)],
        )
      : await client.query(
          `SELECT id, public_code, file_id FROM paid_file_links WHERE ${column} = $1 LIMIT 1 FOR UPDATE`,
          [value],
        );
    if (!existing.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const targetId = existing.rows[0].id;
    await client.query('DELETE FROM paid_file_purchases WHERE paid_link_id = $1', [targetId]);
    const delRes = await client.query(
      'DELETE FROM paid_file_links WHERE id = $1 RETURNING id, public_code, file_id',
      [targetId],
    );
    await client.query('COMMIT');
    deleted = delRes.rows[0] ?? null;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
  if (deleted) {
    await setTelegramStarsPrice(pool, 'paid_file', deleted.id, 0).catch(() => {});
    if (deleted.file_id) {
      await cleanupUnreferencedFiles(pool, [deleted.file_id], ownerId).catch(() => {});
    }
  }
  return deleted;
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
      [hashUpperCode(publicCode), now],
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
      [hashUpperCode(publicCode)],
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
      `UPDATE paid_file_purchases SET status = 'paid', verified_by = $2, verified_at = NOW(), updated_at = NOW()
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
