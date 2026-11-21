import { randomBytes } from 'node:crypto';
import { normalizeUpperCode, hashUpperCode } from '../utils/validation.js';
import { setTelegramStarsPrice } from '../payments/telegram-stars.js';

function parseBatchIdOrHash(idOrCode) {
  const raw = String(idOrCode ?? '').trim();
  if (!raw) throw new Error('Batch link ID or code is required.');
  if (/^\d+$/.test(raw)) {
    return { column: 'id', value: Number(raw) };
  }
  return { column: 'public_code_hash', value: hashUpperCode(raw) };
}

export async function createPaidBatch(pool, fileCodes, title, priceMinor, currency, expiresAt, adminId, ownerId = null) {
  if (!Array.isArray(fileCodes) || fileCodes.length < 2 || fileCodes.length > 100) throw new Error('Batch requires 2–100 files.');
  const codes = fileCodes.map(normalizeUpperCode);
  if (new Set(codes).size !== codes.length) throw new Error('Duplicate file codes in batch.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const files = await client.query(
      `SELECT id, file_code, file_name, status, uploaded_by FROM files WHERE file_code = ANY($1::text[]) ORDER BY array_position($1::text[], file_code) FOR SHARE`,
      [codes],
    );
    if (files.rowCount !== codes.length) throw new Error('One or more file codes are missing or inactive.');
    if (files.rows.some((f) => f.status !== 'active')) throw new Error('Batch contains an inactive file.');
    if (ownerId !== null && ownerId !== undefined && files.rows.some((f) => String(f.uploaded_by ?? '') !== String(ownerId))) {
      throw new Error('You can only include files you uploaded in your paid batch.');
    }
    const code = randomBytes(10).toString('hex').toUpperCase();
    const link = await client.query(
      `INSERT INTO paid_batch_links (public_code, public_code_hash, title, price_minor, currency, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, public_code, title, price_minor, currency, expires_at, created_by`,
      [code, hashUpperCode(code), title, priceMinor, currency, expiresAt ?? null, adminId],
    );
    const id = link.rows[0].id;
    for (let i = 0; i < files.rows.length; i++) {
      await client.query('INSERT INTO paid_batch_items (batch_link_id, file_id, position) VALUES ($1, $2, $3)', [id, files.rows[i].id, i + 1]);
    }
    await client.query('COMMIT');
    return { ...link.rows[0], itemCount: files.rowCount, files: files.rows };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function getPaidBatch(pool, code) {
  const result = await pool.query(
    `SELECT b.id, b.public_code, b.title, b.price_minor, b.currency, b.expires_at, b.is_enabled, b.created_by,
       COUNT(i.file_id)::int AS item_count
     FROM paid_batch_links b JOIN paid_batch_items i ON i.batch_link_id = b.id
     WHERE b.public_code_hash = $1 GROUP BY b.id LIMIT 1`,
    [hashUpperCode(code)],
  );
  const row = result.rows[0] ?? null;
  if (row) row.is_active = Boolean(row.is_enabled) && (!row.expires_at || new Date(row.expires_at) > new Date());
  return row;
}

export async function requestPaidBatchPurchase(pool, code, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name`,
      [user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null],
    );
    const batch = await client.query(
      `SELECT id, title, price_minor, currency FROM paid_batch_links WHERE public_code_hash = $1 AND is_enabled = TRUE
       AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE`,
      [hashUpperCode(code)],
    );
    if (!batch.rowCount) throw new Error('Batch link invalid, expired or disabled.');
    const b = batch.rows[0];
    const prior = await client.query('SELECT id, status FROM paid_batch_purchases WHERE batch_link_id = $1 AND user_telegram_id = $2 FOR UPDATE', [b.id, user.id]);
    if (prior.rowCount && ['paid', 'delivered'].includes(prior.rows[0].status)) {
      await client.query('COMMIT');
      return { alreadyPaid: true, status: prior.rows[0].status };
    }
    if (prior.rowCount) await client.query("UPDATE paid_batch_purchases SET status='pending', updated_at=NOW() WHERE id=$1", [prior.rows[0].id]);
    else await client.query("INSERT INTO paid_batch_purchases (batch_link_id, user_telegram_id, status, paid_amount_minor, currency) VALUES ($1, $2, 'pending', $3, $4)", [b.id, user.id, b.price_minor, b.currency]);
    await client.query('COMMIT');
    return { alreadyPaid: false, title: b.title, priceMinor: b.price_minor, currency: b.currency };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  finally { client.release(); }
}

export async function confirmPaidBatchPurchase(pool, code, userId, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
    const batch = await client.query('SELECT id, title FROM paid_batch_links WHERE public_code_hash=$1 FOR UPDATE', [hashUpperCode(code)]);
    if (!batch.rowCount) throw new Error('Batch link not found.');
    const purchase = await client.query('SELECT id,status FROM paid_batch_purchases WHERE batch_link_id=$1 AND user_telegram_id=$2 FOR UPDATE', [batch.rows[0].id, userId]);
    if (!purchase.rowCount) throw new Error('User has no purchase request for this batch.');
    if (['paid','delivered'].includes(purchase.rows[0].status)) { await client.query('COMMIT'); return { alreadyConfirmed: true }; }
    await client.query("UPDATE paid_batch_purchases SET status='paid', verified_by=$2, verified_at=NOW(), updated_at=NOW() WHERE id=$1", [purchase.rows[0].id, adminId]);
    const items = await client.query('SELECT file_id FROM paid_batch_items WHERE batch_link_id=$1 ORDER BY position', [batch.rows[0].id]);
    for (const item of items.rows) {
      await client.query(
        `INSERT INTO access_grants (user_telegram_id, resource_type, resource_id, grant_reason, created_by)
         VALUES ($1, 'file', $2, $3, $4) ON CONFLICT (user_telegram_id, resource_type, resource_id)
         DO UPDATE SET grant_reason=EXCLUDED.grant_reason, created_by=EXCLUDED.created_by, expires_at=NULL`,
        [userId, item.file_id, 'paid_batch_purchase:' + purchase.rows[0].id, adminId],
      );
    }
    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('paid_batch_purchase_confirmed', $1, $2, $3::jsonb)`,
      [adminId, userId, JSON.stringify({ purchaseId: purchase.rows[0].id, batchId: batch.rows[0].id, fileCount: items.rowCount })],
    );
    await client.query('COMMIT');
    return { confirmed: true, title: batch.rows[0].title, fileCount: items.rowCount };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  finally { client.release(); }
}

