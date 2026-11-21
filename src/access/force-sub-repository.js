import { getCreatorSettings, setCreatorForceSubEnabled } from '../wallet/repository.js';

function ownerWhere(ownerId, paramIdx) {
  if (ownerId === null || ownerId === undefined) {
    return { clause: 'owner_telegram_id IS NULL', params: [] };
  }
  return { clause: `owner_telegram_id = $${paramIdx}`, params: [Number(ownerId)] };
}

export async function listForceSubChannels(pool, ownerId = null) {
  const scope = ownerWhere(ownerId, 1);
  const result = await pool.query(
    `SELECT id, telegram_chat_id, title, username, join_url, is_enabled, last_test_status, owner_telegram_id
     FROM force_sub_channels WHERE ${scope.clause} ORDER BY id ASC LIMIT 15`,
    scope.params,
  );
  return result.rows;
}

export async function getForceSubGlobal(pool, ownerId = null) {
  if (ownerId !== null && ownerId !== undefined) {
    const settings = await getCreatorSettings(pool, Number(ownerId));
    return Boolean(settings.force_sub_enabled);
  }
  const setting = await pool.query("SELECT value FROM app_settings WHERE key = 'force_sub_enabled' LIMIT 1");
  return setting.rowCount ? setting.rows[0].value === true : true;
}

export async function saveForceSubChannel(pool, chat, joinUrl, addedBy, ownerId = null) {
  const normalizedOwner = ownerId === null || ownerId === undefined ? null : Number(ownerId);
  const conflictCheck = await pool.query(
    'SELECT id, owner_telegram_id FROM force_sub_channels WHERE telegram_chat_id = $1 LIMIT 20',
    [chat.id],
  );
  const ownedByOther = conflictCheck.rows.find(
    (row) => (row.owner_telegram_id === null ? null : Number(row.owner_telegram_id)) !== normalizedOwner,
  );
  if (ownedByOther) {
    throw new Error('This channel is already registered as a force-subscription channel by another user.');
  }

  const existing = conflictCheck.rows[0];
  if (existing) {
    const result = await pool.query(
      `UPDATE force_sub_channels
       SET title = $2, username = $3, join_url = $4, is_enabled = TRUE, last_test_status = 'ok', last_test_error = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING id, telegram_chat_id, title, username, join_url, is_enabled, owner_telegram_id`,
      [existing.id, chat.title ?? null, chat.username ?? null, joinUrl],
    );
    return result.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO force_sub_channels (telegram_chat_id, title, username, join_url, is_enabled, last_test_status, added_by, owner_telegram_id)
     VALUES ($1, $2, $3, $4, TRUE, 'ok', $5, $6)
     RETURNING id, telegram_chat_id, title, username, join_url, is_enabled, owner_telegram_id`,
    [chat.id, chat.title ?? null, chat.username ?? null, joinUrl, addedBy, normalizedOwner],
  );
  return result.rows[0];
}

export async function setForceSubEnabled(pool, channelId, enabled, ownerId = null) {
  const scope = ownerWhere(ownerId, 3);
  const result = await pool.query(
    `UPDATE force_sub_channels SET is_enabled = $2, updated_at = NOW()
     WHERE telegram_chat_id = $1 AND ${scope.clause} RETURNING id`,
    [channelId, enabled, ...scope.params],
  );
  return result.rowCount > 0;
}

export async function removeForceSubChannel(pool, channelId, ownerId = null) {
  const scope = ownerWhere(ownerId, 2);
  const result = await pool.query(
    `DELETE FROM force_sub_channels WHERE telegram_chat_id = $1 AND ${scope.clause} RETURNING id`,
    [channelId, ...scope.params],
  );
  return result.rowCount > 0;
}

export async function setForceSubGlobal(pool, enabled, adminId, ownerId = null) {
  if (ownerId !== null && ownerId !== undefined) {
    await setCreatorForceSubEnabled(pool, Number(ownerId), Boolean(enabled));
    return;
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('force_sub_enabled', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [JSON.stringify(enabled), adminId],
  );
}

