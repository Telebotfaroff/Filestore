import { loadRuntimeConfig } from './config/env.js';
import { createLogger } from './logger.js';
import { createDatabasePool, activateMockDatabasePool, closeDatabasePool } from './database/pool.js';
import { runMigrations } from './database/migrate.js';
import { resolveTokenEncryptionKey } from './security/token-encryption.js';
import { createMainBot, MAIN_BOT_MENU_COMMANDS } from './bot/main.js';
import { createDeliveryBotManager } from './delivery/manager.js';
import { startCheckpointSessionCleanup } from './access/checkpoint-cleanup-worker.js';
import { startPaymentRecoveryWorker } from './payments/recovery-worker.js';
import { startPaymentSessionExpiryWorker } from './payments/session-expiry-worker.js';
import { startHttpServer } from './server.js';
import { launchTelegramBot } from './bot/telegram-utils.js';

let shutdownStarted = false;
let httpServer;
let mainBot;
let deliveryManager;
let checkpointCleanupWorker;
let paymentRecoveryWorker;
let paymentSessionExpiryWorker;

function sanitizeErrorMessage(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[REDACTED]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 300);
}

async function verifyDatabaseSchema(pool) {
  await pool.query('SELECT 1');
  await runMigrations(pool);
  const requiredTables = await pool.query(
    "SELECT to_regclass('users') AS users, to_regclass('files') AS files, to_regclass('storage_channels') AS storage_channels, to_regclass('file_ingest_requests') AS file_ingest_requests, to_regclass('delivery_jobs') AS delivery_jobs, to_regclass('delivery_bots') AS delivery_bots, to_regclass('force_sub_channels') AS force_sub_channels, to_regclass('scheduled_message_deletions') AS scheduled_message_deletions, to_regclass('payment_transactions') AS payment_transactions",
  );
  if (Object.values(requiredTables.rows[0]).some((tableName) => tableName === null)) {
    throw new Error('Required FileStore tables are missing after migrations.');
  }
}

async function main() {
  const config = loadRuntimeConfig();
  const logger = createLogger(config);
  logger.info({ previewMode: config.previewMode }, 'FileStore bootstrap starting');

  const runtimeState = {
    port: config.port,
    nodeEnv: config.nodeEnv,
    database: 'mocked',
    databaseError: null,
    telegram: 'standby',
    telegramError: null,
    delivery: 'standby',
    deliveryError: null,
    botUsername: null,
    missingEnv: config.missingEnv,
    pool: null,
    config,
    notifyTelegram: null,
  };

  registerShutdown();
  httpServer = await startHttpServer(runtimeState, logger);

  let pool = createDatabasePool(config);
  if (!pool.isMock) {
    try {
      await verifyDatabaseSchema(pool);
      runtimeState.database = 'connected';
      runtimeState.databaseError = null;
    } catch (error) {
      const safeMessage = sanitizeErrorMessage(error);
      runtimeState.databaseError = safeMessage;
      logger.warn({ error: safeMessage }, 'PostgreSQL unavailable or migration failed — falling back to mock database pool');
      await pool.end().catch(() => {});
      pool = activateMockDatabasePool();
      runtimeState.database = 'mocked';
    }
  }
  runtimeState.pool = pool;

  if (!config.previewMode && config.mainBotToken && !pool.isMock) {
    const tokenEncryptionKey = await resolveTokenEncryptionKey(pool, config.tokenEncryptionKey);
    const effectiveConfig = { ...config, tokenEncryptionKey, notifyTelegram: null };
    try {
      deliveryManager = createDeliveryBotManager(effectiveConfig, logger, pool);
      checkpointCleanupWorker = startCheckpointSessionCleanup(pool, logger);
      mainBot = createMainBot({ ...effectiveConfig, deliveryManager }, logger, pool);
      effectiveConfig.notifyTelegram = mainBot.telegram;
      Object.freeze(effectiveConfig);
      runtimeState.config = effectiveConfig;
      runtimeState.notifyTelegram = mainBot.telegram;
      paymentRecoveryWorker = startPaymentRecoveryWorker(pool, logger, mainBot.telegram, 30_000, config.adminIds);
      paymentSessionExpiryWorker = startPaymentSessionExpiryWorker(pool, logger);

      const botInfo = await launchTelegramBot(mainBot, (error) => {
        const safeMessage = sanitizeErrorMessage(error);
        runtimeState.telegram = 'standby';
        runtimeState.telegramError = safeMessage;
        logger.error({ error: safeMessage }, 'Main Bot polling stopped unexpectedly');
      });
      runtimeState.telegram = 'connected';
      runtimeState.telegramError = null;
      runtimeState.botUsername = botInfo?.username ?? null;
      logger.info({ nodeEnv: config.nodeEnv, adminCount: config.adminIds.length, username: runtimeState.botUsername }, 'FileStore Main Bot started');
      void mainBot.telegram.setMyCommands([...MAIN_BOT_MENU_COMMANDS]).catch(() => {});
    } catch (error) {
      const safeMessage = sanitizeErrorMessage(error);
      runtimeState.telegramError = safeMessage;
      logger.warn({ error: safeMessage }, 'Main Bot launch skipped/failed — HTTP server remains active in standby mode');
      runtimeState.telegram = 'standby';
    }

    if (runtimeState.telegram === 'connected') {
      try {
        await deliveryManager.startAll();
        runtimeState.delivery = 'connected';
        runtimeState.deliveryError = null;
        logger.info('Delivery Bot manager initialized');
      } catch (error) {
        const safeMessage = sanitizeErrorMessage(error);
        runtimeState.delivery = 'error';
        runtimeState.deliveryError = safeMessage;
        logger.warn({ error: safeMessage }, 'Delivery Bot manager initialization failed');
      }
    }
  } else {
    logger.info({ missingEnv: config.missingEnv, database: runtimeState.database }, 'Running in standby mode');
  }
}

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.info('[FileStore] Shutdown requested:', signal);
  try { checkpointCleanupWorker?.stop(); } catch {}
  try { paymentRecoveryWorker?.stop(); } catch {}
  try { paymentSessionExpiryWorker?.stop(); } catch {}
  try { await deliveryManager?.stopAll(); } catch (error) {
    console.error('[FileStore] Delivery runtimes shutdown failed:', error.message);
  }
  try { mainBot?.stop(signal); } catch {}
  try {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve()));
      console.info('[FileStore] HTTP server closed');
    }
  } catch {}
  try {
    await closeDatabasePool();
    console.info('[FileStore] Database pool closed');
  } catch (error) {
    console.error('[FileStore] Database shutdown failed:', error.message);
    process.exitCode = 1;
  }
}

function registerShutdown() {
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('[FileStore] Startup failed:', error.message);
  await shutdown('startup-failure');
  process.exitCode = 1;
});
