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

export async function claimDueDeletion(pool, identity) {
  const result = await pool.query(
    `UPDATE scheduled_message_deletions
     SET status = 'processing', locked_until = NOW() + INTERVAL '60 seconds',
         attempt_count = attempt_count + 1, updated_at = NOW()
     WHERE id = (
       SELECT id FROM scheduled_message_deletions
       WHERE delivery_bot_identity = $1 AND delete_at <= NOW()
         AND (status = 'pending' OR (status = 'processing' AND locked_until < NOW()))
       ORDER BY delete_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, chat_id, message_id`,
    [identity],
  );
  const row = result.rows[0];
  return row ? { id: row.id, chatId: row.chat_id, messageId: row.message_id } : null;
}

export async function finishScheduledDeletion(pool, id) {
  await pool.query("UPDATE scheduled_message_deletions SET status = 'deleted', locked_until = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1", [id]);
}

export async function failScheduledDeletion(pool, id, error) {
  await pool.query(
    `UPDATE scheduled_message_deletions SET status = CASE WHEN attempt_count >= 5 THEN 'failed' ELSE 'pending' END,
     locked_until = NULL, last_error = $2, updated_at = NOW() WHERE id = $1`,
    [String(error).slice(0, 500), id],
  );
}
