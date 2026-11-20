import { Telegraf, Markup } from 'telegraf';
import { isAdmin } from '../bot/admin-guard.js';
import { getIndexedFile } from '../storage/file-query.js';
import { createSingleDeliveryJob, getDeliveryStats } from './repository.js';
import { createDeliveryWorker } from './worker.js';
import { checkForceSubscription } from '../access/force-subscription.js';
import { upsertTelegramUser } from '../access/user-repository.js';

function getMissingSubscriptionMarkup(missing) {
  const rows = missing.slice(0, 20).map((channel) => [Markup.button.url('Join ' + String(channel.title ?? 'channel').slice(0, 40), channel.join_url)]);
  rows.push([Markup.button.callback('I joined — Verify', 'fs_verify')]);
  return Markup.inlineKeyboard(rows);
}

async function logForceSubEvent(pool, logger, eventType, userId, result) {
  try {
    await pool.query('INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details) VALUES ($1, $2, $2, $3::jsonb)', [eventType, userId, JSON.stringify({ missingChannelIds: result.missing.map((channel) => channel.telegram_chat_id) })]);
  } catch (error) {
    logger.warn({ userId, error: error.message }, 'Force-sub activity log write failed');
  }
}


async function showForceSubStatus(ctx, telegram, pool, userId) {
  const result = await checkForceSubscription(telegram, pool, userId);
  await logForceSubEvent(pool, logger, result.passed ? 'force_sub_verified' : 'force_sub_blocked', userId, result);
  if (result.passed) {
    await ctx.reply('Subscription check passed. All required channels are joined.');
    return result;
  }
  const labels = result.missing.map((channel) => `• ${channel.title ?? channel.telegram_chat_id}${channel.checkStatus === 'check_failed' ? ' (verification temporarily unavailable)' : ''}`).join('\n');
  await ctx.reply('Join the required channels first:\n\n' + labels + '\n\nThen tap Verify.', getMissingSubscriptionMarkup(result.missing));
  return result;
}

