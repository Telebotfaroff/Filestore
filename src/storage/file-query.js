export async function searchIndexedFiles(pool, searchTerm, limit = 8, ownerId = null) {
  const term = searchTerm.trim();
  if (!term) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  if (ownerId !== null && ownerId !== undefined) {
    const result = await pool.query(
      `SELECT file_code, file_name, file_type, file_size, created_at, uploaded_by
       FROM files WHERE status = 'active' AND uploaded_by = $3 AND (file_name ILIKE $1 OR file_code ILIKE $1)
       ORDER BY created_at DESC LIMIT $2`,
      [`%${term}%`, safeLimit, Number(ownerId)],
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT file_code, file_name, file_type, file_size, created_at, uploaded_by
     FROM files WHERE status = 'active' AND (file_name ILIKE $1 OR file_code ILIKE $1)
     ORDER BY created_at DESC LIMIT $2`,
    [`%${term}%`, safeLimit],
  );
  return result.rows;
}

export async function listRecentFiles(pool, limit = 8, ownerId = null) {
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  if (ownerId !== null && ownerId !== undefined) {
    const result = await pool.query(
      `SELECT file_code, file_name, file_type, file_size, created_at, uploaded_by
       FROM files WHERE status = 'active' AND uploaded_by = $2 ORDER BY created_at DESC LIMIT $1`,
      [safeLimit, Number(ownerId)],
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT file_code, file_name, file_type, file_size, created_at, uploaded_by
     FROM files WHERE status = 'active' ORDER BY created_at DESC LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}

export async function getIndexedFile(pool, code, ownerId = null) {
  const normalized = code.trim().toUpperCase();
  if (ownerId !== null && ownerId !== undefined) {
    const result = await pool.query(
      `SELECT f.*, sm.telegram_message_id, sc.telegram_chat_id AS storage_chat_id, sc.title AS storage_title, sc.is_enabled AS storage_channel_enabled
       FROM files f LEFT JOIN storage_messages sm ON sm.file_id = f.id AND sm.is_primary = TRUE
       LEFT JOIN storage_channels sc ON sc.id = sm.storage_channel_id
       WHERE f.file_code = $1 AND f.status = 'active' AND f.uploaded_by = $2 LIMIT 1`,
      [normalized, Number(ownerId)],
    );
    return result.rows[0] ?? null;
  }
  const result = await pool.query(
    `SELECT f.*, sm.telegram_message_id, sc.telegram_chat_id AS storage_chat_id, sc.title AS storage_title, sc.is_enabled AS storage_channel_enabled
     FROM files f LEFT JOIN storage_messages sm ON sm.file_id = f.id AND sm.is_primary = TRUE
     LEFT JOIN storage_channels sc ON sc.id = sm.storage_channel_id
     WHERE f.file_code = $1 AND f.status = 'active' LIMIT 1`,
    [normalized],
  );
  return result.rows[0] ?? null;
}

export function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined) return 'Unknown size';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'Unknown size';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
