import { getAutoDeleteMinutes, setAutoDeleteMinutes, listFailedScheduledDeletions } from './auto-delete-repository.js';
import { getCommandArgs } from '../bot/telegram-utils.js';

export function registerAutoDeleteCommands(bot, pool, logger) {
  bot.command('auto_delete', async (ctx) => {
    const raw = getCommandArgs(ctx)[0];
    if (raw === undefined || raw === '') {
      const current = await getAutoDeleteMinutes(pool);
      return ctx.reply(
        current
          ? `🧹 Auto-Delete Policy\n━━━━━━━━━━━━━━━━━━\n🟢 Status: ON (${current} minute(s))\n💡 Change with /admin auto_delete <minutes> or disable via /admin auto_delete_off.`
          : '🧹 Auto-Delete Policy\n━━━━━━━━━━━━━━━━━━\n⚪ Status: OFF\n💡 Enable with /admin auto_delete <minutes> (1–10080).',
      );
    }
    const minutes = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080) {
      return ctx.reply('ℹ️ Usage: /admin auto_delete <minutes> (1–10080)');
    }
    try {
      await setAutoDeleteMinutes(pool, minutes, ctx.from.id);
      await ctx.reply(`✅ Auto-delete enabled! Delivered messages will be deleted after ${minutes} minute(s).`);
    } catch (error) {
      logger.error({ error: error.message }, 'Auto-delete setting update failed');
      await ctx.reply('❌ Could not update auto-delete setting.');
    }
  });
  bot.command('auto_delete_failed', async (ctx) => {
    try {
      const rows = await listFailedScheduledDeletions(pool, 15);
      if (!rows.length) return ctx.reply('✅ No terminal auto-delete failures.');
      const lines = rows.map((row) => `⚠️ #${row.id} · ${row.delivery_bot_identity} · chat ${row.chat_id} · msg ${row.message_id}\n🔁 Attempts: ${row.attempt_count} · 📅 ${new Date(row.delete_at).toISOString()}\n💬 ${String(row.last_error ?? 'unknown error').slice(0, 180)}`);
      return ctx.reply('⚠️ Failed Auto-Delete Jobs (latest 15)\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed auto-delete listing failed');
      return ctx.reply('❌ Could not list failed auto-delete jobs.');
    }
  });
  bot.command('auto_delete_off', async (ctx) => {
    try {
      await setAutoDeleteMinutes(pool, 0, ctx.from.id);
      await ctx.reply('⚪ Auto-delete disabled. Already scheduled messages will still be deleted at their due time.');
    } catch (error) {
      logger.error({ error: error.message }, 'Auto-delete disable failed');
      await ctx.reply('❌ Could not disable auto-delete.');
    }
  });
}
