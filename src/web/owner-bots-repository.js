import { parsePositiveInt } from '../utils/validation.js';
import { cacheDeletePrefix } from '../utils/cache.js';

const DELIVERY_BOT_CACHE_PREFIX = 'delivery-bots:';

export async function listAllDeliveryBotsForOwner(pool, { q = '', scope = 'all', status = 'all' } = {}) {
  const search = String(q || '').trim().slice(0, 100);
  const safeScope = ['all', 'platform', 'creator'].includes(scope) ? scope : 'all';
  const safeStatus = ['all', 'running', 'paused', 'error', 'offline', 'disabled'].includes(status) ? status : 'all';

  const { rows } = await pool.query(
    `SELECT
       d.id,
       d.telegram_bot_id,
       d.username,
       d.role,
       d.priority,
       d.is_enabled,
       d.runtime_status,
       d.last_health_at,
       d.last_error,
       d.created_by,
       d.owner_telegram_id,
       d.start_message,
       d.start_image_url,
       (d.start_image_data IS NOT NULL) AS has_start_image_upload,
       d.start_image_mime,
       d.start_updated_at,
       d.created_at,
       d.updated_at,
       ou.username AS owner_username,
       ou.first_name AS owner_first_name,
       ou.last_name AS owner_last_name,
       COALESCE(ua.total_users, 0)::int AS total_users,
       COALESCE(ua.active_users_7d, 0)::int AS active_users_7d,
       COALESCE(ua.total_interactions, 0)::bigint AS total_interactions,
       ua.last_user_seen_at,
       COALESCE(jb.jobs_total, 0)::int AS jobs_total,
       COALESCE(jb.jobs_completed, 0)::int AS jobs_completed,
       COALESCE(jb.jobs_failed, 0)::int AS jobs_failed,
       COALESCE(sc.storage_channels_count, 0)::int AS storage_channels_count
     FROM delivery_bots d
     LEFT JOIN users ou ON ou.telegram_id = d.owner_telegram_id
     LEFT JOIN (
       SELECT
         delivery_bot_id,
         COUNT(DISTINCT telegram_user_id)::int AS total_users,
         COUNT(DISTINCT telegram_user_id) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days')::int AS active_users_7d,
         COALESCE(SUM(interaction_count), 0)::bigint AS total_interactions,
         MAX(last_seen_at) AS last_user_seen_at
       FROM delivery_bot_user_activity
       GROUP BY delivery_bot_id
     ) ua ON ua.delivery_bot_id = d.id
     LEFT JOIN (
       SELECT
         delivery_bot_id,
         COUNT(*)::int AS jobs_total,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS jobs_completed,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS jobs_failed
       FROM delivery_jobs
       WHERE delivery_bot_id IS NOT NULL
       GROUP BY delivery_bot_id
     ) jb ON jb.delivery_bot_id = d.id
     LEFT JOIN (
       SELECT
         COALESCE(owner_telegram_id, 0) AS owner_key,
         COUNT(*)::int AS storage_channels_count
       FROM storage_channels
       WHERE is_enabled = TRUE
       GROUP BY COALESCE(owner_telegram_id, 0)
     ) sc ON sc.owner_key = COALESCE(d.owner_telegram_id, 0)
     WHERE ($1 = 'all' OR ($1 = 'platform' AND d.owner_telegram_id IS NULL) OR ($1 = 'creator' AND d.owner_telegram_id IS NOT NULL))
       AND (
         $2 = 'all'
         OR ($2 = 'disabled' AND d.is_enabled = FALSE)
         OR ($2 IN ('running', 'paused', 'error', 'offline') AND d.is_enabled = TRUE AND d.runtime_status = $2)
       )
       AND (
         $3 = ''
         OR d.username ILIKE '%' || $3 || '%'
         OR d.id::text = $3
         OR d.telegram_bot_id::text ILIKE '%' || $3 || '%'
         OR COALESCE(d.owner_telegram_id::text, '') ILIKE '%' || $3 || '%'
         OR COALESCE(ou.username, '') ILIKE '%' || $3 || '%'
         OR COALESCE(ou.first_name, '') ILIKE '%' || $3 || '%'
         OR COALESCE(ou.last_name, '') ILIKE '%' || $3 || '%'
       )
     ORDER BY (d.owner_telegram_id IS NOT NULL) ASC, d.priority ASC, d.id ASC
     LIMIT 500`,
    [safeScope, safeStatus, search],
  );

  const uniqueRes = await pool.query(
    'SELECT COUNT(DISTINCT telegram_user_id)::int AS unique_bot_users FROM delivery_bot_user_activity',
  );

  return {
    rows,
    uniqueBotUsers: Number(uniqueRes.rows[0]?.unique_bot_users ?? 0),
  };
}

