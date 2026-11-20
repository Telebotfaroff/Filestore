import { parseStorageIdentifier } from '../storage/identifier.js';
import { listForceSubChannels, saveForceSubChannel, setForceSubEnabled, removeForceSubChannel, setForceSubGlobal } from './force-sub-repository.js';

function getArguments(ctx) {
  return ctx.message?.text?.trim().split(/\s+/).slice(1) ?? [];
}

function parseChannelId(value) {
  const parsed = parseStorageIdentifier(value);
  if (typeof parsed !== 'number') throw new Error('Use the numeric channel ID for management commands.');
  return parsed;
}

async function validateChannel(ctx, input) {
  const chat = await ctx.telegram.getChat(input);
  if (chat.type !== 'channel') throw new Error('Force-subscription only supports Telegram channels.');
  const me = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(chat.id, me.id);
  if (member.status !== 'administrator') throw new Error('Main Bot must be a channel administrator to verify membership.');
  return chat;
}

export function registerForceSubAdminCommands(bot, pool, logger) {
  bot.command('force_sub', async (ctx) => {
    try {
      const setting = await pool.query("SELECT value FROM app_settings WHERE key = 'force_sub_enabled'");
      const globalEnabled = setting.rowCount ? setting.rows[0].value === true : true;
      const channels = await listForceSubChannels(pool);
      if (!channels.length) return ctx.reply(`Force-subscription is ${globalEnabled ? 'ON' : 'OFF'}, but no channels are configured.`);
      const rows = channels.map((c) => `${c.is_enabled ? 'ON' : 'OFF'} · ${c.title ?? c.telegram_chat_id}\nID: ${c.telegram_chat_id}\nJoin: ${c.join_url}\nTest: ${c.last_test_status}`);
      await ctx.reply(`Force-subscription: ${globalEnabled ? 'ON' : 'OFF'}\n\n` + rows.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Force-subscription list failed');
      await ctx.reply('Could not list force-subscription channels.');
    }
  });

  bot.command('force_sub_add', async (ctx) => {
    const [channelInput, joinUrl] = getArguments(ctx);
    if (!channelInput || !joinUrl) return ctx.reply('Usage: /force_sub_add <channel_id or @username> <https_join_link>');
    try {
      const parsedUrl = new URL(joinUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('Join link must use HTTPS.');
      const chat = await validateChannel(ctx, parseStorageIdentifier(channelInput));
      const saved = await saveForceSubChannel(pool, chat, parsedUrl.toString(), ctx.from.id);
      await ctx.reply(`Force-sub channel saved.\n${saved.title ?? 'Channel'}\nID: ${saved.telegram_chat_id}`);
    } catch (error) {
      logger.warn({ error: error.message }, 'Force-sub channel add rejected');
      await ctx.reply('Could not add force-sub channel: ' + error.message);
    }
  });

  bot.command('force_sub_test', async (ctx) => {
    try {
      const id = parseChannelId(getArguments(ctx)[0] ?? '');
      const chat = await validateChannel(ctx, id);
      await pool.query("UPDATE force_sub_channels SET last_test_status = 'ok', last_test_error = NULL, updated_at = NOW() WHERE telegram_chat_id = $1", [id]);
      await ctx.reply(`Force-sub permission test passed.\n${chat.title ?? chat.id}\nMain Bot is administrator.`);
    } catch (error) {
      const idText = getArguments(ctx)[0];
      try {
        const id = parseChannelId(idText ?? '');
        await pool.query("UPDATE force_sub_channels SET last_test_status = 'failed', last_test_error = $2, updated_at = NOW() WHERE telegram_chat_id = $1", [id, error.message.slice(0, 500)]);
      } catch {}
      await ctx.reply('Force-sub test failed: ' + error.message);
    }
  });

  bot.command('force_sub_enable', async (ctx) => {
    try {
      const id = parseChannelId(getArguments(ctx)[0] ?? '');
      if (!await setForceSubEnabled(pool, id, true)) return ctx.reply('Channel not found.');
      await ctx.reply('Force-sub channel enabled.');
    } catch (error) { await ctx.reply('Usage: /force_sub_enable <channel_id>'); }
  });

  bot.command('force_sub_disable', async (ctx) => {
    try {
      const id = parseChannelId(getArguments(ctx)[0] ?? '');
      if (!await setForceSubEnabled(pool, id, false)) return ctx.reply('Channel not found.');
      await ctx.reply('Force-sub channel disabled.');
    } catch (error) { await ctx.reply('Usage: /force_sub_disable <channel_id>'); }
  });

  bot.command('force_sub_remove', async (ctx) => {
    try {
      const id = parseChannelId(getArguments(ctx)[0] ?? '');
      if (!await removeForceSubChannel(pool, id)) return ctx.reply('Channel not found.');
      await ctx.reply('Force-sub channel removed.');
    } catch (error) { await ctx.reply('Usage: /force_sub_remove <channel_id>'); }
  });

  bot.command('force_sub_global_on', async (ctx) => {
    try {
      await setForceSubGlobal(pool, true, ctx.from.id);
      await ctx.reply('Global force-subscription enabled.');
    } catch (error) {
      logger.error({ error: error.message }, 'Force-sub global enable failed');
      await ctx.reply('Could not enable force-subscription.');
    }
  });

  bot.command('force_sub_global_off', async (ctx) => {
    try {
      await setForceSubGlobal(pool, false, ctx.from.id);
      await ctx.reply('Global force-subscription disabled.');
    } catch (error) {
      logger.error({ error: error.message }, 'Force-sub global disable failed');
      await ctx.reply('Could not disable force-subscription.');
    }
  });
}
