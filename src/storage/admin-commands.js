import { isAdmin } from '../bot/admin-guard.js';
import { parseStorageIdentifier } from './identifier.js';
import { getCommandArgText, validateStorageChannel } from '../bot/telegram-utils.js';
import {
  listStorageChannels,
  saveStorageChannel,
  updateStorageTest,
  setStorageEnabled,
  setPrimaryStorageChannel,
  removeStorageChannel,
} from './repository.js';

function getNumericChannelId(raw) {
  const id = parseStorageIdentifier(raw);
  if (typeof id !== 'number') throw new Error('Use the numeric channel ID for this command.');
  return id;
}

export function registerStorageAdminCommands(bot, pool, logger, config = null) {
  const getScope = (ctx) => {
    const admin = !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
    return { admin, ownerId: admin ? null : Number(ctx.from.id) };
  };

  bot.command('storage', async (ctx) => {
    try {
      const { ownerId } = getScope(ctx);
      const rows = await listStorageChannels(pool, ownerId);
      if (!rows.length) return ctx.reply('🗄 No storage channels configured yet.\n💡 Make this Main Bot an administrator in your channel (with Post Messages permission), then run /storage_add <channel_id or @username> — or add via Control Center and forward any channel post.');
      const lines = rows.map((row) => {
        const state = row.is_enabled ? '🟢 Enabled' : '⚪ Disabled';
        const primary = row.role === 'primary' ? '⭐ PRIMARY' : '📦 Backup';
        return `${primary} · ${state}\n📢 ${row.title ?? 'Untitled channel'}\n🆔 ID: ${row.telegram_chat_id}\n🔢 Priority: ${row.priority} · 🧪 Test: ${row.last_test_status}`;
      });
      await ctx.reply('🗄 Storage Channel Manager\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Storage list failed');
      await ctx.reply('❌ Could not load storage channels. Check the database and logs.');
    }
  });

  bot.command('storage_add', async (ctx) => {
    try {
      const input = getCommandArgText(ctx);
      if (!input) {
        return ctx.reply(
          'ℹ️ Usage: /storage_add <-100channel_id, @username, or t.me link>\n\n⚠️ First add this Main Bot as an administrator in your channel (with Post Messages permission). You can also add a channel in /start → My Storage Channel by forwarding any post from the channel.',
        );
      }
      const { admin, ownerId } = getScope(ctx);
      const parsed = parseStorageIdentifier(input);
      const chat = await validateStorageChannel(ctx, parsed, { requireUserAdmin: !admin });
      const saved = await saveStorageChannel(pool, chat, ctx.from.id, ownerId);
      await ctx.reply(`✅ Storage Channel Saved & Tested!\n━━━━━━━━━━━━━━━━━━\n📢 ${saved.title ?? 'Channel'}\n🆔 ID: ${saved.telegram_chat_id}\n⚡ Status: ${saved.is_enabled ? '🟢 Enabled' : '⚪ Disabled'}`);
    } catch (error) {
      logger.warn({ error: error.message }, 'Storage channel add rejected');
      await ctx.reply('❌ Could not add channel:\n' + error.message);
    }
  });

  bot.command('storage_test', async (ctx) => {
    let channelId;
    const { admin, ownerId } = getScope(ctx);
    try {
      channelId = getNumericChannelId(getCommandArgText(ctx));
      if (!admin) {
        const owned = await listStorageChannels(pool, ownerId);
        if (!owned.some((c) => Number(c.telegram_chat_id) === Number(channelId))) {
          throw new Error('Channel not found in your storage channels.');
        }
      }
      const chat = await validateStorageChannel(ctx, channelId, { requireUserAdmin: !admin });
      await updateStorageTest(pool, channelId, 'ok', null, ownerId);
      await ctx.reply(`✅ Storage Permission Test Passed!\n━━━━━━━━━━━━━━━━━━\n📢 ${chat.title ?? 'Channel'}\n🆔 ID: ${chat.id}\n🛡️ Bot is administrator and can post.`);
    } catch (error) {
      if (channelId !== undefined) {
        try { await updateStorageTest(pool, channelId, 'failed', error.message, ownerId); } catch {}
      }
      logger.warn({ channelId, error: error.message }, 'Storage permission test failed');
      await ctx.reply('❌ Storage test failed: ' + error.message);
    }
  });

  bot.command('storage_enable', async (ctx) => {
    try {
      const id = getNumericChannelId(getCommandArgText(ctx));
      const { ownerId } = getScope(ctx);
      if (!await setStorageEnabled(pool, id, true, ownerId)) return ctx.reply('❌ Channel not found. Use /storage to see registered channels.');
      await ctx.reply('🟢 Storage channel enabled! Run /storage_test before uploading.');
    } catch {
      await ctx.reply('ℹ️ Usage: /storage_enable <channel_id>');
    }
  });

  bot.command('storage_disable', async (ctx) => {
    try {
      const id = getNumericChannelId(getCommandArgText(ctx));
      const { ownerId } = getScope(ctx);
      if (!await setStorageEnabled(pool, id, false, ownerId)) return ctx.reply('❌ Channel not found.');
      await ctx.reply('⚪ Storage channel disabled. Existing stored files remain indexed.');
    } catch {
      await ctx.reply('ℹ️ Usage: /storage_disable <channel_id>');
    }
  });

  bot.command('storage_primary', async (ctx) => {
    try {
      const id = getNumericChannelId(getCommandArgText(ctx));
      const { ownerId } = getScope(ctx);
      if (!await setPrimaryStorageChannel(pool, id, ownerId)) return ctx.reply('❌ Channel not found.');
      await ctx.reply('⭐ Primary storage channel updated! Other channels are now backups.');
    } catch (error) {
      logger.error({ error: error.message }, 'Primary storage change failed');
      await ctx.reply('❌ Could not change primary storage channel.');
    }
  });

  bot.command('storage_remove', async (ctx) => {
    try {
      const id = getNumericChannelId(getCommandArgText(ctx));
      const { ownerId } = getScope(ctx);
      const result = await removeStorageChannel(pool, id, ownerId);
      if (result.removed) return ctx.reply('🗑️ Storage channel removed from FileStore.');
      if (result.reason === 'referenced') return ctx.reply(`⚠️ Channel contains ${result.references} indexed storage messages, so it was disabled instead of deleted.`);
      return ctx.reply('❌ Channel not found.');
    } catch (error) {
      logger.error({ error: error.message }, 'Storage channel removal failed');
      await ctx.reply('❌ Could not remove storage channel.');
    }
  });
}
