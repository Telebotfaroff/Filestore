import { randomBytes } from 'node:crypto';

export const MAX_SHARE_BATCH_ITEMS = 20;

export function createShareLinkCode(linkType = 'single') {
  const prefix = linkType === 'batch' ? 'b_' : 's_';
  return prefix + randomBytes(5).toString('hex');
}

export function buildShareableUrl(botUsername, linkCode) {
  const cleanUser = String(botUsername ?? '').replace(/^@/, '').trim();
  const cleanCode = String(linkCode ?? '').trim();
  if (!cleanUser || !cleanCode) return null;
  return `https://t.me/${cleanUser}?start=${cleanCode}`;
}

export async function getShareableBotUsername(pool, ownerId = null) {
  if (ownerId !== null && ownerId !== undefined) {
    const ownRes = await pool.query(
      `SELECT username FROM delivery_bots
       WHERE is_enabled = TRUE AND owner_telegram_id = $1 AND username IS NOT NULL AND username <> ''
       ORDER BY (role = 'primary') DESC, priority ASC, id ASC
       LIMIT 1`,
      [Number(ownerId)],
    );
    if (ownRes.rows[0]?.username) return ownRes.rows[0].username;
  }
  const result = await pool.query(
    `SELECT username FROM delivery_bots
     WHERE is_enabled = TRUE AND owner_telegram_id IS NULL AND username IS NOT NULL AND username <> ''
     ORDER BY (role = 'primary') DESC, priority ASC, id ASC
     LIMIT 1`,
  );
  return result.rows[0]?.username ?? null;
}

function parseLinkIdentifier(idOrCode) {
  const raw = String(idOrCode ?? '').trim();
  if (!raw) throw new Error('Share link ID or code is required.');
  if (/^\d+$/.test(raw)) {
    return { column: 'id', value: Number(raw) };
  }
  return { column: 'link_code', value: raw };
}

function assertFileOwner(file, ownerId) {
  if (ownerId === null || ownerId === undefined) return;
  if (String(file.uploaded_by ?? '') !== String(ownerId)) {
    throw new Error('You can only use files you uploaded.');
  }
}

function assertLinkOwner(link, ownerId) {
  if (ownerId === null || ownerId === undefined) return true;
  return String(link.created_by ?? '') === String(ownerId);
}

async function resolveActiveFile(client, fileCodeOrId, ownerId = null) {
  if (typeof fileCodeOrId === 'number' || /^\d+$/.test(String(fileCodeOrId ?? '').trim())) {
    const id = Number(fileCodeOrId);
    const res = await client.query(
      "SELECT id, file_code, file_name, file_type, file_size, uploaded_by FROM files WHERE id = $1 AND status = 'active' LIMIT 1 FOR SHARE",
      [id],
    );
    if (!res.rowCount) throw new Error(`Active file #${id} not found.`);
    assertFileOwner(res.rows[0], ownerId);
    return res.rows[0];
  }
  const code = String(fileCodeOrId ?? '').trim().toUpperCase();
  if (!code) throw new Error('File code is required.');
  const res = await client.query(
    "SELECT id, file_code, file_name, file_type, file_size, uploaded_by FROM files WHERE file_code = $1 AND status = 'active' LIMIT 1 FOR SHARE",
    [code],
  );
  if (!res.rowCount) throw new Error(`File code "${code}" not found or inactive.`);
  assertFileOwner(res.rows[0], ownerId);
  return res.rows[0];
}

async function resolveActiveFilesOrdered(client, fileCodesOrIds, ownerId = null) {
  if (!Array.isArray(fileCodesOrIds) || !fileCodesOrIds.length) {
    throw new Error('At least 1 media file is required.');
  }
  const resolved = [];
  const seenIds = new Set();
  for (const item of fileCodesOrIds) {
    const file = await resolveActiveFile(client, item, ownerId);
    if (!seenIds.has(file.id)) {
      seenIds.add(file.id);
      resolved.push(file);
    }
  }
  if (resolved.length > MAX_SHARE_BATCH_ITEMS) {
    throw new Error(`Batch links support at most ${MAX_SHARE_BATCH_ITEMS} media items (got ${resolved.length}).`);
  }
  return resolved;
}

