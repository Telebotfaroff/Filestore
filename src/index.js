import { loadConfig } from './config/env.js';
import { createLogger } from './logger.js';
import { createDatabasePool, closeDatabasePool } from './database/pool.js';
import { createMainBot } from './bot/main.js';

let shutdownStarted = false;
let bot;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info('FileStore bootstrap starting');

  const pool = createDatabasePool(config);
  await pool.query('SELECT 1');
  const migrations = await pool.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').catch((error) => {
    throw new Error('Database migrations are not applied. Run npm run migrate first. ' + error.message);
  });
  if (migrations.rowCount === 0) {
    throw new Error('No database migrations found. Run npm run migrate first.');
  }

  bot = createMainBot(config, logger, pool);
  registerShutdown(logger, bot);

  await bot.launch();
  logger.info({ nodeEnv: config.nodeEnv, adminCount: config.adminIds.length }, 'FileStore Main Bot started');
}

function registerShutdown(logger, currentBot) {
  const shutdown = async (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info({ signal }, 'Shutdown requested');
    try {
      currentBot.stop(signal);
    } catch (error) {
      logger.warn({ error: error.message }, 'Telegram bot shutdown warning');
    }
    try {
      await closeDatabasePool();
      logger.info('Database pool closed');
    } catch (error) {
      logger.error({ error: error.message }, 'Database shutdown failed');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[FileStore] Startup failed:', error.message);
  process.exitCode = 1;
});