export function createDeliveryBot(config, logger, pool, token = config.deliveryBotToken) {
  if (!token) return null;
  const bot = new Telegraf(token);
  let worker;
  let identity = 'delivery-bot';

  bot.use(async (ctx, next) => {
    if (isAdmin(ctx.from?.id, config.adminIds)) return next();
    const command = ctx.message?.text?.trim().split(/\s+/)[0]?.split('@')[0] ?? '';
    const allowed = ['/start', '/verify', '/get'].includes(command) || ctx.callbackQuery?.data === 'fs_verify';
    if (allowed) return next();
    if (ctx.chat?.type === 'private') await ctx.reply('This bot is currently preparing its file access system.');
  });

  bot.command('start', async (ctx) => {
    await upsertTelegramUser(pool, ctx.from);
    if (isAdmin(ctx.from.id, config.adminIds)) {
      await ctx.reply('FileStore Delivery Bot (admin test mode)\n\n/get <file_code> — queue a delivery\n/delivery_status — queue status\n/delivery_test — test storage access\n/verify — check subscriptions');
    } else {
      await ctx.reply('Welcome to FileStore. Use /verify to check required channel subscriptions. File access is not yet enabled.');
    }
  });

  bot.command('verify', async (ctx) => {
    try {
      await upsertTelegramUser(pool, ctx.from);
      await showForceSubStatus(ctx, ctx.telegram, pool, ctx.from.id);
    } catch (error) {
      logger.warn({ userId: ctx.from.id, error: error.message }, 'Force-sub verification command failed');
      await ctx.reply('Subscription verification is temporarily unavailable. Please try again later.');
    }
  });

  bot.action('fs_verify', async (ctx) => {
    try {
      await ctx.answerCbQuery('Checking subscriptions…');
      await upsertTelegramUser(pool, ctx.from);
      const result = await checkForceSubscription(ctx.telegram, pool, ctx.from.id);
      await logForceSubEvent(pool, logger, result.passed ? 'force_sub_verified' : 'force_sub_blocked', ctx.from.id, result);
      if (result.passed) {
        try { await ctx.editMessageText('Subscription verification passed. All required channels are joined.'); } catch {}
      } else {
        const labels = result.missing.map((channel) => `• ${channel.title ?? channel.telegram_chat_id}${channel.checkStatus === 'check_failed' ? ' (verification unavailable)' : ''}`).join("\n");
        try { await ctx.editMessageText('Some channels are still missing:\n\n' + labels + '\n\nJoin them and tap Verify.', getMissingSubscriptionMarkup(result.missing)); } catch {}
      }
    } catch (error) {
      logger.warn({ userId: ctx.from.id, error: error.message }, 'Force-sub callback verification failed');
      await ctx.answerCbQuery('Verification temporarily unavailable. Try again.', { show_alert: true }).catch(() => {});
    }
  });

  bot.command('get', async (ctx) => {
    const code = ctx.message?.text?.trim().split(/\s+/).slice(1)[0] ?? '';
    if (!code) return ctx.reply('Usage: /get <file_code>');
    try {
      if (!isAdmin(ctx.from.id, config.adminIds)) {
        await upsertTelegramUser(pool, ctx.from);
        const forceSub = await checkForceSubscription(ctx.telegram, pool, ctx.from.id);
        await logForceSubEvent(pool, forceSub.passed ? 'force_sub_verified' : 'force_sub_blocked', ctx.from.id, forceSub);
        if (!forceSub.passed) {
          const labels = forceSub.missing.map((channel) => `• ${channel.title ?? channel.telegram_chat_id}${channel.checkStatus === 'check_failed' ? ' (verification unavailable)' : ''}`).join("\n");
          return ctx.reply('Subscribe to the required channels before requesting files:\n\n' + labels + '\n\nThen tap Verify.', getMissingSubscriptionMarkup(forceSub.missing));
        }
        const file = await getIndexedFile(pool, code);
        if (!file) return ctx.reply('File code not found.');
        return ctx.reply('Subscription verified. User file delivery will be enabled after the URL checkpoint and Access Manager are completed.');
      }
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
    if (!isAdmin(ctx.from.id, config.adminIds)) return;
    try {
      const stats = await getDeliveryStats(pool);
      await ctx.reply(`Delivery Queue\n\nPending: ${stats.pending}\nProcessing: ${stats.processing}\nCompleted: ${stats.completed}\nFailed: ${stats.failed}\nUncertain: ${stats.uncertain}`);
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery status query failed');
      await ctx.reply('Could not read delivery queue.');
    }
  });

  bot.command('delivery_test', async (ctx) => {
    if (!isAdmin(ctx.from.id, config.adminIds)) return;
    try {
      const channels = await pool.query('SELECT telegram_chat_id, title FROM storage_channels WHERE is_enabled = TRUE ORDER BY priority ASC');
      const forceSubChannels = await pool.query('SELECT telegram_chat_id, title FROM force_sub_channels WHERE is_enabled = TRUE ORDER BY id ASC');
      const me = await ctx.telegram.getMe();
      const results = [];
      for (const channel of channels.rows.slice(0, 12)) {
        try {
          const member = await ctx.telegram.getChatMember(channel.telegram_chat_id, me.id);
          const access = ['administrator', 'member'].includes(member.status) ? 'OK' : 'NOT A MEMBER';
          results.push(`Storage ${access} · ${String(channel.title ?? channel.telegram_chat_id).slice(0, 90)}`);
        } catch (error) {
          results.push(`Storage FAILED · ${String(channel.title ?? channel.telegram_chat_id).slice(0, 90)} · ${error.message.slice(0, 100)}`);
        }
      }
      for (const channel of forceSubChannels.rows.slice(0, 12)) {
        try {
          const member = await ctx.telegram.getChatMember(channel.telegram_chat_id, me.id);
          const access = member.status === 'administrator' ? 'ADMIN OK' : 'NEEDS ADMIN';
          results.push(`Force-sub ${access} · ${String(channel.title ?? channel.telegram_chat_id).slice(0, 90)}`);
        } catch (error) {
          results.push(`Force-sub FAILED · ${String(channel.title ?? channel.telegram_chat_id).slice(0, 90)} · ${error.message.slice(0, 100)}`);
        }
      }
      await ctx.reply('Delivery Bot permission test\n\n' + (results.join('\n') || 'No channels configured'));
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery bot permission test failed');
      await ctx.reply('Could not run channel access test.');
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
      if (worker) return;
      worker = createDeliveryWorker(bot, pool, logger, identity);
      worker.start();
    },
    stopWorker() {
      worker?.stop();
      worker = undefined;
    },
  };
}
