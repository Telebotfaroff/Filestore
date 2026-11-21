function ownerFilterSql(ownerId, paramIndex = 1) {
  if (ownerId === null || ownerId === undefined) return { clause: 'owner_telegram_id IS NULL', params: [] };
  return { clause: `owner_telegram_id = $${paramIndex}`, params: [Number(ownerId)] };
}

export async function listStorageChannels(pool, ownerId = null) {
  const { clause, params } = ownerFilterSql(ownerId, 1);
  const result = await pool.query(
    `SELECT id, telegram_chat_id, title, username, channel_type, role, priority, is_enabled, last_test_status, owner_telegram_id
     FROM storage_channels WHERE ${clause} ORDER BY priority ASC, id ASC`,
    params,
  );
  return result.rows;
}

export async function getStorageChannelForOwner(pool, channelId, ownerId = null) {
  const { clause, params } = ownerFilterSql(ownerId, 2);
  const res = await pool.query(
    `SELECT id, telegram_chat_id, title, owner_telegram_id FROM storage_channels WHERE telegram_chat_id = $1 AND ${clause} LIMIT 1`,
    [channelId, ...params],
  );
  return res.rows[0] ?? null;
}

export async function saveStorageChannel(pool, chat, creatorId, ownerId = null) {
  const scopedOwner = ownerId === null || ownerId === undefined ? null : Number(ownerId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [74290137]);

    const existing = await client.query(
      'SELECT id, owner_telegram_id FROM storage_channels WHERE telegram_chat_id = $1 FOR UPDATE',
      [chat.id],
    );
    if (existing.rowCount) {
      const existingOwner = existing.rows[0].owner_telegram_id === null || existing.rows[0].owner_telegram_id === undefined
        ? null
        : Number(existing.rows[0].owner_telegram_id);
      if (existingOwner !== scopedOwner) {
        throw new Error('This Telegram channel is already registered by another creator.');
      }
    }

    const { clause, params } = ownerFilterSql(scopedOwner, 1);
    const count = await client.query(
      `SELECT COUNT(*)::int AS total FROM storage_channels WHERE role = 'primary' AND is_enabled = TRUE AND ${clause}`,
      params,
    );
    const isFirst = count.rows[0].total === 0;
    const result = await client.query(
      `INSERT INTO storage_channels (telegram_chat_id, title, username, channel_type, role, priority, is_enabled, verified_at, last_test_status, created_by, owner_telegram_id)
       VALUES ($1, $2, $3, 'channel', $4, $5, TRUE, NOW(), 'ok', $6, $7)
       ON CONFLICT (telegram_chat_id) DO UPDATE SET title = EXCLUDED.title, username = EXCLUDED.username,
         is_enabled = TRUE, verified_at = NOW(), last_test_status = 'ok', last_test_error = NULL, updated_at = NOW()
       RETURNING id, telegram_chat_id, title, username, role, priority, is_enabled, owner_telegram_id`,
      [chat.id, chat.title ?? null, chat.username ?? null, isFirst ? 'primary' : 'backup', isFirst ? 0 : 100, creatorId, scopedOwner],
    );
    if (isFirst) {
      await client.query(`UPDATE storage_channels SET role = 'backup' WHERE role = 'primary' AND ${clause}`, params);
      await client.query("UPDATE storage_channels SET role = 'primary', priority = 0 WHERE telegram_chat_id = $1", [chat.id]);
    }
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateStorageTest(pool, channelId, status, errorMessage = null, ownerId = null) {
  const { clause, params } = ownerFilterSql(ownerId, 5);
  await pool.query(
    `UPDATE storage_channels SET last_test_status = $2, last_test_error = $3,
       verified_at = CASE WHEN $2 = $4 THEN NOW() ELSE verified_at END, updated_at = NOW()
     WHERE telegram_chat_id = $1 AND ${clause}`,
    [channelId, status, errorMessage?.slice(0, 500) ?? null, 'ok', ...params],
  );
}

export async function setStorageEnabled(pool, channelId, enabled, ownerId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [74290137]);
    const { clause, params } = ownerFilterSql(ownerId, 2);
    const found = await client.query(
      `SELECT role, owner_telegram_id FROM storage_channels WHERE telegram_chat_id = $1 AND ${clause} FOR UPDATE`,
      [channelId, ...params],
    );
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    const { clause: scopeClause, params: scopeParams } = ownerFilterSql(found.rows[0].owner_telegram_id, 1);
    await client.query('UPDATE storage_channels SET is_enabled = $2, updated_at = NOW() WHERE telegram_chat_id = $1', [channelId, enabled]);
    if (enabled) {
      const primary = await client.query(
        `SELECT 1 FROM storage_channels WHERE role = 'primary' AND is_enabled = TRUE AND ${scopeClause} LIMIT 1`,
        scopeParams,
      );
      if (!primary.rowCount) {
        await client.query(`UPDATE storage_channels SET role = 'backup' WHERE role = 'primary' AND ${scopeClause}`, scopeParams);
        await client.query("UPDATE storage_channels SET role = 'primary', priority = 0, updated_at = NOW() WHERE telegram_chat_id = $1", [channelId]);
      }
    } else if (found.rows[0].role === 'primary') {
      await client.query("UPDATE storage_channels SET role = 'backup' WHERE telegram_chat_id = $1", [channelId]);
      await promoteNextPrimary(client, found.rows[0].owner_telegram_id);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function setPrimaryStorageChannel(pool, channelId, ownerId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [74290137]);
    const { clause, params } = ownerFilterSql(ownerId, 2);
    const found = await client.query(
      `SELECT id, owner_telegram_id FROM storage_channels WHERE telegram_chat_id = $1 AND ${clause} FOR UPDATE`,
      [channelId, ...params],
    );
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    const { clause: scopeClause, params: scopeParams } = ownerFilterSql(found.rows[0].owner_telegram_id, 1);
    await client.query(`UPDATE storage_channels SET role = 'backup', updated_at = NOW() WHERE ${scopeClause}`, scopeParams);
    await client.query("UPDATE storage_channels SET role = 'primary', priority = 0, is_enabled = TRUE, updated_at = NOW() WHERE telegram_chat_id = $1", [channelId]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function promoteNextPrimary(client, ownerId = null) {
  const { clause, params } = ownerFilterSql(ownerId, 1);
  const candidate = await client.query(
    `SELECT telegram_chat_id FROM storage_channels WHERE is_enabled = TRUE AND last_test_status = 'ok' AND ${clause} ORDER BY priority ASC, id ASC LIMIT 1 FOR UPDATE`,
    params,
  );
  if (candidate.rowCount) {
    await client.query(`UPDATE storage_channels SET role = 'backup' WHERE role = 'primary' AND ${clause}`, params);
    await client.query(
      "UPDATE storage_channels SET role = 'primary', priority = 0, updated_at = NOW() WHERE telegram_chat_id = $1",
      [candidate.rows[0].telegram_chat_id],
    );
  }
}

export async function removeStorageChannel(pool, channelId, ownerId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [74290137]);
    const { clause, params } = ownerFilterSql(ownerId, 2);
    const found = await client.query(
      `SELECT id, role, owner_telegram_id FROM storage_channels WHERE telegram_chat_id = $1 AND ${clause} FOR UPDATE`,
      [channelId, ...params],
    );
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return { removed: false, reason: 'not_found' };
    }
    const refs = await client.query('SELECT COUNT(*)::int AS total FROM storage_messages WHERE storage_channel_id = $1', [found.rows[0].id]);
    if (refs.rows[0].total > 0) {
      await client.query('UPDATE storage_channels SET is_enabled = FALSE, role = $2, updated_at = NOW() WHERE id = $1', [found.rows[0].id, 'backup']);
      if (found.rows[0].role === 'primary') await promoteNextPrimary(client, found.rows[0].owner_telegram_id);
      await client.query('COMMIT');
      return { removed: false, reason: 'referenced', references: refs.rows[0].total };
    }
    await client.query('DELETE FROM storage_channels WHERE id = $1', [found.rows[0].id]);
    if (found.rows[0].role === 'primary') await promoteNextPrimary(client, found.rows[0].owner_telegram_id);
    await client.query('COMMIT');
    return { removed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
