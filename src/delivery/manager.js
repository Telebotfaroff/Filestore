import { Telegraf } from 'telegraf';
import { encryptBotToken, decryptBotToken } from '../security/token-encryption.js';
import { createDeliveryBot, DELIVERY_BOT_MENU_COMMANDS } from './bot.js';
import { normalizeSecret } from '../utils/validation.js';
import { launchTelegramBot, inspectBotChannelAccess } from '../bot/telegram-utils.js';
import { cached, cacheDeletePrefix } from '../utils/cache.js';
import { FREE_CREATOR_BOT_SLOTS } from './slot-repository.js';
import { normalizeMainBotUsername } from './start-message-repository.js';

const DELIVERY_BOT_CACHE_PREFIX = 'delivery-bots:';
function invalidateDeliveryBotCache() { cacheDeletePrefix(DELIVERY_BOT_CACHE_PREFIX); }

function ownerWhere(ownerId, paramIdx) {
  if (ownerId === null || ownerId === undefined) {
    return { clause: 'owner_telegram_id IS NULL', params: [] };
  }
  return { clause: `owner_telegram_id = $${paramIdx}`, params: [Number(ownerId)] };
}

function normalizeOwnerId(ownerId) {
  if (ownerId === null || ownerId === undefined) return null;
  const n = Number(ownerId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function createDeliveryBotManager(config, logger, pool) {
  const runtimes = new Map();
  let mainBotId;
  let mainBotUsername = normalizeMainBotUsername(config?.mainBotUsername);
  let healthTimer;

  async function validateToken(token) {
    const tester = new Telegraf(token);
    try {
      return await tester.telegram.getMe();
    } catch (error) {
      if (/404|401|not found|unauthorized/i.test(String(error?.message))) {
        throw new Error('Telegram rejected this bot token (' + error.message + '). Verify the full BotFather token.');
      }
      throw error;
    }
  }

  async function getBotRecord(id, ownerId = undefined) {
    const cacheKey = `${DELIVERY_BOT_CACHE_PREFIX}record:${id}:${ownerId === undefined ? 'any' : String(normalizeOwnerId(ownerId))}`;
    return cached(cacheKey, 15_000, async () => {
      if (ownerId !== undefined) {
        const scope = ownerWhere(ownerId, 2);
        const result = await pool.query(
          `SELECT * FROM delivery_bots WHERE id = $1 AND ${scope.clause} LIMIT 1`,
          [id, ...scope.params],
        );
        return result.rows[0] ?? null;
      }
      const result = await pool.query('SELECT * FROM delivery_bots WHERE id = $1 LIMIT 1', [id]);
      return result.rows[0] ?? null;
    });
  }


  async function storeToken(rawToken, createdBy, ownerId = null) {
    const token = normalizeSecret(rawToken);
    const key = config.tokenEncryptionKey;
    const info = await validateToken(token);
    if (info.id === mainBotId) throw new Error('The Main Bot token cannot be registered as a Delivery Bot.');
    const ciphertext = encryptBotToken(token, key);
    const normalizedOwner = normalizeOwnerId(ownerId);

    const existing = await pool.query('SELECT id, owner_telegram_id FROM delivery_bots WHERE telegram_bot_id = $1', [info.id]);
    if (existing.rowCount) {
      const existingOwner = normalizeOwnerId(existing.rows[0].owner_telegram_id);
      if (existingOwner !== normalizedOwner) {
        throw new Error('This bot is already registered by another user.');
      }
      const id = existing.rows[0].id;
      const runtime = runtimes.get(String(id));
      if (runtime) stopRuntime(id);
      await pool.query(
        'UPDATE delivery_bots SET username = $2, token_ciphertext = $3, is_enabled = TRUE, runtime_status = $4, last_error = NULL, updated_at = NOW() WHERE id = $1',
        [id, info.username, ciphertext, 'offline'],
      );
      invalidateDeliveryBotCache();
      return getBotRecord(id);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [74290138]);
      const scope = ownerWhere(normalizedOwner, 1);

      if (normalizedOwner !== null) {
        const [usedRes, settingsRes] = await Promise.all([
          client.query(`SELECT COUNT(*)::int AS used FROM delivery_bots WHERE ${scope.clause}`, scope.params),
          client.query(
            'SELECT extra_bot_slots FROM user_creator_settings WHERE user_telegram_id = $1 FOR UPDATE',
            [normalizedOwner],
          ),
        ]);
        const used = Number(usedRes.rows[0]?.used ?? 0);
        const extraSlots = Math.max(0, Number(settingsRes.rows[0]?.extra_bot_slots ?? 0));
        const totalAllowed = FREE_CREATOR_BOT_SLOTS + extraSlots;
        if (used >= totalAllowed) {
          throw Object.assign(
            new Error(
              `Delivery Bot limit reached (${used}/${totalAllowed} slots used). You get ${FREE_CREATOR_BOT_SLOTS} free bot slot — unlock an extra slot on the Web Control Panel or change your existing bot.`,
            ),
            { code: 'BOT_SLOT_LIMIT_REACHED', statusCode: 402 },
          );
        }
      }

      const primary = await client.query(
        `SELECT 1 FROM delivery_bots WHERE role = 'primary' AND is_enabled = TRUE AND ${scope.clause} LIMIT 1`,
        scope.params,
      );
      const maxPriority = await client.query(
        `SELECT COALESCE(MAX(priority), 0)::int AS priority FROM delivery_bots WHERE ${scope.clause}`,
        scope.params,
      );
      const role = primary.rowCount ? 'backup' : 'primary';
      const inserted = await client.query(
        `INSERT INTO delivery_bots (telegram_bot_id, username, token_ciphertext, role, priority, is_enabled, runtime_status, created_by, owner_telegram_id)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8) RETURNING id`,
        [info.id, info.username, ciphertext, role, maxPriority.rows[0].priority + 10, 'offline', createdBy, normalizedOwner],
      );
      await client.query('COMMIT');
      invalidateDeliveryBotCache();
      return getBotRecord(inserted.rows[0].id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function replaceToken(id, rawToken, updatedBy, ownerId = undefined) {
    const token = normalizeSecret(rawToken);
    if (!token || token.length < 20) throw new Error('Please send a complete bot token.');
    const existing = await getBotRecord(id, ownerId);
    if (!existing) {
      throw Object.assign(new Error('Delivery Bot not found.'), { statusCode: 404 });
    }

    const info = await validateToken(token);
    if (info.id === mainBotId) {
      throw new Error('The Main Bot token cannot be registered as a Delivery Bot.');
    }

    const duplicate = await pool.query(
      'SELECT id FROM delivery_bots WHERE telegram_bot_id = $1 AND id <> $2 LIMIT 1',
      [info.id, existing.id],
    );
    if (duplicate.rowCount) {
      throw new Error('This bot is already registered.');
    }

    const ciphertext = encryptBotToken(token, config.tokenEncryptionKey);
    try {
      stopRuntime(existing.id);
    } catch {}

    await pool.query(
      `UPDATE delivery_bots
       SET telegram_bot_id = $2,
           username = $3,
           token_ciphertext = $4,
           is_enabled = TRUE,
           runtime_status = 'offline',
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [existing.id, info.id, info.username, ciphertext],
    );
    invalidateDeliveryBotCache();

    const refreshed = await getBotRecord(existing.id);
    const runtime = await startRuntime(refreshed);
    if (!runtime) {
      throw new Error('Replacement token was saved, but its runtime failed to start.');
    }
    const scopeOwner = normalizeOwnerId(existing.owner_telegram_id);
    await ensurePrimary(scopeOwner);

    const { storage, forceSub } = await inspectBotChannelAccess(
      runtime.runtime.bot.telegram,
      pool,
      info.id,
      scopeOwner,
    ).catch(() => ({ storage: [], forceSub: [] }));

    return {
      bot: await getBotRecord(existing.id),
      checks: [...storage, ...forceSub],
    };
  }

  function stopRuntime(id) {
    const entry = runtimes.get(String(id));
    if (!entry) return;
    entry.runtime.stopWorker();
    try { entry.runtime.bot.stop('managed runtime stop'); } catch {}
    runtimes.delete(String(id));
  }

  async function startRuntime(record) {
    const id = String(record.id);
    if (runtimes.has(id)) return runtimes.get(id);
    await pool.query("UPDATE delivery_bots SET runtime_status = 'starting', last_error = NULL, updated_at = NOW() WHERE id = $1", [record.id]);
    invalidateDeliveryBotCache();
    try {
      const token = decryptBotToken(record.token_ciphertext, config.tokenEncryptionKey);
      const ownerTelegramId = normalizeOwnerId(record.owner_telegram_id);
      const isPlatformPrimary = ownerTelegramId === null && record.role === 'primary';
      if (!mainBotUsername && typeof config?.notifyTelegram?.getMe === 'function') {
        try {
          const info = await config.notifyTelegram.getMe();
          mainBotUsername = normalizeMainBotUsername(info?.username);
        } catch {}
      }
      const runtime = createDeliveryBot(config, logger, pool, token, {
        deliveryBotId: record.id,
        includeGlobal: isPlatformPrimary,
        ownerTelegramId,
        mainBotUsername,
        sourceTelegram: () => config.notifyTelegram ?? null,
      });
      if (!runtime) throw new Error('Delivery runtime could not be created');
      await launchTelegramBot(runtime.bot, (error) => {
        logger.error({ botId: record.telegram_bot_id, error: error.message }, 'Delivery Bot polling stopped unexpectedly');
        pool.query("UPDATE delivery_bots SET runtime_status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1", [record.id, String(error.message).slice(0, 500)]).then(invalidateDeliveryBotCache).catch(() => {});
      });
      void runtime.bot.telegram.setMyCommands([...DELIVERY_BOT_MENU_COMMANDS]).catch(() => {});
      runtimes.set(id, {
        runtime,
        recordId: record.id,
        botId: record.telegram_bot_id,
        username: record.username,
        ownerTelegramId,
        paused: false,
      });
      if (record.role === 'primary' || ownerTelegramId !== null) {
        await runtime.startWorker({ deliveryBotId: record.id, includeGlobal: isPlatformPrimary });
      } else {
        runtime.startBroadcastWorker?.(record.id);
      }
      await pool.query("UPDATE delivery_bots SET runtime_status = 'running', last_health_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1", [record.id]);
      invalidateDeliveryBotCache();
      logger.info({ botId: record.telegram_bot_id, username: record.username, ownerTelegramId }, 'Delivery Bot runtime started');
      return runtimes.get(id);
    } catch (error) {
      stopRuntime(record.id);
      await pool.query("UPDATE delivery_bots SET runtime_status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1", [record.id, error.message.slice(0, 500)]);
      invalidateDeliveryBotCache();
      logger.error({ botId: record.telegram_bot_id, error: error.message }, 'Delivery Bot failed to start');
      return null;
    }
  }

  async function promotePrimary(id, ownerId = undefined) {
    const record = await getBotRecord(id, ownerId);
    if (!record || !record.is_enabled) return false;
    const scopeOwner = normalizeOwnerId(record.owner_telegram_id);
    if (!runtimes.has(String(id))) {
      const started = await startRuntime(record);
      if (!started) return false;
    }
    const selectedRuntime = runtimes.get(String(id));
    if (selectedRuntime?.paused) selectedRuntime.paused = false;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [74290138]);
      const scope = ownerWhere(scopeOwner, 1);
      await client.query(
        `UPDATE delivery_bots SET role = 'backup', updated_at = NOW() WHERE role = 'primary' AND ${scope.clause}`,
        scope.params,
      );
      await client.query(
        "UPDATE delivery_bots SET role = 'primary', priority = 0, runtime_status = 'running', updated_at = NOW() WHERE id = $1 AND is_enabled = TRUE",
        [id],
      );
      await client.query('COMMIT');
      invalidateDeliveryBotCache();
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    for (const [entryId, entry] of runtimes.entries()) {
      if (entry.ownerTelegramId !== scopeOwner) continue;
      if (Number(entryId) === Number(id)) {
        await entry.runtime.startWorker({
          deliveryBotId: entry.recordId,
          includeGlobal: scopeOwner === null,
        });
      } else if (scopeOwner === null) {
        entry.runtime.stopWorker();
      } else {
        await entry.runtime.startWorker({
          deliveryBotId: entry.recordId,
          includeGlobal: false,
        });
      }
    }
    return true;
  }

  async function ensurePrimary(ownerId = null) {
    const normalizedOwner = normalizeOwnerId(ownerId);
    const scope = ownerWhere(normalizedOwner, 1);
    const current = await pool.query(
      `SELECT id FROM delivery_bots WHERE role = 'primary' AND is_enabled = TRUE AND runtime_status = 'running' AND ${scope.clause} LIMIT 1`,
      scope.params,
    );
    if (current.rowCount && runtimes.has(String(current.rows[0].id))) {
      await runtimes.get(String(current.rows[0].id)).runtime.startWorker({
        deliveryBotId: current.rows[0].id,
        includeGlobal: normalizedOwner === null,
      });
      return current.rows[0].id;
    }
    const candidate = await pool.query(
      `SELECT id FROM delivery_bots WHERE is_enabled = TRUE AND runtime_status = 'running' AND role = 'backup' AND ${scope.clause} ORDER BY priority ASC, id ASC LIMIT 1`,
      scope.params,
    );
    if (!candidate.rowCount) return null;
    await promotePrimary(candidate.rows[0].id, normalizedOwner);
    return candidate.rows[0].id;
  }

  async function addToken(rawToken, createdBy, ownerId = null) {
    const token = normalizeSecret(rawToken);
    if (!token || token.length < 20) throw new Error('Please send a complete bot token.');
    const normalizedOwner = normalizeOwnerId(ownerId);
    const record = await storeToken(token, createdBy, normalizedOwner);
    const runtime = await startRuntime(record);
    if (!runtime) throw new Error('Token was saved but its runtime failed to start.');
    await ensurePrimary(normalizedOwner);
    return getBotRecord(record.id);
  }

  async function pause(id, ownerId = undefined) {
    const record = await getBotRecord(id, ownerId);
    if (!record) return false;
    const scopeOwner = normalizeOwnerId(record.owner_telegram_id);
    const runtime = runtimes.get(String(id));
    runtime?.runtime.stopWorker();
    if (runtime) runtime.paused = true;
    await pool.query("UPDATE delivery_bots SET runtime_status = 'paused', updated_at = NOW() WHERE id = $1", [id]);
    invalidateDeliveryBotCache();
    if (record.role === 'primary') await ensurePrimary(scopeOwner);
    return true;
  }

  async function resume(id, ownerId = undefined) {
    const record = await getBotRecord(id, ownerId);
    if (!record) return false;
    const scopeOwner = normalizeOwnerId(record.owner_telegram_id);
    await pool.query("UPDATE delivery_bots SET is_enabled = TRUE, runtime_status = 'offline', last_error = NULL, updated_at = NOW() WHERE id = $1", [id]);
    invalidateDeliveryBotCache();
    const refreshed = await getBotRecord(id);
    const runtime = await startRuntime(refreshed);
    if (!runtime) return false;
    await pool.query("UPDATE delivery_bots SET runtime_status = 'running', last_health_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    invalidateDeliveryBotCache();
    const runtimeEntry = runtimes.get(String(id));
    if (runtimeEntry) runtimeEntry.paused = false;
    if (record.role === 'primary' || scopeOwner !== null) {
      await runtime.runtime.startWorker({ deliveryBotId: record.id, includeGlobal: scopeOwner === null && record.role === 'primary' });
    }
    await ensurePrimary(scopeOwner);
    return true;
  }

  async function restart(id, ownerId = undefined) {
    const record = await getBotRecord(id, ownerId);
    if (!record) return false;
    const scopeOwner = normalizeOwnerId(record.owner_telegram_id);
    stopRuntime(id);
    await pool.query("UPDATE delivery_bots SET runtime_status = 'starting', updated_at = NOW() WHERE id = $1", [id]);
    invalidateDeliveryBotCache();
    const refreshed = await getBotRecord(id);
    const runtime = await startRuntime(refreshed);
    if (record.role === 'primary' && runtime) await promotePrimary(id, scopeOwner);
    return Boolean(runtime);
  }

  async function remove(id, ownerId = undefined) {
    const record = await getBotRecord(id, ownerId);
    if (!record) return false;
    const scopeOwner = normalizeOwnerId(record.owner_telegram_id);
    stopRuntime(id);
    await pool.query('DELETE FROM delivery_bots WHERE id = $1', [id]);
    invalidateDeliveryBotCache();
    if (record.role === 'primary') await ensurePrimary(scopeOwner);
    return true;
  }

  async function test(id, ownerId = undefined) {
    const record = await getBotRecord(id, ownerId);
    if (!record) throw new Error('Delivery Bot not found.');
    const runtime = runtimes.get(String(id));
    const tester = runtime?.runtime.bot ?? new Telegraf(decryptBotToken(record.token_ciphertext, config.tokenEncryptionKey));
    const info = await tester.telegram.getMe();
    const scopeOwner = normalizeOwnerId(record.owner_telegram_id);
    const { storage, forceSub } = await inspectBotChannelAccess(tester.telegram, pool, info.id, scopeOwner);
    return { bot: info, checks: [...storage, ...forceSub] };
  }

  async function healthCheck() {
    for (const [id, entry] of runtimes) {
      if (entry.paused) continue;
      try {
        await entry.runtime.bot.telegram.getMe();
        await pool.query("UPDATE delivery_bots SET runtime_status = 'running', last_health_at = NOW(), last_error = NULL WHERE id = $1", [id]);
        invalidateDeliveryBotCache();
      } catch (error) {
        entry.runtime.stopWorker();
        await pool.query("UPDATE delivery_bots SET runtime_status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1", [id, error.message.slice(0, 500)]);
        invalidateDeliveryBotCache();
        logger.warn({ botId: entry.botId, error: error.message }, 'Delivery Bot health check failed');
      }
    }
    await ensurePrimary(null);
  }

  function setMainBotUsername(username) {
    const normalized = normalizeMainBotUsername(username);
    if (normalized) {
      mainBotUsername = normalized;
    }
  }

  async function startAll() {
    const mainInfo = await new Telegraf(config.mainBotToken).telegram.getMe();
    mainBotId = mainInfo.id;
    mainBotUsername = normalizeMainBotUsername(mainInfo.username) ?? mainBotUsername;
    if (config.deliveryBotToken) {
      try {
        await storeToken(config.deliveryBotToken, 0, null);
      } catch (error) {
        logger.info({ reason: error.message }, 'Optional DELIVERY_BOT_TOKEN bootstrap skipped; add or manage delivery bots via /delivery_bot_add');
      }
    }
    const rows = await pool.query("SELECT * FROM delivery_bots WHERE is_enabled = TRUE AND runtime_status <> 'paused' ORDER BY priority ASC, id ASC");
    for (const row of rows.rows) await startRuntime(row);
    await ensurePrimary(null);
    healthTimer = setInterval(() => void healthCheck().catch((error) => logger.error({ error: error.message }, 'Delivery Bot health check loop failed')), 60_000);
    healthTimer.unref?.();
  }

  async function stopAll() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = undefined;
    for (const id of [...runtimes.keys()]) stopRuntime(id);
    await pool.query("UPDATE delivery_bots SET runtime_status = 'offline', updated_at = NOW() WHERE runtime_status <> 'paused'").catch(() => {});
    invalidateDeliveryBotCache();
  }

  async function setPriority(id, priority, ownerId = undefined) {
    if (ownerId !== undefined) {
      const scope = ownerWhere(ownerId, 3);
      const result = await pool.query(
        `UPDATE delivery_bots SET priority = $2, updated_at = NOW() WHERE id = $1 AND ${scope.clause} RETURNING id`,
        [id, priority, ...scope.params],
      );
      invalidateDeliveryBotCache();
      return result.rowCount > 0;
    }
    const result = await pool.query('UPDATE delivery_bots SET priority = $2, updated_at = NOW() WHERE id = $1 RETURNING id', [id, priority]);
    invalidateDeliveryBotCache();
    return result.rowCount > 0;
  }

  async function setEnabled(id, enabled, ownerId = undefined) {
    if (enabled) {
      return resume(id, ownerId);
    }
    const record = await getBotRecord(id, ownerId);
    if (!record) return false;
    const scopeOwner = normalizeOwnerId(record.owner_telegram_id);
    stopRuntime(id);
    await pool.query("UPDATE delivery_bots SET is_enabled = FALSE, runtime_status = 'paused', updated_at = NOW() WHERE id = $1", [id]);
    invalidateDeliveryBotCache();
    if (record.role === 'primary') await ensurePrimary(scopeOwner);
    return true;
  }

  async function list(ownerId = null) {
    const normalizedOwner = normalizeOwnerId(ownerId);
    const cacheKey = `${DELIVERY_BOT_CACHE_PREFIX}list:${normalizedOwner === null ? 'global' : normalizedOwner}`;
    return cached(cacheKey, 15_000, async () => {
      const scope = ownerWhere(normalizedOwner, 1);
      const result = await pool.query(
        `SELECT id, telegram_bot_id, username, role, priority, is_enabled, runtime_status, last_health_at, last_error, owner_telegram_id
         FROM delivery_bots WHERE ${scope.clause} ORDER BY priority ASC, id ASC`,
        scope.params,
      );
      return result.rows;
    });
  }

  return { startAll, stopAll, addToken, replaceToken, pause, resume, restart, remove, promotePrimary, setPriority, setEnabled, setMainBotUsername, test, list };
}

