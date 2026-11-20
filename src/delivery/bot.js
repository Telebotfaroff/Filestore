import { Telegraf } from 'telegraf';
import { isAdmin } from '../bot/admin-guard.js';
import { getIndexedFile } from '../storage/file-query.js';
import { createSingleDeliveryJob, getDeliveryStats } from './repository.js';
import { createDeliveryWorker } from './worker.js';

export function createDeliveryBot(config, logger, pool, token = config.deliveryBotToken) {
  if (!token) return null;
  const bot = new Telegraf(token);
  let worker;
  let identity = 'delivery-bot';

  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx.from?.id, config.adminIds)) {
      if (ctx.chat?.type === 'private') await ctx.reply('FileStore delivery is currently in administrator test mode.');
      return;
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply('FileStore Delivery Bot (administrator test mode)\n\n/get <file_code> — queue a file delivery\n/delivery_status — queue status\n/delivery_test — test access to enabled storage channels');
  });

  bot.command('get', async (ctx) => {
    const code = ctx.message?.text?.trim().split(/\s+/).slice(1)[0] ?? '';
    if (!code) return ctx.reply('Usage: /get <file_code>');
    try {
      const file = await getIndexedFile(pool, code);
      if (!file) return ctx.reply('File code not found.');
      if (!file.telegram_message_id || !file.storage_chat_id || !file.storage_channel_enabled) return ctx.reply('This file has no usable message in an enabled storage channel.');
      const jobId = await createSingleDeliveryJob(pool, ctx.from.id, file.id, ctx.from.id);
      await ctx.reply(`Delivery queued.\nJob ID: ${jobId}\nFile: ${file.file_name}`);
    } catch (error) {
      logger.error({ error: error.message, userId: ctx.from.id }, 'Delivery request creation failed');
      await ctx.reply('Could not queue this delivery.');
    }
  });

  bot.command('delivery_status', async (ctx) => {
    try {
      const stats = await getDeliveryStats(pool);
      await ctx.reply(`Delivery Queue\n\nPending: ${stats.pending}\nProcessing: ${stats.processing}\nCompleted: ${stats.completed}\nFailed: ${stats.failed}\nUncertain: ${stats.uncertain}`);
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery status query failed');
      await ctx.reply('Could not read delivery queue.');
    }
  });

  bot.command('delivery_test', async (ctx) => {
    try {
      const channels = await pool.query('SELECT telegram_chat_id, title FROM storage_channels WHERE is_enabled = TRUE ORDER BY priority ASC');
      if (!channels.rowCount) return ctx.reply('No enabled storage channels found.');
      const me = await ctx.telegram.getMe();
      const results = [];
      for (const channel of channels.rows.slice(0, 12)) {
        try {
          const member = await ctx.telegram.getChatMember(channel.telegram_chat_id, me.id);
          const access = ['administrator', 'member'].includes(member.status) ? 'OK' : 'NOT A MEMBER';
          results.push(`${access} · ${String(channel.title ?? channel.telegram_chat_id).slice(0, 100)}`);
        } catch (error) {
          results.push(`FAILED · ${channel.title ?? channel.telegram_chat_id} · ${error.message.slice(0, 120)}`);
        }
      }
      await ctx.reply('Delivery Bot storage access test\n\n' + results.join('\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery bot permission test failed');
      await ctx.reply('Could not run storage access test.');
    }
  });

  bot.catch((error, ctx) => {
    logger.error({ updateId: ctx.update?.update_id, error: error.message }, 'Delivery Bot handler error');
  });

  return {
    bot,
    async startWorker() {
      const me = await bot.telegram.getMe();
      identity = me.username ? '@' + me.username : String(me.id);
      worker = createDeliveryWorker(bot, pool, logger, identity);
      worker.start();
    },
    stopWorker() {
      worker?.stop();
    },
  };
}
