import { isAdmin } from '../bot/admin-guard.js';
import { retryFailedDeliveryJob, getRecentDeliveryJobs } from './repository.js';
import { getCommandArgs } from '../bot/telegram-utils.js';
import { parsePositiveInt } from '../utils/validation.js';

function getRecordId(ctx) {
  return parsePositiveInt(getCommandArgs(ctx)[0], 'Bot record ID');
}

function getCallerScope(ctx, config) {
  const isOwnerAdmin = !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
  return {
    isOwnerAdmin,
    ownerId: isOwnerAdmin ? null : Number(ctx.from?.id),
  };
}

export function registerDeliveryBotManagerCommands(bot, manager, logger, pool, config = null, adminBot = bot) {
  const ownerCmdBot = adminBot ?? bot;
  ownerCmdBot.command('delivery_jobs', async (ctx) => {
    const { isOwnerAdmin } = getCallerScope(ctx, config);
    if (!isOwnerAdmin) return ctx.reply('🔒 This command is restricted to the platform owner.');
    try {
      const jobs = await getRecentDeliveryJobs(pool, 10);
      if (!jobs.length) return ctx.reply('📭 No delivery jobs found yet.');
      const lines = jobs.map((job) =>
        `🧾 #${job.id} · ${String(job.status).toUpperCase()} · ${job.job_type}\n👤 Requester: ${job.requester_telegram_id}\n📦 Files: ${job.delivered_count}/${job.item_count} delivered · ❌ ${job.failed_count} failed · ⚠️ ${job.uncertain_count} uncertain${job.last_error ? '\n💬 Error: ' + String(job.last_error).slice(0, 180) : ''}`,
      );
      return ctx.reply('🚀 Recent Delivery Jobs (latest 10)\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n') + '\n\n🔁 Retry a failed job: /admin delivery_retry <job_id>');
    } catch (error) {
      logger.error({ error: error.message }, 'Recent delivery jobs query failed');
      return ctx.reply('❌ Could not load recent delivery jobs.');
    }
  });

  ownerCmdBot.command('delivery_retry', async (ctx) => {
    const { isOwnerAdmin } = getCallerScope(ctx, config);
    if (!isOwnerAdmin) return ctx.reply('🔒 This command is restricted to the platform owner.');
    let jobId;
    try { jobId = parsePositiveInt(getCommandArgs(ctx)[0], 'Job ID'); }
    catch { return ctx.reply('ℹ️ Usage: /admin delivery_retry <failed_job_id>'); }
    try {
      const result = await retryFailedDeliveryJob(pool, jobId);
      if (!result.ok) {
        const messages = {
          not_retryable: '⚠️ Job not found or not in failed state. Only failed jobs can be retried.',
          unsafe_state: '🛡️ Retry blocked: this job has an uncertain or processing item. Review it manually to avoid duplicate delivery.',
          no_failed_items: 'ℹ️ No failed items are available to retry.',
        };
        return ctx.reply(messages[result.reason] ?? '❌ Retry could not be applied.');
      }
      return ctx.reply(`🔁 Delivery job requeued!\n📦 Failed items queued: ${result.retriedItems}\n✅ Previously delivered batch items remain delivered.`);
    } catch (error) {
      logger.error({ jobId, error: error.message }, 'Delivery job retry failed');
      return ctx.reply('❌ Retry failed due to a database error.');
    }
  });

  bot.command('delivery_bots', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const rows = await manager.list(ownerId);
      if (!rows.length) return ctx.reply('🤖 No Delivery Bots registered yet.\n💡 Add one with /delivery_bot_add <token>.');
      const text = rows.map((row) => `${row.role === 'primary' ? '⭐' : '📦'} #${row.id} · @${row.username}\n🆔 Telegram ID: ${row.telegram_bot_id}\n🏷 Role: ${row.role} · 🔢 Priority: ${row.priority}\n⚡ Enabled: ${row.is_enabled ? '🟢 Yes' : '⚪ No'} · Runtime: ${row.runtime_status}`).join('\n\n');
      await ctx.reply('🤖 Delivery Bot Manager\n━━━━━━━━━━━━━━━━━━\n' + text);
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery Bot list failed');
      await ctx.reply('❌ Could not load Delivery Bot records.');
    }
  });

  bot.command('delivery_bot_add', async (ctx) => {
    const token = getCommandArgs(ctx).join('').trim();
    if (!token) return ctx.reply('ℹ️ Send /delivery_bot_add followed by the BotFather token.\n🔒 Your token message will be deleted immediately.');
    try { await ctx.deleteMessage(); } catch {}
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const record = await manager.addToken(token, ctx.from.id, ownerId);
      await ctx.reply(`✅ Delivery Bot Added!\n━━━━━━━━━━━━━━━━━━\n🆔 Record ID: ${record.id}\n🤖 Bot: @${record.username}\n🏷 Role: ${record.role}\n⚡ Runtime: ${record.runtime_status}`);
    } catch (error) {
      logger.warn({ error: error.message, adminId: ctx.from.id }, 'Delivery Bot add rejected');
      await ctx.reply('❌ Could not add Delivery Bot: ' + error.message);
    }
  });

  bot.command('delivery_bot_pause', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = getRecordId(ctx);
      if (!await manager.pause(id, ownerId)) return ctx.reply('❌ Bot record not found.');
      await ctx.reply('⏸ Delivery Bot worker paused.');
    } catch { await ctx.reply('ℹ️ Usage: /delivery_bot_pause <record_id>'); }
  });

  bot.command('delivery_bot_resume', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = getRecordId(ctx);
      if (!await manager.resume(id, ownerId)) return ctx.reply('❌ Bot could not be resumed. Check its token and /delivery_bots.');
      await ctx.reply('▶️ Delivery Bot resumed.');
    } catch { await ctx.reply('ℹ️ Usage: /delivery_bot_resume <record_id>'); }
  });

  bot.command('delivery_bot_restart', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = getRecordId(ctx);
      if (!await manager.restart(id, ownerId)) return ctx.reply('❌ Bot restart failed. Check /delivery_bots.');
      await ctx.reply('🔄 Delivery Bot runtime restarted.');
    } catch { await ctx.reply('ℹ️ Usage: /delivery_bot_restart <record_id>'); }
  });

  bot.command('delivery_bot_primary', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = getRecordId(ctx);
      if (!await manager.promotePrimary(id, ownerId)) return ctx.reply('⚠️ Could not make this bot primary. Ensure it is enabled and healthy.');
      await ctx.reply('⭐ Primary Delivery Bot updated!');
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery Bot primary switch failed');
      await ctx.reply('❌ Primary Delivery Bot change failed.');
    }
  });

  bot.command('delivery_bot_remove', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = getRecordId(ctx);
      if (!await manager.remove(id, ownerId)) return ctx.reply('❌ Bot record not found.');
      await ctx.reply('🗑️ Delivery Bot stopped, removed, and its encrypted token deleted. Historical delivery logs remain.');
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery Bot removal failed');
      await ctx.reply('❌ Delivery Bot removal failed.');
    }
  });

  bot.command('delivery_bot_priority', async (ctx) => {
    const [idRaw, priorityRaw] = getCommandArgs(ctx);
    const id = Number(idRaw);
    const priority = Number(priorityRaw);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(priority) || priority < 1 || priority > 100000) {
      return ctx.reply('ℹ️ Usage: /delivery_bot_priority <record_id> <1-100000>');
    }
    try {
      const { ownerId } = getCallerScope(ctx, config);
      if (!await manager.setPriority(id, priority, ownerId)) return ctx.reply('❌ Bot record not found.');
      await ctx.reply('✅ Delivery Bot priority updated! Lower numbers are preferred for backup selection.');
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery Bot priority update failed');
      await ctx.reply('❌ Priority update failed.');
    }
  });

  bot.command('delivery_bot_test', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = getRecordId(ctx);
      const result = await manager.test(id, ownerId);
      const checks = result.checks.map((check) => `${check.status === 'ok' || check.status === 'force_sub_admin_ok' ? '🟢' : '🔴'} ${check.status.toUpperCase()} · ${String(check.channel).slice(0, 100)}${check.message ? ' · ' + check.message : ''}`).join('\n');
      await ctx.reply(`🧪 Delivery Bot Health Test\n━━━━━━━━━━━━━━━━━━\n✅ Bot connection: OK (@${result.bot.username})\n\n🗄 Storage Channel Access:\n${checks || '⚪ No enabled channels configured'}`);
    } catch (error) {
      logger.warn({ error: error.message }, 'Delivery Bot test failed');
      await ctx.reply('❌ Delivery Bot test failed: ' + error.message);
    }
  });
}

