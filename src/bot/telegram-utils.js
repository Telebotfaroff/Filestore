export function launchTelegramBot(bot, onRuntimeError) {
  return new Promise((resolve, reject) => {
    let launched = false;
    bot.launch({ handleSignals: false }, () => {
      launched = true;
      resolve(bot.botInfo);
    }).catch((error) => {
      if (!launched) {
        reject(error);
      } else {
        onRuntimeError?.(error);
      }
    });
  });
}

export function truncateText(text, max = 3900) {
  const str = String(text ?? '');
  if (str.length <= max) return str;
  return str.slice(0, max - 16) + '\n\n...(truncated)';
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function renderView(ctx, text, keyboard, edit = false, disablePreview = true, extraOptions = {}) {
  const options = {
    reply_markup: keyboard,
    disable_web_page_preview: disablePreview,
    ...extraOptions,
  };
  const safeText = truncateText(text);
  if (!edit) return ctx.reply(safeText, options);
  try {
    return await ctx.editMessageText(safeText, options);
  } catch (error) {
    if (/message is not modified/i.test(String(error?.message))) return null;
    throw error;
  }
}

export async function safeAnswer(ctx, text, alert = false) {
  try {
    if (text) await ctx.answerCbQuery(String(text).slice(0, 190), { show_alert: alert });
    else await ctx.answerCbQuery();
  } catch {}
}

export function getCommandArgs(ctx) {
  return ctx.message?.text?.trim().split(/\s+/).slice(1) ?? [];
}

export function getCommandArgText(ctx) {
  return getCommandArgs(ctx).join(' ');
}

export async function validateStorageChannel(ctx, channelInput, { requireUserAdmin = false } = {}) {
  const chat = await ctx.telegram.getChat(channelInput);
  if (chat.type !== 'channel') throw new Error('Only Telegram channels are supported as storage destinations.');
  const botInfo = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(chat.id, botInfo.id);
  if (member.status !== 'administrator') throw new Error('The Main Bot must be an administrator in this channel.');
  if (member.can_post_messages !== true) throw new Error('The Main Bot must have permission to post in this channel.');
  if (requireUserAdmin && ctx.from?.id) {
    try {
      const userMember = await ctx.telegram.getChatMember(chat.id, ctx.from.id);
      if (!['creator', 'administrator'].includes(userMember.status)) {
        throw new Error('You must be the creator or an administrator of this Telegram channel to add it.');
      }
    } catch (error) {
      if (/creator or an administrator/i.test(String(error?.message))) throw error;
      throw new Error('Could not verify your administrator status in this channel.');
    }
  }
  return chat;
}

export async function validateForceSubChannel(ctx, channelInput, { requireUserAdmin = false } = {}) {
  const chat = await ctx.telegram.getChat(channelInput);
  if (chat.type !== 'channel') throw new Error('Force-subscription only supports Telegram channels.');
  const me = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(chat.id, me.id);
  if (member.status !== 'administrator') throw new Error('Main Bot must be a channel administrator to verify membership.');
  if (requireUserAdmin && ctx.from?.id) {
    try {
      const userMember = await ctx.telegram.getChatMember(chat.id, ctx.from.id);
      if (!['creator', 'administrator'].includes(userMember.status)) {
        throw new Error('You must be the creator or an administrator of this channel to add it.');
      }
    } catch (error) {
      if (/creator or an administrator/i.test(String(error?.message))) throw error;
      throw new Error('Could not verify your administrator status in this channel.');
    }
  }
  return chat;
}

export async function inspectBotChannelAccess(telegram, pool, botUserId, ownerId = null) {
  const ownerClause = ownerId === null || ownerId === undefined ? 'owner_telegram_id IS NULL' : 'owner_telegram_id = $1';
  const params = ownerId === null || ownerId === undefined ? [] : [Number(ownerId)];
  const [channels, forceSubChannels] = await Promise.all([
    pool.query(`SELECT telegram_chat_id, title FROM storage_channels WHERE is_enabled = TRUE AND ${ownerClause} ORDER BY priority ASC`, params),
    pool.query(`SELECT telegram_chat_id, title FROM force_sub_channels WHERE is_enabled = TRUE AND ${ownerClause} ORDER BY id ASC`, params),
  ]);
  const storage = [];
  for (const channel of channels.rows.slice(0, 12)) {
    const label = channel.title ?? channel.telegram_chat_id;
    try {
      const member = await telegram.getChatMember(channel.telegram_chat_id, botUserId);
      storage.push({ channel: label, status: ['administrator', 'member'].includes(member.status) ? 'ok' : 'not_member' });
    } catch (error) {
      storage.push({ channel: label, status: 'error', message: String(error?.message ?? 'Unknown error').slice(0, 120) });
    }
  }
  const forceSub = [];
  for (const channel of forceSubChannels.rows.slice(0, 12)) {
    const label = channel.title ?? channel.telegram_chat_id;
    try {
      const member = await telegram.getChatMember(channel.telegram_chat_id, botUserId);
      forceSub.push({ channel: label, status: member.status === 'administrator' ? 'force_sub_admin_ok' : 'force_sub_needs_admin' });
    } catch (error) {
      forceSub.push({ channel: label, status: 'force_sub_error', message: String(error?.message ?? 'Unknown error').slice(0, 120) });
    }
  }
  return { storage, forceSub };
}
