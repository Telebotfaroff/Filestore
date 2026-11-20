import { retryFailedDeliveryJob } from './repository.js';

function getRecordId(ctx) {
  const value = ctx.message?.text?.trim().split(/\s+/).slice(1)[0] ?? '';
  if (!/^\d+$/.test(value)) throw new Error('Usage: command <database_bot_record_id>');
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error('Invalid bot record ID');
  return id;
}

export function registerDeliveryBotManagerCommands(bot, manager, logger, pool) {
  bot.command('delivery_retry', async (ctx) => {
    const raw = ctx.message?.text?.trim().split(/\s+/).slice(1)[0] ?? '';
    if (!/^\d+$/.test(raw)) return ctx.reply('Usage: /delivery_retry <failed_job_id>');
    const jobId = Number(raw);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) return ctx.reply('Invalid delivery job ID.');
    try {
      const result = await retryFailedDeliveryJob(pool, jobId);
      if (!result.ok) {
        const messages = {
          not_retryable: 'Job not found or not in failed state. Only failed jobs can be retried.',
          unsafe_state: 'Retry blocked: this job has an uncertain or processing item. Review it manually to avoid duplicate delivery.',
          no_failed_items: 'No failed items are available to retry.',
        };
        return ctx.reply(messages[result.reason] ?? 'Retry could not be applied.');
      }
      return ctx.reply('Delivery job requeued. Failed items: ' + result.retriedItems + '. Previously delivered batch items remain delivered.');
    } catch (error) {
      logger.error({ jobId, error: error.message }, 'Delivery job retry failed');
      return ctx.reply('Retry failed due to a database error.');
    }
  });

  bot.command('delivery_bots', async (ctx) => {
    try {
      const rows = await manager.list();
      if (!rows.length) return ctx.reply('No Delivery Bots registered. Add one with /delivery_bot_add <token>.');
      const text = rows.map((row) => `Record: ${row.id} · Telegram ID: ${row.telegram_bot_id}\n@${row.username}\nRole: ${row.role} · Priority: ${row.priority}\nEnabled: ${row.is_enabled} · Runtime: ${row.runtime_status}`).join('\n\n');
      await ctx.reply('Delivery Bot Manager\n\n' + text);
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery Bot list failed');
      await ctx.reply('Could not load Delivery Bot records.');
    }
  });

  bot.command('delivery_bot_add', async (ctx) => {
    const token = ctx.message?.text?.trim().split(/\s+/).slice(1).join('').trim() ?? '';
    if (!token) return ctx.reply('Send /delivery_bot_add followed by the BotFather token. The token message will be deleted when possible.');
    try { await ctx.deleteMessage(); } catch {}
    try {
      const record = await manager.addToken(token, ctx.from.id);
      await ctx.reply(`Delivery Bot added.\nRecord ID: ${record.id}\nBot: @${record.username}\nRole: ${record.role}\nRuntime: ${record.runtime_status}`);
    } catch (error) {
      logger.warn({ error: error.message, adminId: ctx.from.id }, 'Delivery Bot add rejected');
      await ctx.reply('Could not add Delivery Bot: ' + error.message);
    }
  });

  bot.command('delivery_bot_pause', async (ctx) => {
    try {
      const id = getRecordId(ctx);
      if (!await manager.pause(id)) return ctx.reply('Bot record not found.');
      await ctx.reply('Delivery Bot worker paused. Its polling runtime remains available for admin commands.');
    } catch (error) { await ctx.reply('Usage: /delivery_bot_pause <record_id>'); }
  });

  bot.command('delivery_bot_resume', async (ctx) => {
    try {
      const id = getRecordId(ctx);
      if (!await manager.resume(id)) return ctx.reply('Bot could not be resumed. Check its token and /delivery_bots.');
      await ctx.reply('Delivery Bot resumed.');
    } catch (error) { await ctx.reply('Usage: /delivery_bot_resume <record_id>'); }
  });

  bot.command('delivery_bot_restart', async (ctx) => {
    try {
      const id = getRecordId(ctx);
      if (!await manager.restart(id)) return ctx.reply('Bot restart failed. Check /delivery_bots.');
      await ctx.reply('Delivery Bot runtime restarted.');
    } catch (error) { await ctx.reply('Usage: /delivery_bot_restart <record_id>'); }
  });

  bot.command('delivery_bot_primary', async (ctx) => {
    try {
      const id = getRecordId(ctx);
      if (!await manager.promotePrimary(id)) return ctx.reply('Could not make this bot primary. Ensure it is enabled and healthy.');
      await ctx.reply('Primary Delivery Bot changed. Other runtimes will not claim delivery jobs.');
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery Bot primary switch failed');
      await ctx.reply('Primary Delivery Bot change failed.');
    }
  });

  bot.command('delivery_bot_remove', async (ctx) => {
    try {
      const id = getRecordId(ctx);
      if (!await manager.remove(id)) return ctx.reply('Bot record not found.');
      await ctx.reply('Delivery Bot stopped, removed, and its encrypted token deleted. Historical delivery logs remain.');
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery Bot removal failed');
      await ctx.reply('Delivery Bot removal failed.');
    }
  });

  bot.command('delivery_bot_priority', async (ctx) => {
    const parts = ctx.message?.text?.trim().split(/\s+/) ?? [];
    const id = Number(parts[1]);
    const priority = Number(parts[2]);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(priority) || priority < 1 || priority > 100000) {
      return ctx.reply('Usage: /delivery_bot_priority <record_id> <1-100000>');
    }
    try {
      if (!await manager.setPriority(id, priority)) return ctx.reply('Bot record not found.');
      await ctx.reply('Delivery Bot priority updated. Lower numbers are preferred for backup selection.');
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery Bot priority update failed');
      await ctx.reply('Priority update failed.');
    }
  });


  bot.command('delivery_bot_test', async (ctx) => {
    try {
      const id = getRecordId(ctx);
      const result = await manager.test(id);
      const checks = result.checks.map((check) => `${check.status.toUpperCase()} · ${String(check.channel).slice(0, 100)}${check.message ? ' · ' + check.message : ''}`).join('\n');
      await ctx.reply(`Bot connection: OK (@${result.bot.username})\n\nStorage channel access:\n${checks || 'No enabled channels configured'}`);
    } catch (error) {
      logger.warn({ error: error.message }, 'Delivery Bot test failed');
      await ctx.reply('Delivery Bot test failed: ' + error.message);
    }
  });
}