export async function getBatchItems(pool, code) {
  const { rows } = await pool.query(
    `SELECT f.id, f.file_code, f.file_name, f.file_size, sm.telegram_message_id, sc.telegram_chat_id AS storage_chat_id, sc.is_enabled AS storage_channel_enabled
     FROM paid_batch_links b JOIN paid_batch_items i ON i.batch_link_id = b.id JOIN files f ON f.id = i.file_id
     LEFT JOIN storage_messages sm ON sm.file_id = f.id AND sm.is_primary = TRUE
     LEFT JOIN storage_channels sc ON sc.id = sm.storage_channel_id
     WHERE b.public_code_hash = $1 ORDER BY i.position`,
    [hashUpperCode(code)],
  );
  return rows;
}

export async function listPaidBatchLinks(pool, limit = 30, ownerId = null) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      `SELECT b.id,b.public_code,b.title,b.price_minor,b.currency,b.is_enabled,b.expires_at,b.created_by,b.created_at,
         COUNT(DISTINCT i.file_id)::int AS item_count, COUNT(DISTINCT p.id)::int AS purchase_count,
         (SELECT COUNT(*)::int FROM link_open_events e WHERE e.link_kind='paid_batch' AND e.link_id=b.id) AS view_count
       FROM paid_batch_links b LEFT JOIN paid_batch_items i ON i.batch_link_id=b.id
       LEFT JOIN paid_batch_purchases p ON p.batch_link_id=b.id
       WHERE b.created_by = $2
       GROUP BY b.id ORDER BY b.created_at DESC LIMIT $1`,
      [safeLimit, Number(ownerId)],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT b.id,b.public_code,b.title,b.price_minor,b.currency,b.is_enabled,b.expires_at,b.created_by,b.created_at,
       COUNT(DISTINCT i.file_id)::int AS item_count, COUNT(DISTINCT p.id)::int AS purchase_count
     FROM paid_batch_links b LEFT JOIN paid_batch_items i ON i.batch_link_id=b.id
     LEFT JOIN paid_batch_purchases p ON p.batch_link_id=b.id
     GROUP BY b.id ORDER BY b.created_at DESC LIMIT $1`,
    [safeLimit],
  );
  return rows;
}

export async function disablePaidBatchLink(pool, code, ownerId = null) {
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query('UPDATE paid_batch_links SET is_enabled=FALSE, updated_at=NOW() WHERE public_code_hash=$1 AND created_by=$2 RETURNING public_code', [hashUpperCode(code), Number(ownerId)]);
    return rows[0] ?? null;
  }
  const { rows } = await pool.query('UPDATE paid_batch_links SET is_enabled=FALSE, updated_at=NOW() WHERE public_code_hash=$1 RETURNING public_code', [hashUpperCode(code)]);
  return rows[0] ?? null;
}

export async function updatePaidBatchLink(pool, idOrCode, title, priceMinor, currency = null, ownerId = null) {
  const { column, value } = parseBatchIdOrHash(idOrCode);
  const cleanTitle = String(title ?? '').trim().slice(0, 160);
  const price = Number(priceMinor);
  if (!cleanTitle) throw new Error('Batch title cannot be empty.');
  if (!Number.isSafeInteger(price) || price < 1) throw new Error('Price must be a positive integer in minor currency units.');
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(`UPDATE paid_batch_links SET title=$2, price_minor=$3, currency=COALESCE($4,currency), updated_at=NOW() WHERE ${column}=$1 AND created_by=$5 RETURNING id, public_code, title, price_minor, currency`, [value, cleanTitle, price, currency, Number(ownerId)]);
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(`UPDATE paid_batch_links SET title=$2, price_minor=$3, currency=COALESCE($4,currency), updated_at=NOW() WHERE ${column}=$1 RETURNING id, public_code, title, price_minor, currency`, [value, cleanTitle, price, currency]);
  return rows[0] ?? null;
}


export async function setPaidBatchLinkEnabled(pool, idOrCode, enabled, ownerId = null) {
  const { column, value } = parseBatchIdOrHash(idOrCode);
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      `UPDATE paid_batch_links SET is_enabled = $2, updated_at = NOW() WHERE ${column} = $1 AND created_by = $3 RETURNING id, public_code, is_enabled`,
      [value, Boolean(enabled), Number(ownerId)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(
    `UPDATE paid_batch_links SET is_enabled = $2, updated_at = NOW() WHERE ${column} = $1 RETURNING id, public_code, is_enabled`,
    [value, Boolean(enabled)],
  );
  return rows[0] ?? null;
}

export async function getPaidBatchByIdOrCode(pool, idOrCode, ownerId = null) {
  const { column, value } = parseBatchIdOrHash(idOrCode);
  const { rows } = await pool.query(
    `SELECT b.id, b.public_code, b.title, b.price_minor, b.currency, b.is_enabled, b.expires_at, b.created_by, b.created_at,
       COUNT(DISTINCT i.file_id)::int AS item_count,
       COUNT(DISTINCT p.id)::int AS purchase_count
     FROM paid_batch_links b
     LEFT JOIN paid_batch_items i ON i.batch_link_id = b.id
     LEFT JOIN paid_batch_purchases p ON p.batch_link_id = b.id
     WHERE b.${column} = $1
     GROUP BY b.id
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

