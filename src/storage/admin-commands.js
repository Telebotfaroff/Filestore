import { parseStorageIdentifier } from './identifier.js';
import {
  listStorageChannels,
  saveStorageChannel,
  updateStorageTest,
  setStorageEnabled,
  setPrimaryStorageChannel,
  removeStorageChannel,
} from './repository.js';

function getCommandArgument(ctx) {
  return ctx.message?.text?.trim().split(/\s+/).slice(1).join(' ') ?? '';
}

function getNumericChannelId(raw) {
  const id = parseStorageIdentifier(raw);
  if (typeof id !== 'number') throw new Error('Use the numeric channel ID for this command.');
  return id;
}

async function validateStorageChannel(ctx, channelInput) {
  const chat = await ctx.telegram.getChat(channelInput);
  if (chat.type !== 'channel') throw new Error('Only Telegram channels are supported as storage destinations in this milestone.');
  const botInfo = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(chat.id, botInfo.id);
  if (member.status !== 'administrator') throw new Error('The Main Bot must be an administrator in this channel.');
  if (member.can_post_messages === false) throw new Error('The Main Bot lacks permission to post in this channel.');
  return chat;
}

export function registerStorageAdminCommands(bot, pool, logger) {
  bot.command('storage', async (ctx) => {
    try {
      const rows = await listStorageChannels(pool);
      if (!rows.length) return ctx.reply('No storage channels configured yet. Add one with /storage_add <channel_id or @username.');
      const lines = rows.map((row) => {
        const state = row.is_enabled ? 'Enabled' : 'Disabled';
        const primary = row.role === 'primary' ? ' ⭐ PRIMARY' : ' backup';
        return `${primary} · ${state}\n${row.title ?? 'Untitled channel'}\nID: ${row.telegram_chat_id}\nPriority: ${row.priority}\nPermission test: ${row.last_test_status}`;
      });
      await ctx.reply('Storage Channel Manager\n\n' + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Storage list failed');
      await ctx.reply('Could not load storage channels. Check the database and logs.');
    }
  });

  bot.command('storage_add', async (ctx) => {
    try {
      const input = getCommandArgument(ctx);
      if (!input) return ctx.reply('Usage: /storage_add <channel_id or @username>');
      const parsed = parseStorageIdentifier(input);
      const chat = await validateStorageChannel(ctx, parsed);
      const saved = await saveStorageChannel(pool, chat, ctx.from.id);
      await ctx.reply(`Storage channel saved and permission-tested.\n${saved.title ?? 'Channel'}\nID: ${saved.telegram_chat_id}\nStatus: ${saved.is_enabled ? 'Enabled' : 'Disabled'}`);
    } catch (error) {
      logger.warn({ error: error.message }, 'Storage channel add rejected');
      await ctx.reply('Could not add channel: ' + error.message);
    }
  });

  bot.command('storage_test', async (ctx) => {
    let channelId;
    try {
      channelId = getNumericChannelId(getCommandArgument(ctx));
      const chat = await validateStorageChannel(ctx, channelId);
      await updateStorageTest(pool, channelId, 'ok');
      await ctx.reply(`Storage permission test passed.\n${chat.title ?? 'Channel'}\nID: ${chat.id}\nBot is administrator and can post.`);
    } catch (error) {
      if (channelId !== undefined) {
        try { await updateStorageTest(pool, channelId, 'failed', error.message); } catch {}
      }
      logger.warn({ channelId, error: error.message }, 'Storage permission test failed');
      await ctx.reply('Storage test failed: ' + error.message);
    }
  });

  bot.command('storage_enable', async (ctx) => {
    try {
      const id = getNumericChannelId(getCommandArgument(ctx));
      if (!await setStorageEnabled(pool, id, true)) return ctx.reply('Channel not found. Use /storage to see registered channels.');
      await ctx.reply('Storage channel enabled. Run /storage_test before using it for uploads.');
    } catch (error) {
      await ctx.reply('Usage: /storage_enable <channel_id>');
    }
  });

  bot.command('storage_disable', async (ctx) => {
    try {
      const id = getNumericChannelId(getCommandArgument(ctx));
      if (!await setStorageEnabled(pool, id, false)) return ctx.reply('Channel not found.');
      await ctx.reply('Storage channel disabled. Existing stored files remain indexed.');
    } catch (error) {
      await ctx.reply('Usage: /storage_disable <channel_id>');
    }
  });

  bot.command('storage_primary', async (ctx) => {
    try {
      const id = getNumericChannelId(getCommandArgument(ctx));
      if (!await setPrimaryStorageChannel(pool, id)) return ctx.reply('Channel not found.');
      await ctx.reply('Primary storage channel changed. Other channels are now backups.');
    } catch (error) {
      logger.error({ error: error.message }, 'Primary storage change failed');
      await ctx.reply('Could not change primary storage channel.');
    }
  });

  bot.command('storage_remove', async (ctx) => {
    try {
      const id = getNumericChannelId(getCommandArgument(ctx));
      const result = await removeStorageChannel(pool, id);
      if (result.removed) return ctx.reply('Storage channel removed from FileStore.');
      if (result.reason === 'referenced') return ctx.reply(`Channel contains ${result.references} indexed storage messages, so it was disabled instead of deleted.`);
      return ctx.reply('Channel not found.');
    } catch (error) {
      logger.error({ error: error.message }, 'Storage channel removal failed');
      await ctx.reply('Could not remove storage channel.');
    }
  });
}
