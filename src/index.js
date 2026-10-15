import express from 'express';
import bot from './bot.js';
import { config } from './config.js';
import { closeDatabase, connectDatabase } from './database.js';

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'filestore-bot' }));
app.get('/', (_req, res) => res.status(200).send('Filestore bot is running.'));

let server;

async function shutdown(signal) {
  console.info(`[shutdown] Received ${signal}; closing services…`);
  try {
    await bot.stop(signal);
    if (server) await new Promise((resolve) => server.close(resolve));
    await closeDatabase();
  } catch (error) {
    console.error('[shutdown] Error:', error);
  } finally {
    process.exit(0);
  }
}

async function main() {
  await connectDatabase();
  server = app.listen(config.port, () => console.info(`[health] Listening on port ${config.port}`));
  await bot.launch();
  const me = await bot.telegram.getMe();
  console.info(`[bot] Started as @${me.username}`);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch(async (error) => {
  console.error('[startup] Failed to start Filestore:', error);
  try { await closeDatabase(); } catch {}
  process.exit(1);
});
