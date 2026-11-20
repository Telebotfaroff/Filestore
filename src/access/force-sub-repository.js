export async function listForceSubChannels(pool) {
  const result = await pool.query(
    'SELECT id, telegram_chat_id, title, username, join_url, is_enabled, last_test_status FROM force_sub_channels ORDER BY id ASC',
  );
  return result.rows;
}

export async function saveForceSubChannel(pool, chat, joinUrl, addedBy) {
  const result = await pool.query(
    `INSERT INTO force_sub_channels (telegram_chat_id, title, username, join_url, is_enabled, last_test_status, added_by)
     VALUES ($1, $2, $3, $4, TRUE, 'ok', $5)
     ON CONFLICT (telegram_chat_id) DO UPDATE SET title = EXCLUDED.title, username = EXCLUDED.username,
       join_url = EXCLUDED.join_url, is_enabled = TRUE, last_test_status = 'ok', last_test_error = NULL, updated_at = NOW()
     RETURNING id, telegram_chat_id, title, username, join_url, is_enabled`,
    [chat.id, chat.title ?? null, chat.username ?? null, joinUrl, addedBy],
  );
  return result.rows[0];
}

export async function setForceSubEnabled(pool, channelId, enabled) {
  const result = await pool.query(
    'UPDATE force_sub_channels SET is_enabled = $2, updated_at = NOW() WHERE telegram_chat_id = $1 RETURNING id',
    [channelId, enabled],
  );
  return result.rowCount > 0;
}

export async function removeForceSubChannel(pool, channelId) {
  const result = await pool.query('DELETE FROM force_sub_channels WHERE telegram_chat_id = $1 RETURNING id', [channelId]);
  return result.rowCount > 0;
}

export async function setForceSubGlobal(pool, enabled, adminId) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('force_sub_enabled', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [JSON.stringify(enabled), adminId],
  );
}
