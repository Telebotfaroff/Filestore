import { Telegraf, Markup } from 'telegraf';
import { isAdmin } from '../bot/admin-guard.js';
import { getIndexedFile } from '../storage/file-query.js';
import { createSingleDeliveryJob, createBatchDeliveryJob, getDeliveryStats } from './repository.js';
import { getPaidBatch, requestPaidBatchPurchase, getBatchItems } from '../paid-files/batch-repository.js';
import { createDeliveryWorker } from './worker.js';
import { createAutoDeleteWorker } from './auto-delete-worker.js';
import { checkForceSubscription } from '../access/force-subscription.js';
import { upsertTelegramUser } from '../access/user-repository.js';
import { evaluateAccess } from '../access/access-manager.js';
import { getCheckpointRequirement } from '../access/checkpoint-engine.js';
import { getPaidFileLink, requestPaidFilePurchase, hasPaidFileEntitlement } from '../paid-files/repository.js';

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


async function showForceSubStatus(ctx, telegram, pool, userId, logger) {
  const result = await checkForceSubscription(telegram, pool, userId);
  await logForceSubEvent(pool, logger, result.passed ? 'force_sub_verified' : 'force_sub_blocked', userId, result);
  if (result.passed) {
    await ctx.reply('Subscription check passed. All required channels are joined.');
    return result;
  }
  const labels = result.missing.slice(0, 20).map((channel) => `• ${channel.title ?? channel.telegram_chat_id}${channel.checkStatus === 'check_failed' ? ' (verification temporarily unavailable)' : ''}`).join('\n');
  await ctx.reply('Join the required channels first:\n\n' + labels + '\n\nThen tap Verify.', getMissingSubscriptionMarkup(result.missing));
  return result;
}

