import { Telegraf } from 'telegraf';
import { encryptBotToken, decryptBotToken } from '../security/token-encryption.js';
import { createDeliveryBot } from './bot.js';

export function createDeliveryBotManager(config, logger, pool) {
  const runtimes = new Map();
  let mainBotId;
  let healthTimer;

  async function validateToken(token) {
    const tester = new Telegraf(token);
    return tester.telegram.getMe();
  }

  async function storeToken(token, createdBy) {
    const key = config.tokenEncryptionKey;
    const info = await validateToken(token);
    if (info.id === mainBotId) throw new Error('The Main Bot token cannot be registered as a Delivery Bot.');
    const ciphertext = encryptBotToken(token, key);
    const existing = await pool.query('SELECT id FROM delivery_bots WHERE telegram_bot_id = $1', [info.id]);
    if (existing.rowCount) {
      const id = existing.rows[0].id;
      const runtime = runtimes.get(String(id));
      if (runtime) stopRuntime(id);
      await pool.query(
        'UPDATE delivery_bots SET username = $2, token_ciphertext = $3, is_enabled = TRUE, runtime_status = $4, last_error = NULL, updated_at = NOW() WHERE id = $1',
        [id, info.username, ciphertext, 'offline'],
      );
      return getBotRecord(id);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [74290138]);
      const primary = await client.query("SELECT 1 FROM delivery_bots WHERE role = 'primary' AND is_enabled = TRUE LIMIT 1");
      const maxPriority = await client.query('SELECT COALESCE(MAX(priority), 0)::int AS priority FROM delivery_bots');
      const role = primary.rowCount ? 'backup' : 'primary';
      const inserted = await client.query(
        'INSERT INTO delivery_bots (telegram_bot_id, username, token_ciphertext, role, priority, is_enabled, runtime_status, created_by) VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7) RETURNING id',
        [info.id, info.username, ciphertext, role, maxPriority.rows[0].priority + 10, 'offline', createdBy],
      );
      await client.query('COMMIT');
      return getBotRecord(inserted.rows[0].id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getBotRecord(id) {
    const result = await pool.query('SELECT * FROM delivery_bots WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] ?? null;
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
    try {
      const token = decryptBotToken(record.token_ciphertext, config.tokenEncryptionKey);
      const runtime = createDeliveryBot(config, logger, pool, token);
      if (!runtime) throw new Error('Delivery runtime could not be created');
      await runtime.bot.launch({ handleSignals: false });
      runtimes.set(id, { runtime, botId: record.telegram_bot_id, username: record.username, paused: false });
      if (record.role === 'primary') await runtime.startWorker();
      await pool.query("UPDATE delivery_bots SET runtime_status = 'running', last_health_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1", [record.id]);
      logger.info({ botId: record.telegram_bot_id, username: record.username }, 'Delivery Bot runtime started');
      return runtimes.get(id);
    } catch (error) {
      stopRuntime(record.id);
      await pool.query("UPDATE delivery_bots SET runtime_status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1", [error.message.slice(0, 500), record.id]);
      logger.error({ botId: record.telegram_bot_id, error: error.message }, 'Delivery Bot failed to start');
      return null;
    }
  }

  async function promotePrimary(id) {
    const record = await getBotRecord(id);
    if (!record || !record.is_enabled) return false;
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
      await client.query("UPDATE delivery_bots SET role = 'backup', updated_at = NOW() WHERE role = 'primary'");
      await client.query("UPDATE delivery_bots SET role = 'primary', priority = 0, runtime_status = 'running', updated_at = NOW() WHERE id = $1 AND is_enabled = TRUE", [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const entry of runtimes.values()) entry.runtime.stopWorker();
    runtimes.get(String(id))?.runtime.startWorker();
    return true;
  }

  async function ensurePrimary() {
    const current = await pool.query("SELECT id FROM delivery_bots WHERE role = 'primary' AND is_enabled = TRUE AND runtime_status = 'running' LIMIT 1");
    if (current.rowCount && runtimes.has(String(current.rows[0].id))) {
      runtimes.get(String(current.rows[0].id)).runtime.startWorker();
      return current.rows[0].id;
    }
    const candidate = await pool.query("SELECT id FROM delivery_bots WHERE is_enabled = TRUE AND runtime_status = 'running' AND role = 'backup' ORDER BY priority ASC, id ASC LIMIT 1");
    if (!candidate.rowCount) return null;
    await promotePrimary(candidate.rows[0].id);
    return candidate.rows[0].id;
  }

  async function addToken(token, createdBy) {
    if (!token || token.length < 20) throw new Error('Please send a complete bot token.');
    const record = await storeToken(token, createdBy);
    const runtime = await startRuntime(record);
    if (!runtime) throw new Error('Token was saved but its runtime failed to start. Check /delivery_bots.');
    await ensurePrimary();
    return getBotRecord(record.id);
  }

  async function pause(id) {
    const record = await getBotRecord(id);
    if (!record) return false;
    const runtime = runtimes.get(String(id));
    runtime?.runtime.stopWorker();
    if (runtime) runtime.paused = true;
    await pool.query("UPDATE delivery_bots SET runtime_status = 'paused', updated_at = NOW() WHERE id = $1", [id]);
    if (record.role === 'primary') await ensurePrimary();
    return true;
  }

  async function resume(id) {
    const record = await getBotRecord(id);
    if (!record) return false;
    await pool.query("UPDATE delivery_bots SET is_enabled = TRUE, runtime_status = 'offline', last_error = NULL, updated_at = NOW() WHERE id = $1", [id]);
    const refreshed = await getBotRecord(id);
    const runtime = await startRuntime(refreshed);
    if (!runtime) return false;
    await pool.query("UPDATE delivery_bots SET runtime_status = 'running', last_health_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    const runtimeEntry = runtimes.get(String(id));
    if (runtimeEntry) runtimeEntry.paused = false;
    if (record.role === 'primary') runtime.runtime.startWorker();
    await ensurePrimary();
    return true;
  }

  async function restart(id) {
    const record = await getBotRecord(id);
    if (!record) return false;
    stopRuntime(id);
    await pool.query("UPDATE delivery_bots SET runtime_status = 'starting', updated_at = NOW() WHERE id = $1", [id]);
    const refreshed = await getBotRecord(id);
    const runtime = await startRuntime(refreshed);
    if (record.role === 'primary' && runtime) await promotePrimary(id);
    return Boolean(runtime);
  }

  async function remove(id) {
    const record = await getBotRecord(id);
    if (!record) return false;
    stopRuntime(id);
    await pool.query('DELETE FROM delivery_bots WHERE id = $1', [id]);
    if (record.role === 'primary') await ensurePrimary();
    return true;
  }

  async function test(id) {
    const record = await getBotRecord(id);
    if (!record) throw new Error('Delivery Bot not found.');
    const runtime = runtimes.get(String(id));
    const tester = runtime?.runtime.bot ?? new Telegraf(decryptBotToken(record.token_ciphertext, config.tokenEncryptionKey));
    const info = await tester.telegram.getMe();
    const channels = await pool.query('SELECT telegram_chat_id, title FROM storage_channels WHERE is_enabled = TRUE ORDER BY priority ASC');
    const checks = [];
    for (const channel of channels.rows.slice(0, 12)) {
      try {
        const member = await tester.telegram.getChatMember(channel.telegram_chat_id, info.id);
        checks.push({ channel: channel.title ?? channel.telegram_chat_id, status: ['administrator', 'member'].includes(member.status) ? 'ok' : 'not_member' });
      } catch (error) {
        checks.push({ channel: channel.title ?? channel.telegram_chat_id, status: 'error', message: error.message.slice(0, 120) });
      }
    }
    return { bot: info, checks };
  }

  async function healthCheck() {
    for (const [id, entry] of runtimes) {
      if (entry.paused) continue;
      try {
        await entry.runtime.bot.telegram.getMe();
        await pool.query("UPDATE delivery_bots SET runtime_status = 'running', last_health_at = NOW(), last_error = NULL WHERE id = $1", [id]);
      } catch (error) {
        entry.runtime.stopWorker();
        await pool.query("UPDATE delivery_bots SET runtime_status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1", [error.message.slice(0, 500), id]);
        logger.warn({ botId: entry.botId, error: error.message }, 'Delivery Bot health check failed');
      }
    }
    await ensurePrimary();
  }

  async function startAll() {
    const mainInfo = await new Telegraf(config.mainBotToken).telegram.getMe();
    mainBotId = mainInfo.id;
    if (config.deliveryBotToken) await storeToken(config.deliveryBotToken, 0);
    const rows = await pool.query("SELECT * FROM delivery_bots WHERE is_enabled = TRUE AND runtime_status <> 'paused' ORDER BY priority ASC, id ASC");
    for (const row of rows.rows) await startRuntime(row);
    await ensurePrimary();
    healthTimer = setInterval(() => void healthCheck().catch((error) => logger.error({ error: error.message }, 'Delivery Bot health check loop failed')), 60_000);
    healthTimer.unref?.();
  }

  async function stopAll() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = undefined;
    for (const id of [...runtimes.keys()]) stopRuntime(id);
    await pool.query("UPDATE delivery_bots SET runtime_status = 'offline', updated_at = NOW() WHERE runtime_status <> 'paused'").catch(() => {});
  }

  async function setPriority(id, priority) {
    const result = await pool.query('UPDATE delivery_bots SET priority = $2, updated_at = NOW() WHERE id = $1 RETURNING id', [id, priority]);
    return result.rowCount > 0;
  }

  async function list() {
    const result = await pool.query('SELECT id, telegram_bot_id, username, role, priority, is_enabled, runtime_status, last_health_at, last_error FROM delivery_bots ORDER BY priority ASC, id ASC');
    return result.rows;
  }

  return { startAll, stopAll, addToken, pause, resume, restart, remove, promotePrimary, setPriority, test, list };
}
