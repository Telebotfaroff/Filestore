import { loadConfig } from './config/env.js';
import { createLogger } from './logger.js';
import { createDatabasePool, closeDatabasePool } from './database/pool.js';
import { createMainBot } from './bot/main.js';
import { createDeliveryBotManager } from './delivery/manager.js';
import { startCheckpointSessionCleanup } from './access/checkpoint-cleanup-worker.js';
import { startPaymentRecoveryWorker } from './payments/recovery-worker.js';
import { startPaymentSessionExpiryWorker } from './payments/session-expiry-worker.js';

let shutdownStarted = false;
let mainBot;
let deliveryManager;
let checkpointCleanupWorker;
let paymentRecoveryWorker;
let paymentSessionExpiryWorker;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info('FileStore bootstrap starting');

  const pool = createDatabasePool(config);
  await pool.query('SELECT 1');
  const migrations = await pool.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').catch((error) => {
    throw new Error('Database migrations are not applied. Run npm run migrate first. ' + error.message);
  });
  if (migrations.rowCount === 0) throw new Error('No database migrations found. Run npm run migrate first.');
  const requiredTables = await pool.query(
    "SELECT to_regclass('users') AS users, to_regclass('files') AS files, to_regclass('storage_channels') AS storage_channels, to_regclass('file_ingest_requests') AS file_ingest_requests, to_regclass('delivery_jobs') AS delivery_jobs, to_regclass('delivery_bots') AS delivery_bots, to_regclass('force_sub_channels') AS force_sub_channels",
  );
  if (Object.values(requiredTables.rows[0]).some((tableName) => tableName === null)) {
    throw new Error('Required FileStore tables are missing. Run npm run migrate first.');
  }

  deliveryManager = createDeliveryBotManager(config, logger, pool);
  checkpointCleanupWorker = startCheckpointSessionCleanup(pool, logger);
  mainBot = createMainBot({ ...config, deliveryManager }, logger, pool);
  paymentRecoveryWorker = startPaymentRecoveryWorker(pool, logger, mainBot.telegram);
  paymentSessionExpiryWorker = startPaymentSessionExpiryWorker(pool, logger);
  registerShutdown();

  await mainBot.launch({ handleSignals: false });
  logger.info({ nodeEnv: config.nodeEnv, adminCount: config.adminIds.length }, 'FileStore Main Bot started');

  await deliveryManager.startAll();
  logger.info('Delivery Bot manager initialized (admin-only testing until access controls are completed)');
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
