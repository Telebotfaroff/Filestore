import { loadConfig } from './config/env.js';
import { createLogger } from './logger.js';
import { createDatabasePool, closeDatabasePool } from './database/pool.js';
import { createMainBot } from './bot/main.js';
import { createDeliveryBot } from './delivery/bot.js';

let shutdownStarted = false;
let mainBot;
let deliveryRuntime;

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

  mainBot = createMainBot(config, logger, pool);
  deliveryRuntime = createDeliveryBot(config, logger, pool);
  registerShutdown(logger);

  await mainBot.launch();
  logger.info({ nodeEnv: config.nodeEnv, adminCount: config.adminIds.length }, 'FileStore Main Bot started');

  if (deliveryRuntime) {
    await deliveryRuntime.bot.launch();
    await deliveryRuntime.startWorker();
    logger.info('Delivery Bot started in administrator-only test mode');
  } else {
    logger.info('Delivery Bot is not configured; set DELIVERY_BOT_TOKEN to enable it');
  }
}

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.info('[FileStore] Shutdown requested:', signal);
  deliveryRuntime?.stopWorker();
  try { mainBot?.stop(signal); } catch {}
  try { deliveryRuntime?.bot.stop(signal); } catch {}
  try {
    await closeDatabasePool();
    console.info('[FileStore] Database pool closed');
  } catch (error) {
    console.error('[FileStore] Database shutdown failed:', error.message);
    process.exitCode = 1;
  }
}

function registerShutdown(logger) {
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('[FileStore] Startup failed:', error.message);
  await shutdown('startup-failure');
  process.exitCode = 1;
});