export async function createSingleShareLink(pool, fileCodeOrId, title = null, createdBy = null, ownerId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const file = await resolveActiveFile(client, fileCodeOrId, ownerId);
    const cleanTitle = String(title ?? '').trim().slice(0, 160) || file.file_name || `File ${file.file_code}`;
    const linkCode = createShareLinkCode('single');
    const linkRes = await client.query(
      `INSERT INTO share_links (link_code, link_type, title, created_by)
       VALUES ($1, 'single', $2, $3)
       RETURNING id, link_code, link_type, title, is_enabled, created_by, created_at, updated_at`,
      [linkCode, cleanTitle, createdBy ?? null],
    );
    const link = linkRes.rows[0];
    await client.query(
      'INSERT INTO share_link_items (link_id, file_id, position) VALUES ($1, $2, 1)',
      [link.id, file.id],
    );
    await client.query('COMMIT');
    return { ...link, itemCount: 1, items: [file] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function insertShareLinkItems(client, linkId, fileIds) {
  for (let i = 0; i < fileIds.length; i++) {
    await client.query(
      'INSERT INTO share_link_items (link_id, file_id, position) VALUES ($1, $2, $3)',
      [linkId, fileIds[i], i + 1],
    );
  }
}

export async function createBatchShareLink(pool, fileCodesOrIds, title = null, createdBy = null, ownerId = null) {
  if (!Array.isArray(fileCodesOrIds) || !fileCodesOrIds.length) {
    throw new Error('Provide at least 1 media file (up to 20) for a batch link.');
  }
  if (fileCodesOrIds.length > MAX_SHARE_BATCH_ITEMS) {
    throw new Error(`Batch links support up to ${MAX_SHARE_BATCH_ITEMS} media items.`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const files = await resolveActiveFilesOrdered(client, fileCodesOrIds, ownerId);
    const cleanTitle = String(title ?? '').trim().slice(0, 160) || `Batch (${files.length} ${files.length === 1 ? 'file' : 'files'})`;
    const linkCode = createShareLinkCode('batch');
    const linkRes = await client.query(
      `INSERT INTO share_links (link_code, link_type, title, created_by)
       VALUES ($1, 'batch', $2, $3)
       RETURNING id, link_code, link_type, title, is_enabled, created_by, created_at, updated_at`,
      [linkCode, cleanTitle, createdBy ?? null],
    );
    const link = linkRes.rows[0];
    await insertShareLinkItems(client, link.id, files.map((f) => f.id));
    await client.query('COMMIT');
    return { ...link, itemCount: files.length, items: files };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function fetchShareLinkDetails(pool, column, value, ownerId = null) {
  const linkRes = await pool.query(
    `SELECT id, link_code, link_type, title, is_enabled, created_by, created_at, updated_at
     FROM share_links WHERE ${column} = $1 LIMIT 1`,
    [value],
  );
  if (!linkRes.rowCount) return null;
  const link = linkRes.rows[0];
  if (!assertLinkOwner(link, ownerId)) return null;
  const itemsRes = await pool.query(
    `SELECT i.position, f.id AS file_id, f.file_code, f.file_name, f.file_type, f.file_size, f.status AS file_status,
       sm.telegram_message_id, sc.telegram_chat_id AS storage_chat_id, sc.is_enabled AS storage_channel_enabled
     FROM share_link_items i
     JOIN files f ON f.id = i.file_id
     LEFT JOIN storage_messages sm ON sm.file_id = f.id AND sm.is_primary = TRUE
     LEFT JOIN storage_channels sc ON sc.id = sm.storage_channel_id
     WHERE i.link_id = $1
     ORDER BY i.position ASC`,
    [link.id],
  );
  return { ...link, itemCount: itemsRes.rowCount, items: itemsRes.rows };
}

export async function getShareLinkByCode(pool, linkCode) {
  const clean = String(linkCode ?? '').trim();
  if (!clean) return null;
  return fetchShareLinkDetails(pool, 'link_code', clean, null);
}

export async function getShareLinkById(pool, id, ownerId = null) {
  const numId = Number(id);
  if (!Number.isSafeInteger(numId) || numId <= 0) return null;
  return fetchShareLinkDetails(pool, 'id', numId, ownerId);
}

export async function listShareLinks(pool, { limit = 6, offset = 0, ownerId = null } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 25);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  if (ownerId !== null && ownerId !== undefined) {
    const uid = Number(ownerId);
    const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM share_links WHERE created_by = $1', [uid]);
    const total = Number(countRes.rows[0]?.total ?? 0);
    const { rows } = await pool.query(
      `SELECT sl.id, sl.link_code, sl.link_type, sl.title, sl.is_enabled, sl.created_by, sl.created_at, sl.updated_at,
         COUNT(sli.file_id)::int AS item_count,
         MIN(f.file_code) FILTER (WHERE sli.position = 1) AS first_file_code
       FROM share_links sl
       LEFT JOIN share_link_items sli ON sli.link_id = sl.id
       LEFT JOIN files f ON f.id = sli.file_id
       WHERE sl.created_by = $3
       GROUP BY sl.id
       ORDER BY sl.created_at DESC, sl.id DESC
       LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset, uid],
    );
    return { total, rows };
  }
  const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM share_links');
  const total = Number(countRes.rows[0]?.total ?? 0);
  const { rows } = await pool.query(
    `SELECT sl.id, sl.link_code, sl.link_type, sl.title, sl.is_enabled, sl.created_by, sl.created_at, sl.updated_at,
       COUNT(sli.file_id)::int AS item_count,
       MIN(f.file_code) FILTER (WHERE sli.position = 1) AS first_file_code
     FROM share_links sl
     LEFT JOIN share_link_items sli ON sli.link_id = sl.id
     LEFT JOIN files f ON f.id = sli.file_id
     GROUP BY sl.id
     ORDER BY sl.created_at DESC, sl.id DESC
     LIMIT $1 OFFSET $2`,
    [safeLimit, safeOffset],
  );
  return { total, rows };
}

export async function renameShareLink(pool, idOrCode, newTitle, ownerId = null) {
  const cleanTitle = String(newTitle ?? '').trim().slice(0, 160);
  if (!cleanTitle) throw new Error('New link title cannot be empty.');
  const { column, value } = parseLinkIdentifier(idOrCode);
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      `UPDATE share_links SET title = $2, updated_at = NOW()
       WHERE ${column} = $1 AND created_by = $3
       RETURNING id, link_code, link_type, title, is_enabled, updated_at`,
      [value, cleanTitle, Number(ownerId)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(
    `UPDATE share_links SET title = $2, updated_at = NOW()
     WHERE ${column} = $1
     RETURNING id, link_code, link_type, title, is_enabled, updated_at`,
    [value, cleanTitle],
  );
  return rows[0] ?? null;
}

export async function renameIndexedFile(pool, fileCodeOrId, newName, ownerId = null) {
  const cleanName = String(newName ?? '').trim().slice(0, 200);
  if (!cleanName) throw new Error('New file name cannot be empty.');
  const raw = String(fileCodeOrId ?? '').trim();
  const isNumericId = typeof fileCodeOrId === 'number' || /^\d+$/.test(raw);
  const idVal = isNumericId ? Number(raw) : raw.toUpperCase();
  const keyCol = isNumericId ? 'id' : 'file_code';
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      `UPDATE files SET file_name = $2, updated_at = NOW() WHERE ${keyCol} = $1 AND status = 'active' AND uploaded_by = $3 RETURNING id, file_code, file_name, updated_at`,
      [idVal, cleanName, Number(ownerId)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(
    `UPDATE files SET file_name = $2, updated_at = NOW() WHERE ${keyCol} = $1 AND status = 'active' RETURNING id, file_code, file_name, updated_at`,
    [idVal, cleanName],
  );
  return rows[0] ?? null;
}

export async function addItemToShareLink(pool, idOrCode, fileCodeOrId, ownerId = null) {
  const { column, value } = parseLinkIdentifier(idOrCode);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const linkRes = await client.query(
      `SELECT id, link_code, link_type, title, created_by FROM share_links WHERE ${column} = $1 LIMIT 1 FOR UPDATE`,
      [value],
    );
    if (!linkRes.rowCount || !assertLinkOwner(linkRes.rows[0], ownerId)) throw new Error('Share link not found.');
    const link = linkRes.rows[0];
    const file = await resolveActiveFile(client, fileCodeOrId, ownerId);

    const existingItems = await client.query(
      'SELECT file_id, position FROM share_link_items WHERE link_id = $1 ORDER BY position ASC FOR UPDATE',
      [link.id],
    );
    if (existingItems.rows.some((r) => Number(r.file_id) === Number(file.id))) {
      throw new Error(`File ${file.file_code} is already in this link.`);
    }
    if (existingItems.rowCount >= MAX_SHARE_BATCH_ITEMS) {
      throw new Error(`Batch limit reached (${MAX_SHARE_BATCH_ITEMS}/${MAX_SHARE_BATCH_ITEMS} items).`);
    }
    const nextPos = existingItems.rowCount + 1;
    await client.query(
      'INSERT INTO share_link_items (link_id, file_id, position) VALUES ($1, $2, $3)',
      [link.id, file.id, nextPos],
    );
    await client.query(
      `UPDATE share_links SET link_type = CASE WHEN $2 > 1 THEN 'batch' ELSE link_type END, updated_at = NOW() WHERE id = $1`,
      [link.id, nextPos],
    );
    await client.query('COMMIT');
    return { linkId: link.id, file, itemCount: nextPos };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function removeItemFromShareLink(pool, idOrCode, fileId, ownerId = null) {
  const { column, value } = parseLinkIdentifier(idOrCode);
  const targetFileId = Number(fileId);
  if (!Number.isSafeInteger(targetFileId) || targetFileId <= 0) throw new Error('Invalid file ID.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const linkRes = await client.query(
      `SELECT id, created_by FROM share_links WHERE ${column} = $1 LIMIT 1 FOR UPDATE`,
      [value],
    );
    if (!linkRes.rowCount || !assertLinkOwner(linkRes.rows[0], ownerId)) throw new Error('Share link not found.');
    const linkId = linkRes.rows[0].id;
    const currentRes = await client.query(
      'SELECT file_id, position FROM share_link_items WHERE link_id = $1 ORDER BY position ASC FOR UPDATE',
      [linkId],
    );
    if (currentRes.rowCount <= 1) {
      throw new Error('A share link must keep at least 1 item. Delete the link instead.');
    }
    const remaining = currentRes.rows.filter((r) => Number(r.file_id) !== targetFileId);
    if (remaining.length === currentRes.rowCount) {
      throw new Error('File is not part of this share link.');
    }
    await client.query('DELETE FROM share_link_items WHERE link_id = $1', [linkId]);
    await insertShareLinkItems(client, linkId, remaining.map((r) => r.file_id));
    await client.query('UPDATE share_links SET updated_at = NOW() WHERE id = $1', [linkId]);
    await client.query('COMMIT');
    return { linkId, itemCount: remaining.length };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function updateShareLinkItems(pool, idOrCode, fileCodesOrIds, ownerId = null) {
  const { column, value } = parseLinkIdentifier(idOrCode);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const linkRes = await client.query(
      `SELECT id, link_type, created_by FROM share_links WHERE ${column} = $1 LIMIT 1 FOR UPDATE`,
      [value],
    );
    if (!linkRes.rowCount || !assertLinkOwner(linkRes.rows[0], ownerId)) throw new Error('Share link not found.');
    const link = linkRes.rows[0];
    const files = await resolveActiveFilesOrdered(client, fileCodesOrIds, ownerId);
    await client.query('DELETE FROM share_link_items WHERE link_id = $1', [link.id]);
    await insertShareLinkItems(client, link.id, files.map((f) => f.id));
    const nextType = files.length > 1 ? 'batch' : link.link_type;
    await client.query(
      'UPDATE share_links SET link_type = $2, updated_at = NOW() WHERE id = $1',
      [link.id, nextType],
    );
    await client.query('COMMIT');
    return { linkId: link.id, itemCount: files.length, items: files };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function setShareLinkEnabled(pool, idOrCode, enabled, ownerId = null) {
  const { column, value } = parseLinkIdentifier(idOrCode);
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      `UPDATE share_links SET is_enabled = $2, updated_at = NOW()
       WHERE ${column} = $1 AND created_by = $3
       RETURNING id, link_code, is_enabled`,
      [value, Boolean(enabled), Number(ownerId)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(
    `UPDATE share_links SET is_enabled = $2, updated_at = NOW()
     WHERE ${column} = $1
     RETURNING id, link_code, is_enabled`,
    [value, Boolean(enabled)],
  );
  return rows[0] ?? null;
}

export async function deleteShareLink(pool, idOrCode, ownerId = null) {
  const { column, value } = parseLinkIdentifier(idOrCode);
  if (ownerId !== null && ownerId !== undefined) {
    const { rows } = await pool.query(
      `DELETE FROM share_links WHERE ${column} = $1 AND created_by = $2 RETURNING id, link_code, title`,
      [value, Number(ownerId)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query(
    `DELETE FROM share_links WHERE ${column} = $1 RETURNING id, link_code, title`,
    [value],
  );
  return rows[0] ?? null;
}