export async function getDeliveryBotDetailsForOwner(pool, botId) {
  const id = parsePositiveInt(botId, 'Bot ID');
  const { rows } = await pool.query(
    `SELECT
       d.id,
       d.telegram_bot_id,
       d.username,
       d.role,
       d.priority,
       d.is_enabled,
       d.runtime_status,
       d.last_health_at,
       d.last_error,
       d.created_by,
       d.owner_telegram_id,
       d.start_message,
       d.start_image_url,
       (d.start_image_data IS NOT NULL) AS has_start_image_upload,
       d.start_image_mime,
       d.start_updated_at,
       d.created_at,
       d.updated_at,
       ou.username AS owner_username,
       ou.first_name AS owner_first_name,
       ou.last_name AS owner_last_name,
       COALESCE(ua.total_users, 0)::int AS total_users,
       COALESCE(ua.active_users_7d, 0)::int AS active_users_7d,
       COALESCE(ua.total_interactions, 0)::bigint AS total_interactions,
       ua.last_user_seen_at,
       COALESCE(jb.jobs_total, 0)::int AS jobs_total,
       COALESCE(jb.jobs_completed, 0)::int AS jobs_completed,
       COALESCE(jb.jobs_failed, 0)::int AS jobs_failed,
       COALESCE(jb.jobs_pending, 0)::int AS jobs_pending
     FROM delivery_bots d
     LEFT JOIN users ou ON ou.telegram_id = d.owner_telegram_id
     LEFT JOIN (
       SELECT
         delivery_bot_id,
         COUNT(DISTINCT telegram_user_id)::int AS total_users,
         COUNT(DISTINCT telegram_user_id) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days')::int AS active_users_7d,
         COALESCE(SUM(interaction_count), 0)::bigint AS total_interactions,
         MAX(last_seen_at) AS last_user_seen_at
       FROM delivery_bot_user_activity
       GROUP BY delivery_bot_id
     ) ua ON ua.delivery_bot_id = d.id
     LEFT JOIN (
       SELECT
         delivery_bot_id,
         COUNT(*)::int AS jobs_total,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS jobs_completed,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS jobs_failed,
         COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS jobs_pending
       FROM delivery_jobs
       WHERE delivery_bot_id IS NOT NULL
       GROUP BY delivery_bot_id
     ) jb ON jb.delivery_bot_id = d.id
     WHERE d.id = $1
     LIMIT 1`,
    [id],
  );
  const bot = rows[0] ?? null;
  if (!bot) return null;

  const ownerParam = bot.owner_telegram_id === null || bot.owner_telegram_id === undefined
    ? null
    : Number(bot.owner_telegram_id);
  const scopeClause = ownerParam === null ? 'owner_telegram_id IS NULL' : 'owner_telegram_id = $1';
  const scopeParams = ownerParam === null ? [] : [ownerParam];

  const [recentUsersRes, storageRes, forceSubRes] = await Promise.all([
    pool.query(
      `SELECT
         a.telegram_user_id,
         a.first_seen_at,
         a.last_seen_at,
         a.interaction_count,
         u.username,
         u.first_name,
         u.last_name,
         u.is_blocked
       FROM delivery_bot_user_activity a
       LEFT JOIN users u ON u.telegram_id = a.telegram_user_id
       WHERE a.delivery_bot_id = $1
       ORDER BY a.last_seen_at DESC
       LIMIT 20`,
      [id],
    ),
    pool.query(
      `SELECT id, telegram_chat_id, title, username, role, is_enabled, last_test_status
       FROM storage_channels
       WHERE ${scopeClause}
       ORDER BY priority ASC, id ASC
       LIMIT 20`,
      scopeParams,
    ),
    pool.query(
      `SELECT id, telegram_chat_id, title, join_url, is_enabled, last_test_status
       FROM force_sub_channels
       WHERE ${scopeClause}
       ORDER BY id ASC
       LIMIT 20`,
      scopeParams,
    ),
  ]);

  return {
    bot,
    recentUsers: recentUsersRes.rows,
    storageChannels: storageRes.rows,
    forceSubChannels: forceSubRes.rows,
  };
}

