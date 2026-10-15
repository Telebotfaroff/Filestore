import express from 'express';
import bot from './bot.js';
import { config } from './config.js';
import { closeDatabase, connectDatabase } from './database.js';
import { startMaintenance, stopMaintenance } from './maintenance.js';
import { acceptShortenerCallback } from './shortener.js';
import { verifyShortenerCallback } from './security.js';

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.status(200).json({ ok: true, service: 'filestore-bot' }));
app.get('/', (_req, res) => res.status(200).send('Filestore bot is running.'));

app.get('/shortener/callback', async (req, res) => {
  try {
    const accepted = await acceptShortenerCallback(
      String(req.query.session || ''),
      String(req.query.signature || ''),
      verifyShortenerCallback,
    );
    if (!accepted) return res.status(401).json({ ok: false, error: 'invalid_or_expired_callback' });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[shortener] Callback failed:', error);
    return res.status(500).json({ ok: false, error: 'callback_failed' });
  }
});

let server;

async function shutdown(signal) {
  console.info(`[shutdown] Received ${signal}; closing services…`);
  stopMaintenance();
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
  await startMaintenance(bot);
  const me = await bot.telegram.getMe();
  console.info(`[bot] Started as @${me.username}`);
  if (config.shortenerUrlTemplate) console.info('[shortener] Signed postback verification enabled.');
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch(async (error) => {
  console.error('[startup] Failed to start Filestore:', error);
  try { await closeDatabase(); } catch {}
  process.exit(1);
});