export function createDeliveryBot(config, logger, pool, token = config.deliveryBotToken) {
  if (!token) return null;
  const bot = new Telegraf(token);
  let worker;
  let autoDeleteWorker;
  let identity = 'delivery-bot';

  bot.use(async (ctx, next) => {
    if (isAdmin(ctx.from?.id, config.adminIds)) return next();
    const command = ctx.message?.text?.trim().split(/\s+/)[0]?.split('@')[0] ?? '';
    const allowed = ['/start', '/verify', '/get', '/paid', '/batch', '/batch_get', '/checkpoint_status', '/access_status'].includes(command) || ctx.callbackQuery?.data === 'fs_verify';
    if (allowed) return next();
    if (ctx.chat?.type === 'private') await ctx.reply('This bot is currently preparing its file access system.');
  });

  bot.command('start', async (ctx) => {
    await upsertTelegramUser(pool, ctx.from);
    if (isAdmin(ctx.from.id, config.adminIds)) {
      await ctx.reply('FileStore Delivery Bot (admin test mode)\n\n/get <file_code> — queue a delivery\n/delivery_status — queue status\n/delivery_test — test storage access\n/verify — check subscriptions\n/checkpoint_status — checkpoint state\n/access_status — access and premium status');
    } else {
      await ctx.reply('Welcome to FileStore. Use /verify to check required channel subscriptions. Free delivery is available when access checks pass. Use /get <file_code> to request a file.');
    }
  });

  bot.command('paid', async (ctx) => {
    const linkCode = ctx.message?.text?.trim().split(/\s+/).slice(1)[0] ?? '';
    if (!linkCode) return ctx.reply('Usage: /paid <paid_link_code>');
    try {
      await upsertTelegramUser(pool, ctx.from);
      const forceSub = await checkForceSubscription(ctx.telegram, pool, ctx.from.id);
      await logForceSubEvent(pool, logger, forceSub.passed ? 'force_sub_verified' : 'force_sub_blocked', ctx.from.id, forceSub);
      if (!forceSub.passed) {
        const labels = forceSub.missing.slice(0, 20).map((channel) => `• ${channel.title ?? channel.telegram_chat_id}`).join('\n');
        return ctx.reply('Join required channels first:\n\n' + labels + '\n\nThen use /verify and retry /paid.', getMissingSubscriptionMarkup(forceSub.missing));
      }
      const link = await getPaidFileLink(pool, linkCode);
      if (!link || !link.is_active) return ctx.reply('Paid link is invalid, expired, or disabled.');
      const purchase = await requestPaidFilePurchase(pool, linkCode, ctx.from);
      if (purchase.alreadyPaid) return ctx.reply('You already unlocked this file. Use /get ' + link.file_code + ' to request delivery.');
      await ctx.reply('Paid file purchase request recorded.\n\nFile: ' + link.file_name + '\nPrice: ' + (Number(link.price_minor) / 100).toFixed(2) + ' ' + link.currency + '\n\nPayments are not connected yet. Contact the bot administrator with your Telegram ID: ' + ctx.from.id + '. Once payment is manually verified, use /get ' + link.file_code + '.');
    } catch (error) {
      logger.error({ error: error.message, userId: ctx.from.id }, 'Paid file request failed');
      await ctx.reply('Could not create purchase request. Please try again later.');
    }
  });


  bot.command('batch', async (ctx) => {
    const code = ctx.message?.text?.trim().split(/\s+/).slice(1)[0] ?? '';
    if (!code) return ctx.reply('Usage: /batch <batch_link_code>');
    try {
      await upsertTelegramUser(pool, ctx.from);
      const forceSub = await checkForceSubscription(ctx.telegram, pool, ctx.from.id);
      await logForceSubEvent(pool, logger, forceSub.passed ? 'force_sub_verified' : 'force_sub_blocked', ctx.from.id, forceSub);
      if (!forceSub.passed) {
        const labels = forceSub.missing.slice(0, 20).map((channel) => `• ${channel.title ?? channel.telegram_chat_id}`).join('\n');
        return ctx.reply('Join required channels first:\n\n' + labels + '\n\nThen verify and retry /batch.', getMissingSubscriptionMarkup(forceSub.missing));
      }
      const batch = await getPaidBatch(pool, code);
      if (!batch || !batch.is_active) return ctx.reply('Batch link invalid, expired, or disabled.');
      const result = await requestPaidBatchPurchase(pool, code, ctx.from);
      if (result.alreadyPaid) return ctx.reply('You have already unlocked this batch. Use /batch_get ' + code + ' to deliver all files.');
      return ctx.reply('Batch purchase request recorded.\\n\\n' + result.title + '\\nFiles: ' + batch.item_count + '\\nPrice: ' + (Number(result.priceMinor) / 100).toFixed(2) + ' ' + result.currency + '\\n\\nPayment is not automatic yet. Contact admin with your Telegram ID: ' + ctx.from.id + '.');
    } catch (error) {
      logger.error({ userId: ctx.from.id, error: error.message }, 'Batch purchase request failed');
      return ctx.reply('Could not create batch purchase request.');
    }
  });

  bot.command('batch_get', async (ctx) => {
    const code = ctx.message?.text?.trim().split(/\s+/).slice(1)[0] ?? '';
    if (!code) return ctx.reply('Usage: /batch_get <batch_link_code>');
    try {
      await upsertTelegramUser(pool, ctx.from);
      const forceSub = await checkForceSubscription(ctx.telegram, pool, ctx.from.id);
      await logForceSubEvent(pool, logger, forceSub.passed ? 'force_sub_verified' : 'force_sub_blocked', ctx.from.id, forceSub);
      if (!forceSub.passed) {
        const labels = forceSub.missing.slice(0, 20).map((channel) => `• ${channel.title ?? channel.telegram_chat_id}`).join("\\n");
        return ctx.reply('Join required channels first:\\n\\n' + labels + '\\n\\nVerify before requesting delivery.', getMissingSubscriptionMarkup(forceSub.missing));
      }
      const batch = await getPaidBatch(pool, code);
      if (!batch || !batch.is_active) return ctx.reply('Batch link invalid, expired, or disabled.');
      const items = await getBatchItems(pool, code);
      if (!items.length) return ctx.reply('This batch has no files.');
      for (const item of items) {
        const entitled = await hasPaidFileEntitlement(pool, ctx.from.id, item.id);
        if (!entitled) return ctx.reply('Batch is not unlocked for your account. Request it using /batch ' + code + ' and complete payment first.');
        if (!item.telegram_message_id || !item.storage_chat_id || !item.storage_channel_enabled) return ctx.reply('One or more files have no usable storage message. Admin needs to repair the batch storage.');
      }
      const jobId = await createBatchDeliveryJob(pool, ctx.from.id, items.map((item) => item.id), ctx.from.id);
      return ctx.reply('Batch delivery queued. Files will be delivered sequentially.\\nJob ID: ' + jobId + '\\nCollection: ' + batch.title + '\\nFiles: ' + items.length);
    } catch (error) {
      logger.error({ userId: ctx.from.id, error: error.message }, 'Batch delivery request failed');
      return ctx.reply('Could not queue this batch.');
    }
  });

  bot.command('verify', async (ctx) => {
    try {
      await upsertTelegramUser(pool, ctx.from);
      await showForceSubStatus(ctx, ctx.telegram, pool, ctx.from.id, logger);
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
      const file = await getIndexedFile(pool, code);
      if (!file) return ctx.reply('File code not found.');
      if (!isAdmin(ctx.from.id, config.adminIds)) {
        await upsertTelegramUser(pool, ctx.from);
        const forceSub = await checkForceSubscription(ctx.telegram, pool, ctx.from.id);
        await logForceSubEvent(pool, logger, forceSub.passed ? 'force_sub_verified' : 'force_sub_blocked', ctx.from.id, forceSub);
        if (!forceSub.passed) {
          const labels = forceSub.missing.slice(0, 20).map((channel) => `• ${channel.title ?? channel.telegram_chat_id}`).join('\n');
          return ctx.reply('Subscribe to the required channels before requesting files:\n\n' + labels + '\n\nThen tap Verify.', getMissingSubscriptionMarkup(forceSub.missing));
        }
        const paidEntitled = await hasPaidFileEntitlement(pool, ctx.from.id, file.id);
        const paidLink = await pool.query('SELECT EXISTS (SELECT 1 FROM paid_file_links WHERE file_id = $1 AND is_enabled = TRUE AND (expires_at IS NULL OR expires_at > NOW())) OR EXISTS (SELECT 1 FROM paid_batch_items i JOIN paid_batch_links b ON b.id = i.batch_link_id WHERE i.file_id = $1 AND b.is_enabled = TRUE AND (b.expires_at IS NULL OR b.expires_at > NOW()) AS locked', [file.id]);
        const paidLocked = paidLink.rows[0]?.locked === true;
        const access = await evaluateAccess(pool, { userId: ctx.from.id, type: (paidEntitled || paidLocked) ? 'paid_file' : 'free_file', resourceId: file.id }, forceSub);
        if (!access.allowed) {
          if (access.reason === 'purchase_required') return ctx.reply('This file is locked. Use /paid <link_code> to request purchase.');
          if (access.reason === 'checkpoint_required') return ctx.reply('Checkpoint required before free delivery. Provider: ' + (access.provider?.name ?? 'unknown') + '. Verification link integration is not yet available, so access remains locked.');
          if (access.reason === 'checkpoint_provider_unavailable' || access.reason === 'checkpoint_verification_unavailable') return ctx.reply('Checkpoint verification is unavailable right now. Access remains locked; please try later.');
          return ctx.reply('Access check failed (' + access.reason + '). Please try again later.');
        }
        if (!file.telegram_message_id || !file.storage_chat_id || !file.storage_channel_enabled) return ctx.reply('This file currently has no usable storage message.');
        const jobId = await createSingleDeliveryJob(pool, ctx.from.id, file.id, ctx.from.id);
        return ctx.reply((paidEntitled ? 'Paid access verified.' : 'Access verified.') + ' Delivery queued.\nJob ID: ' + jobId + '\nFile: ' + file.file_name);
      }
      if (!file.telegram_message_id || !file.storage_chat_id || !file.storage_channel_enabled) return ctx.reply('This file has no usable message in an enabled storage channel.');
      const jobId = await createSingleDeliveryJob(pool, ctx.from.id, file.id, ctx.from.id);
      await ctx.reply(`Delivery queued.\nJob ID: ${jobId}\nFile: ${file.file_name}`);
    } catch (error) {
      logger.error({ error: error.message, userId: ctx.from.id }, 'Delivery request creation failed');
      await ctx.reply('Could not queue this delivery.');
    }
  });

  bot.command('checkpoint_status', async (ctx) => {
    try {
      await upsertTelegramUser(pool, ctx.from);
      const setting = await pool.query("SELECT value FROM app_settings WHERE key = 'checkpoint_enabled' LIMIT 1");
      if (!setting.rowCount || setting.rows[0].value !== true) return ctx.reply('Checkpoint enforcement is OFF.');
      const requirement = await getCheckpointRequirement(pool, ctx.from.id);
      if (requirement.reason === 'checkpoint_active') return ctx.reply('Checkpoint active until: ' + new Date(requirement.expiresAt).toLocaleString());
      if (requirement.reason === 'no_active_providers') return ctx.reply('No active checkpoint providers. Checkpoints are not currently required.');
      if (requirement.blocked) return ctx.reply('Checkpoint provider ' + (requirement.provider?.name ?? 'unknown') + ' is configured but has no trusted verification adapter. Free access remains locked when checkpoints are enabled.');
      return ctx.reply('Checkpoint required: provider ' + requirement.provider.name + ' (' + requirement.step + '/' + requirement.total + '). Verification adapter is not yet connected, so a valid checkpoint cannot be completed.');
    } catch (error) {
      logger.warn({ userId: ctx.from.id, error: error.message }, 'Checkpoint status failed');
      return ctx.reply('Checkpoint status unavailable. Try again later.');
    }
  });

  bot.command('access_status', async (ctx) => {
    try {
      await upsertTelegramUser(pool, ctx.from);
      const forceSub = await checkForceSubscription(ctx.telegram, pool, ctx.from.id);
      const premium = await pool.query(`SELECT p.name, m.expires_at FROM premium_memberships m LEFT JOIN premium_plans p ON p.id = m.plan_id
        WHERE m.user_telegram_id = $1 AND m.status = 'active' AND m.starts_at <= NOW() AND (m.expires_at IS NULL OR m.expires_at > NOW())
        ORDER BY m.expires_at DESC NULLS FIRST LIMIT 1`, [ctx.from.id]);
      const checkpointSetting = await pool.query("SELECT value FROM app_settings WHERE key = 'checkpoint_enabled' LIMIT 1");
      const checkpointEnabled = checkpointSetting.rowCount && checkpointSetting.rows[0].value === true;
      const checkpoint = checkpointEnabled ? await getCheckpointRequirement(pool, ctx.from.id) : { reason: 'checkpoint_disabled' };
      const lines = ['Access status', '', 'Force-sub: ' + (forceSub.passed ? 'Passed' : 'Required (' + forceSub.missing.length + ' channel(s))'), 'Premium: ' + (premium.rowCount ? 'Active' + (premium.rows[0].expires_at ? ' until ' + new Date(premium.rows[0].expires_at).toLocaleString() : ' (permanent)') : 'Inactive')];
      lines.push('Checkpoint: ' + (checkpoint.reason === 'checkpoint_disabled' ? 'Off' : checkpoint.reason === 'checkpoint_active' ? 'Active until ' + new Date(checkpoint.expiresAt).toLocaleString() : checkpoint.reason === 'no_active_providers' ? 'No provider available' : checkpoint.blocked ? 'Unavailable (provider verification not connected)' : 'Required, verification unavailable'));
      return ctx.reply(lines.join('\n'));
    } catch (error) {
      logger.warn({ userId: ctx.from.id, error: error.message }, 'Access status failed');
      return ctx.reply('Access status unavailable. Try again later.');
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
      autoDeleteWorker = createAutoDeleteWorker(bot, pool, logger, identity);
      autoDeleteWorker.start();
    },
    stopWorker() {
      worker?.stop();
      autoDeleteWorker?.stop();
      worker = undefined;
      autoDeleteWorker = undefined;
    },
  };
}
