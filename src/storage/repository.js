export async function listStorageChannels(pool) {
  const result = await pool.query(
    'SELECT id, telegram_chat_id, title, username, channel_type, role, priority, is_enabled, last_test_status FROM storage_channels ORDER BY priority ASC, id ASC',
  );
  return result.rows;
}

export async function saveStorageChannel(pool, chat, creatorId) {
  const result = await pool.query(
    `INSERT INTO storage_channels (telegram_chat_id, title, username, channel_type, role, priority, is_enabled, verified_at, last_test_status, created_by)
     VALUES ($1, $2, $3, 'channel', 'backup', 100, TRUE, NOW(), 'ok', $4)
     ON CONFLICT (telegram_chat_id) DO UPDATE SET title = EXCLUDED.title, username = EXCLUDED.username,
       is_enabled = TRUE, verified_at = NOW(), last_test_status = 'ok', last_test_error = NULL, updated_at = NOW()
     RETURNING id, telegram_chat_id, title, username, role, priority, is_enabled`,
    [chat.id, chat.title ?? null, chat.username ?? null, creatorId],
  );
  return result.rows[0];
}

export async function updateStorageTest(pool, channelId, status, errorMessage = null) {
  await pool.query(
    'UPDATE storage_channels SET last_test_status = $2, last_test_error = $3, verified_at = CASE WHEN $2 = $4 THEN NOW() ELSE verified_at END, updated_at = NOW() WHERE telegram_chat_id = $1',
    [channelId, status, errorMessage?.slice(0, 500) ?? null, 'ok'],
  );
}

export async function setStorageEnabled(pool, channelId, enabled) {
  const result = await pool.query(
    'UPDATE storage_channels SET is_enabled = $2, updated_at = NOW() WHERE telegram_chat_id = $1 RETURNING telegram_chat_id',
    [channelId, enabled],
  );
  return result.rowCount > 0;
}

export async function setPrimaryStorageChannel(pool, channelId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [74290137]);
    const found = await client.query('SELECT id FROM storage_channels WHERE telegram_chat_id = $1 FOR UPDATE', [channelId]);
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query("UPDATE storage_channels SET role = 'backup', updated_at = NOW()");
    await client.query("UPDATE storage_channels SET role = 'primary', priority = 0, updated_at = NOW() WHERE telegram_chat_id = $1", [channelId]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function removeStorageChannel(pool, channelId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id FROM storage_channels WHERE telegram_chat_id = $1 FOR UPDATE', [channelId]);
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return { removed: false, reason: 'not_found' };
    }
    const refs = await client.query('SELECT COUNT(*)::int AS total FROM storage_messages WHERE storage_channel_id = $1', [found.rows[0].id]);
    if (refs.rows[0].total > 0) {
      await client.query('UPDATE storage_channels SET is_enabled = FALSE, updated_at = NOW() WHERE id = $1', [found.rows[0].id]);
      await client.query('COMMIT');
      return { removed: false, reason: 'referenced', references: refs.rows[0].total };
    }
    await client.query('DELETE FROM storage_channels WHERE id = $1', [found.rows[0].id]);
    await client.query('COMMIT');
    return { removed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
