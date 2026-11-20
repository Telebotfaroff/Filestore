import { Telegraf } from 'telegraf';
import { isAdmin } from './admin-guard.js';
import { registerStorageAdminCommands } from '../storage/admin-commands.js';
import { registerFileIngestHandler } from '../storage/ingest-handler.js';
import { registerFileCommands } from '../storage/file-commands.js';
import { registerDeliveryBotManagerCommands } from '../delivery/admin-commands.js';
import { registerForceSubAdminCommands } from '../access/force-sub-admin-commands.js';

export function createMainBot(config, logger, pool) {
  const bot = new Telegraf(config.mainBotToken);
  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx.from?.id, config.adminIds)) {
      if (ctx.chat?.type === 'private') await ctx.reply('This bot is restricted to administrators.');
      return;
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'FileStore Control Center\n\n' +
      'Send supported media here to store and index it.\n\n' +
      'Storage: /storage · /storage_add\nFiles: /files · /find <query> · /fileinfo <code>\nDelivery bots: /delivery_bots\nForce-sub: /force_sub\nUse /help for all commands.'
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '/start — Admin welcome\n/status — Database status\n/storage — Storage channels\n/storage_add — Add channel\n/storage_test — Test channel permissions\n/storage_enable — Enable channel\n/storage_disable — Disable channel\n/storage_primary — Set primary storage\n/storage_remove — Remove/disable channel\n/files — List indexed files\n/find — Search files\n/fileinfo — File metadata\n/delivery_bots — List managed bots\n/delivery_bot_add — Add token\n/delivery_bot_pause — Pause worker\n/delivery_bot_resume — Resume bot\n/delivery_bot_restart — Restart runtime\n/delivery_bot_remove — Remove bot\n/delivery_bot_primary — Set primary\n/delivery_bot_priority — Set priority\n/delivery_bot_test — Test bot access\n/force_sub — List force-sub channels\n/force_sub_add — Add channel + join URL\n/force_sub_test — Test Main Bot permissions\n/force_sub_enable — Enable channel\n/force_sub_disable — Disable channel\n/force_sub_remove — Remove channel\n/force_sub_global_on — Enable force-sub globally\n/force_sub_global_off — Disable force-sub globally\n/help — Command list'
    );
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
  registerDeliveryBotManagerCommands(bot, config.deliveryManager, logger);
  registerForceSubAdminCommands(bot, pool, logger);

  bot.catch((error, ctx) => {
    logger.error({ updateId: ctx.update?.update_id, error: error.message }, 'Telegram handler error');
  });
  return bot;
}
