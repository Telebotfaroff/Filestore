export async function claimIngestRequest(pool, sourceChatId, sourceMessageId) {
  const result = await pool.query(
    `INSERT INTO file_ingest_requests (source_chat_id, source_message_id, status, processing_until)
     VALUES ($1, $2, 'processing', NOW() + INTERVAL '5 minutes')
     ON CONFLICT (source_chat_id, source_message_id) DO UPDATE SET
       status = 'processing', processing_until = NOW() + INTERVAL '5 minutes',
       last_error = NULL, updated_at = NOW()
     WHERE file_ingest_requests.status NOT IN ('completed', 'duplicate')
       AND (file_ingest_requests.status <> 'processing' OR file_ingest_requests.processing_until < NOW())
     RETURNING id`,
    [sourceChatId, sourceMessageId],
  );
  return result.rows[0]?.id ?? null;
}

export async function findDuplicateByUniqueId(pool, uniqueId, uploaderId = null) {
  if (!uniqueId) return null;
  if (uploaderId === null || uploaderId === undefined) {
    const result = await pool.query(
      'SELECT id, file_code, file_name FROM files WHERE telegram_file_unique_id = $1 AND status = $2 ORDER BY created_at ASC LIMIT 1',
      [uniqueId, 'active'],
    );
    return result.rows[0] ?? null;
  }
  const result = await pool.query(
    'SELECT id, file_code, file_name FROM files WHERE telegram_file_unique_id = $1 AND status = $2 AND COALESCE(uploaded_by, 0) = $3 ORDER BY created_at ASC LIMIT 1',
    [uniqueId, 'active', Number(uploaderId)],
  );
  return result.rows[0] ?? null;
}

export async function markIngestDuplicate(pool, requestId, existingFileId) {
  await pool.query(
    `UPDATE file_ingest_requests SET status = 'duplicate', file_id = $2,
     processing_until = NULL, updated_at = NOW() WHERE id = $1`,
    [requestId, existingFileId],
  );
}

export async function markIngestFailed(pool, requestId, errorMessage) {
  await pool.query(
    `UPDATE file_ingest_requests SET status = 'failed', processing_until = NULL,
     last_error = $2, updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
    [requestId, errorMessage?.slice(0, 500) ?? 'Unknown ingest failure'],
  );
}

export async function getPrimaryStorageChannel(pool, ownerId = null) {
  if (ownerId !== null && ownerId !== undefined) {
    const own = await pool.query(
      `SELECT id, telegram_chat_id, title FROM storage_channels
       WHERE is_enabled = TRUE AND role = 'primary' AND last_test_status = 'ok' AND owner_telegram_id = $1
       ORDER BY priority ASC, id ASC LIMIT 1`,
      [Number(ownerId)],
    );
    if (own.rowCount) return own.rows[0];
  }
  const result = await pool.query(
    `SELECT id, telegram_chat_id, title FROM storage_channels
     WHERE is_enabled = TRUE AND role = 'primary' AND last_test_status = 'ok' AND owner_telegram_id IS NULL
     ORDER BY priority ASC, id ASC LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function persistIndexedFile(pool, requestId, storageChannel, copiedMessageId, metadata, fileCode, uploaderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO files (file_code, file_name, file_type, mime_type, file_size, duration_seconds,
       width, height, caption, telegram_file_id, telegram_file_unique_id, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, file_code, file_name`,
      [fileCode, metadata.fileName, metadata.fileType, metadata.mimeType, metadata.fileSize,
        metadata.durationSeconds, metadata.width, metadata.height, metadata.caption,
        metadata.telegramFileId, metadata.telegramFileUniqueId, uploaderId],
    );
    const file = inserted.rows[0];
    await client.query(
      `INSERT INTO storage_messages (file_id, storage_channel_id, telegram_message_id, telegram_file_id,
       telegram_file_unique_id, is_primary) VALUES ($1, $2, $3, $4, $5, TRUE)`,
      [file.id, storageChannel.id, copiedMessageId, metadata.telegramFileId, metadata.telegramFileUniqueId],
    );
    await client.query(
      `UPDATE file_ingest_requests SET status = 'completed', file_id = $2, storage_channel_id = $3,
       stored_message_id = $4, processing_until = NULL, updated_at = NOW() WHERE id = $1`,
      [requestId, file.id, storageChannel.id, copiedMessageId],
    );
    await client.query('COMMIT');
    return file;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