export async function deletePaidBatchLink(pool, idOrCode, ownerId = null) {
  const { column, value } = parseBatchIdOrHash(idOrCode);
  const client = await pool.connect();
  let deleted = null;
  try {
    await client.query('BEGIN');
    const existing = ownerId !== null && ownerId !== undefined
      ? await client.query(
          `SELECT id, public_code, title FROM paid_batch_links WHERE ${column} = $1 AND created_by = $2 LIMIT 1 FOR UPDATE`,
          [value, Number(ownerId)],
        )
      : await client.query(
          `SELECT id, public_code, title FROM paid_batch_links WHERE ${column} = $1 LIMIT 1 FOR UPDATE`,
          [value],
        );
    if (!existing.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const targetId = existing.rows[0].id;
    await client.query('DELETE FROM paid_batch_purchases WHERE batch_link_id = $1', [targetId]);
    await client.query('DELETE FROM paid_batch_items WHERE batch_link_id = $1', [targetId]);
    const delRes = await client.query(
      'DELETE FROM paid_batch_links WHERE id = $1 RETURNING id, public_code, title',
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
    await setTelegramStarsPrice(pool, 'paid_batch', deleted.id, 0).catch(() => {});
  }
  return deleted;
}

export async function listPendingBatchPurchases(pool, limit=40) {
  const { rows } = await pool.query(
    `SELECT p.id purchase_id,p.user_telegram_id,p.created_at,p.paid_amount_minor,p.currency,b.public_code,b.title
     FROM paid_batch_purchases p JOIN paid_batch_links b ON b.id=p.batch_link_id
     WHERE p.status='pending' ORDER BY p.created_at ASC LIMIT $1`,
    [Math.min(Math.max(Number(limit)||40,1),100)],
  );
  return rows;
}
