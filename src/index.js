import { loadConfig } from './config/env.js';
import { createLogger } from './logger.js';

let shutdownStarted = false;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info('FileStore bootstrap starting');
  logger.info({ nodeEnv: config.nodeEnv, adminCount: config.adminIds.length }, 'Configuration loaded');
  logger.info('Bootstrap milestone is ready; Telegram and database runtimes are not initialized yet');
  registerShutdown(logger);
}
function registerShutdown(logger) {
  const shutdown = async (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info({ signal }, 'Shutdown requested');
    // Later milestones will register database and Telegram resource cleanup here.
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
main().catch((error) => {
  console.error('[FileStore] Startup failed:', error.message);
  process.exitCode = 1;
});
