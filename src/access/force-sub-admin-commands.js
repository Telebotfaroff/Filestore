import { isAdmin } from '../bot/admin-guard.js';
import { parseStorageIdentifier } from '../storage/identifier.js';
import { getCommandArgs, validateForceSubChannel } from '../bot/telegram-utils.js';
import {
  getForceSubGlobal,
  listForceSubChannels,
  removeForceSubChannel,
  saveForceSubChannel,
  setForceSubEnabled,
  setForceSubGlobal,
} from './force-sub-repository.js';

function parseChannelId(value) {
  const parsed = parseStorageIdentifier(value);
  if (typeof parsed !== 'number') throw new Error('Use the numeric channel ID for management commands.');
  return parsed;
}

function getCallerScope(ctx, config) {
  const isOwnerAdmin = !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
  return {
    isOwnerAdmin,
    ownerId: isOwnerAdmin ? null : Number(ctx.from?.id),
  };
}

export function registerForceSubAdminCommands(bot, pool, logger, config = null) {
  bot.command('force_sub', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const globalEnabled = await getForceSubGlobal(pool, ownerId);
      const channels = await listForceSubChannels(pool, ownerId);
      if (!channels.length) return ctx.reply(`🔒 Force-Subscription: ${globalEnabled ? '🟢 ON' : '⚪ OFF'}\n━━━━━━━━━━━━━━━━━━\n📭 No channels configured yet.\n💡 Add one with /force_sub_add <channel_id or @username> <https_join_link>.`);
      const rows = channels.map((c) => `${c.is_enabled ? '🟢 ON' : '⚪ OFF'} · 📢 ${c.title ?? c.telegram_chat_id}\n🆔 ID: ${c.telegram_chat_id}\n🔗 Join: ${c.join_url}\n🧪 Test: ${c.last_test_status}`);
      await ctx.reply(`🔒 Force-Subscription: ${globalEnabled ? '🟢 ON' : '⚪ OFF'}\n━━━━━━━━━━━━━━━━━━\n` + rows.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Force-subscription list failed');
      await ctx.reply('❌ Could not list force-subscription channels.');
    }
  });

  bot.command('force_sub_add', async (ctx) => {
    const [channelInput, joinUrl] = getCommandArgs(ctx);
    if (!channelInput || !joinUrl) return ctx.reply('ℹ️ Usage: /force_sub_add <channel_id or @username> <https_join_link>');
    try {
      const { isOwnerAdmin, ownerId } = getCallerScope(ctx, config);
      const parsedUrl = new URL(joinUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('Join link must use HTTPS.');
      const chat = await validateForceSubChannel(ctx, parseStorageIdentifier(channelInput), {
        requireUserAdmin: !isOwnerAdmin,
      });
      const saved = await saveForceSubChannel(pool, chat, parsedUrl.toString(), ctx.from.id, ownerId);
      await ctx.reply(`✅ Force-Sub Channel Saved!\n━━━━━━━━━━━━━━━━━━\n📢 ${saved.title ?? 'Channel'}\n🆔 ID: ${saved.telegram_chat_id}`);
    } catch (error) {
      logger.warn({ error: error.message }, 'Force-sub channel add rejected');
      await ctx.reply('❌ Could not add force-sub channel: ' + error.message);
    }
  });

  bot.command('force_sub_test', async (ctx) => {
    const { isOwnerAdmin, ownerId } = getCallerScope(ctx, config);
    const ownerClause = ownerId === null ? 'owner_telegram_id IS NULL' : 'owner_telegram_id = $2';
    const failClause = ownerId === null ? 'owner_telegram_id IS NULL' : 'owner_telegram_id = $3';
    try {
      const id = parseChannelId(getCommandArgs(ctx)[0] ?? '');
      const existing = await pool.query(
        `SELECT id FROM force_sub_channels WHERE telegram_chat_id = $1 AND ${ownerClause} LIMIT 1`,
        ownerId === null ? [id] : [id, ownerId],
      );
      if (!existing.rowCount) return ctx.reply('❌ Force-sub channel not found in your scope.');
      const chat = await validateForceSubChannel(ctx, id, { requireUserAdmin: !isOwnerAdmin });
      await pool.query(
        `UPDATE force_sub_channels SET last_test_status = 'ok', last_test_error = NULL, updated_at = NOW() WHERE telegram_chat_id = $1 AND ${ownerClause}`,
        ownerId === null ? [id] : [id, ownerId],
      );
      await ctx.reply(`✅ Force-Sub Permission Test Passed!\n━━━━━━━━━━━━━━━━━━\n📢 ${chat.title ?? chat.id}\n🛡️ Main Bot is administrator.`);
    } catch (error) {
      const idText = getCommandArgs(ctx)[0];
      try {
        const id = parseChannelId(idText ?? '');
        await pool.query(
          `UPDATE force_sub_channels SET last_test_status = 'failed', last_test_error = $2, updated_at = NOW() WHERE telegram_chat_id = $1 AND ${failClause}`,
          ownerId === null ? [id, error.message.slice(0, 500)] : [id, error.message.slice(0, 500), ownerId],
        );
      } catch {}
      await ctx.reply('❌ Force-sub test failed: ' + error.message);
    }
  });

  bot.command('force_sub_enable', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = parseChannelId(getCommandArgs(ctx)[0] ?? '');
      if (!await setForceSubEnabled(pool, id, true, ownerId)) return ctx.reply('❌ Channel not found.');
      await ctx.reply('🟢 Force-sub channel enabled.');
    } catch { await ctx.reply('ℹ️ Usage: /force_sub_enable <channel_id>'); }
  });

  bot.command('force_sub_disable', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = parseChannelId(getCommandArgs(ctx)[0] ?? '');
      if (!await setForceSubEnabled(pool, id, false, ownerId)) return ctx.reply('❌ Channel not found.');
      await ctx.reply('⚪ Force-sub channel disabled.');
    } catch { await ctx.reply('ℹ️ Usage: /force_sub_disable <channel_id>'); }
  });

  bot.command('force_sub_remove', async (ctx) => {
    try {
      const { ownerId } = getCallerScope(ctx, config);
      const id = parseChannelId(getCommandArgs(ctx)[0] ?? '');
      if (!await removeForceSubChannel(pool, id, ownerId)) return ctx.reply('❌ Channel not found.');
      await ctx.reply('🗑️ Force-sub channel removed.');
    } catch { await ctx.reply('ℹ️ Usage: /force_sub_remove <channel_id>'); }
  });

  bot.command('force_sub_global_on', async (ctx) => {
    try {
      const { isOwnerAdmin, ownerId } = getCallerScope(ctx, config);
      await setForceSubGlobal(pool, true, ctx.from.id, ownerId);
      await ctx.reply(isOwnerAdmin ? '🟢 Global force-subscription enabled!' : '🟢 Force-subscription enabled for your links!');
    } catch (error) {
      logger.error({ error: error.message }, 'Force-sub global enable failed');
      await ctx.reply('❌ Could not enable force-subscription.');
    }
  });

  bot.command('force_sub_global_off', async (ctx) => {
    try {
      const { isOwnerAdmin, ownerId } = getCallerScope(ctx, config);
      await setForceSubGlobal(pool, false, ctx.from.id, ownerId);
      await ctx.reply(isOwnerAdmin ? '⚪ Global force-subscription disabled.' : '⚪ Force-subscription disabled for your links.');
    } catch (error) {
      logger.error({ error: error.message }, 'Force-sub global disable failed');
      await ctx.reply('❌ Could not disable force-subscription.');
    }
  });
}

