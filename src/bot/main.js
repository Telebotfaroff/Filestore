import { Telegraf } from 'telegraf';
import { isAdmin } from './admin-guard.js';
import { registerStorageAdminCommands } from '../storage/admin-commands.js';
import { registerFileIngestHandler } from '../storage/ingest-handler.js';
import { registerFileCommands } from '../storage/file-commands.js';

export function createMainBot(config, logger, pool) {
  const bot = new Telegraf(config.mainBotToken);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!isAdmin(userId, config.adminIds)) {
      if (ctx.chat?.type === 'private') {
        await ctx.reply('This bot is restricted to administrators.');
      }
      return;
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'FileStore Control Center\n\n' +
      'The admin bot is online. Use /status to check the current foundation services.\n\n' +
      'Storage channels: /storage\nAdd channel: /storage_add <channel_id or @username>\nFiles: /files · Search: /find <query>\nFile details: /fileinfo <code>'
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply('/start — Admin welcome\n/status — Database status\n/storage — Storage channels\n/storage_add — Add storage channel\n/storage_test — Test channel permissions\n/files — List recent files\n/find — Search files\n/fileinfo — File metadata\n/help — Command list');
  });

  bot.command('status', async (ctx) => {
    const results = await pool.query(
      'SELECT (SELECT COUNT(*)::int FROM users) AS tracked_users, (SELECT COUNT(*)::int FROM files WHERE status = $1) AS active_files',
      ['active'],
    );
    const botInfo = await ctx.telegram.getMe();
    await ctx.reply(
      'FileStore Status\n\n' +
      'Main Bot: Connected (@' + botInfo.username + ')\n' +
      'Database: Connected\n' +
      'Tracked users: ' + results.rows[0].tracked_users + '\n' +
      'Indexed files: ' + results.rows[0].active_files + '\n\n' +
      'Premium and revenue statistics will appear after the membership/payment modules are implemented.'
    );
  });

  registerStorageAdminCommands(bot, pool, logger);
  registerFileCommands(bot, pool, logger);
  registerFileIngestHandler(bot, pool, logger);

  bot.catch((error, ctx) => {
    logger.error({ updateId: ctx.update?.update_id, error: error.message }, 'Telegram handler error');
  });

  return bot;
}
