export async function getAutoDeleteMinutes(pool) {
  const result = await pool.query("SELECT setting_value FROM delivery_settings WHERE setting_key = 'auto_delete_minutes'");
  const minutes = Number(result.rows[0]?.setting_value ?? 0);
  return Number.isInteger(minutes) && minutes >= 0 ? minutes : 0;
}

export async function setAutoDeleteMinutes(pool, minutes, adminId) {
  await pool.query(
    "INSERT INTO delivery_settings (setting_key, setting_value, updated_by) VALUES ('auto_delete_minutes', $1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()",
    [String(minutes), adminId],
  );
}

export async function claimDueDeletion(pool, identity, leaseOwner) {
  const result = await pool.query(
    `UPDATE scheduled_message_deletions
     SET status = 'processing', locked_until = NOW() + INTERVAL '60 seconds', retry_after = NULL,
         locked_by = $2, attempt_count = attempt_count + 1, updated_at = NOW()
     WHERE id = (
       SELECT id FROM scheduled_message_deletions
       WHERE delivery_bot_identity = $1 AND delete_at <= NOW() AND (retry_after IS NULL OR retry_after <= NOW())
         AND (status = 'pending' OR (status = 'processing' AND locked_until < NOW()))
       ORDER BY delete_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, chat_id, message_id`,
    [identity, leaseOwner],
  );
  const row = result.rows[0];
  return row ? { id: row.id, chatId: row.chat_id, messageId: row.message_id, leaseOwner } : null;
}

export async function finishScheduledDeletion(pool, id, leaseOwner) {
  const result = await pool.query(
    "UPDATE scheduled_message_deletions SET status = 'deleted', locked_until = NULL, locked_by = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1 AND status = 'processing' AND locked_by = $2 AND locked_until > NOW()",
    [id, leaseOwner],
);
  return result.rowCount === 1;
}

export async function failScheduledDeletion(pool, id, leaseOwner, error) {
  const result = await pool.query(
    `UPDATE scheduled_message_deletions SET status = CASE WHEN attempt_count >= 5 THEN 'failed' ELSE 'pending' END,
     retry_after = CASE WHEN attempt_count >= 5 THEN NULL ELSE NOW() + make_interval(secs => LEAST(3600, (30 * POWER(2, GREATEST(attempt_count - 1, 0)))::int)) END,
     locked_until = NULL, locked_by = NULL, last_error = $3, updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND locked_by = $2 AND locked_until > NOW()`,
    [id, leaseOwner, String(error).slice(0, 500)],
  );
  return result.rowCount === 1;
}
export async function listFailedScheduledDeletions(pool, limit = 15) {
  const safeLimit = Math.max(1, Math.min(25, Number.isInteger(limit) ? limit : 15));
  const result = await pool.query(
    `SELECT id, delivery_bot_identity, chat_id, message_id, delete_at, attempt_count, last_error, updated_at
     FROM scheduled_message_deletions WHERE status = 'failed'
     ORDER BY updated_at DESC, id DESC LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}