export async function updateDeliveryBotForOwner(pool, botId, patch = {}, deliveryManager = null) {
  const id = parsePositiveInt(botId, 'Bot ID');
  const existing = await getDeliveryBotDetailsForOwner(pool, id);
  if (!existing) return null;

  if (patch.priority !== undefined) {
    const prio = Number(patch.priority);
    if (!Number.isInteger(prio) || prio < 0 || prio > 100000) {
      throw new Error('Priority must be an integer between 0 and 100000.');
    }
    if (deliveryManager?.setPriority) {
      await deliveryManager.setPriority(id, prio);
    } else {
      await pool.query('UPDATE delivery_bots SET priority = $2, updated_at = NOW() WHERE id = $1', [id, prio]);
      cacheDeletePrefix(DELIVERY_BOT_CACHE_PREFIX);
    }
  }

  if (typeof patch.isEnabled === 'boolean') {
    if (deliveryManager?.setEnabled) {
      await deliveryManager.setEnabled(id, patch.isEnabled);
    } else if (patch.isEnabled && deliveryManager?.resume) {
      await deliveryManager.resume(id);
    } else if (!patch.isEnabled && deliveryManager?.pause) {
      await deliveryManager.pause(id);
      await pool.query('UPDATE delivery_bots SET is_enabled = FALSE, updated_at = NOW() WHERE id = $1', [id]);
      cacheDeletePrefix(DELIVERY_BOT_CACHE_PREFIX);
    } else {
      await pool.query(
        'UPDATE delivery_bots SET is_enabled = $2, runtime_status = $3, updated_at = NOW() WHERE id = $1',
        [id, patch.isEnabled, patch.isEnabled ? 'offline' : 'paused'],
      );
      cacheDeletePrefix(DELIVERY_BOT_CACHE_PREFIX);
    }
  }

  if (patch.role === 'primary') {
    if (deliveryManager?.promotePrimary) {
      const promoted = await deliveryManager.promotePrimary(id);
      if (!promoted) throw new Error('Bot must be enabled and healthy to become primary.');
    } else {
      const ownerId = existing.bot.owner_telegram_id === null || existing.bot.owner_telegram_id === undefined
        ? null
        : Number(existing.bot.owner_telegram_id);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          ownerId === null
            ? "UPDATE delivery_bots SET role = 'backup', updated_at = NOW() WHERE role = 'primary' AND owner_telegram_id IS NULL"
            : "UPDATE delivery_bots SET role = 'backup', updated_at = NOW() WHERE role = 'primary' AND owner_telegram_id = $1",
          ownerId === null ? [] : [ownerId],
        );
        await client.query(
          "UPDATE delivery_bots SET role = 'primary', priority = 0, updated_at = NOW() WHERE id = $1 AND is_enabled = TRUE",
          [id],
        );
        await client.query('COMMIT');
        cacheDeletePrefix(DELIVERY_BOT_CACHE_PREFIX);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  }

  if (patch.action) {
    const action = String(patch.action).trim();
    if (!['pause', 'resume', 'restart'].includes(action)) {
      throw new Error('Unsupported bot runtime action.');
    }
    if (deliveryManager && typeof deliveryManager[action] === 'function') {
      const ok = await deliveryManager[action](id);
      if (!ok) throw new Error(`Failed to ${action} delivery bot.`);
    } else {
      const nextStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'starting';
      await pool.query(
        'UPDATE delivery_bots SET runtime_status = $2, is_enabled = CASE WHEN $2 = \'running\' THEN TRUE ELSE is_enabled END, updated_at = NOW() WHERE id = $1',
        [id, nextStatus],
      );
      cacheDeletePrefix(DELIVERY_BOT_CACHE_PREFIX);
    }
  }

  return getDeliveryBotDetailsForOwner(pool, id);
}
