// Forwarded-channel and media broadcast message controller.
export function registerForwardedMessageActions(bot, context) {
  const { getActivePrompt, next, clearPrompt, getOwnerScope, validateStorageChannel, isOwnerAdmin, pool, saveStorageChannel, deliveryManager, pickCreatorBroadcastBot, parseBroadcastContent, showBroadcastPreview } = context;
  // Forwarded channel message support for storage_add + media input for broadcast prompts.
  bot.on('message', async (ctx, next) => {
    const active = getActivePrompt(ctx.from?.id);
    if (!active) return next();

    const m = ctx.message;
    if (active.action === 'storage_add') {
      const forwardedChat = m.forward_origin?.type === 'channel'
        ? m.forward_origin.chat
        : (m.forward_from_chat?.type === 'channel' ? m.forward_from_chat : null);
      const isForwarded = Boolean(forwardedChat || m.forward_origin || m.forward_from_chat || m.forward_from || m.forward_sender_name);
      if (!isForwarded) return next();

      clearPrompt(ctx.from.id);
      const ownerId = getOwnerScope(ctx);
      const retryKeyboard = {
        inline_keyboard: [
          [{ text: '↻ Try Again', callback_data: 'cc:prompt:storage_add' }],
          [
            { text: '← Back to Section', callback_data: active.back },
            { text: '🎛 Main Menu', callback_data: 'cc:home' },
          ],
        ],
      };
      if (!forwardedChat) {
        return ctx.reply(
          '❌ That forwarded message is not from a Telegram channel.\nPlease forward a post directly from your Telegram channel, or send its -100... channel ID or @username.',
          { reply_markup: retryKeyboard },
        );
      }
      try {
        const chat = await validateStorageChannel(ctx, forwardedChat.id, { requireUserAdmin: !isOwnerAdmin(ctx) });
        const saved = await saveStorageChannel(pool, chat, ctx.from.id, ownerId);
        return ctx.reply(
          `✅ Storage Channel Connected!\n━━━━━━━━━━━━━━━━━━\n🗄 ${saved.title ?? 'Channel'}\n🆔 ID: ${saved.telegram_chat_id}\n⚡ Status: ${saved.is_enabled ? '🟢 Enabled' : '⚪ Disabled'} · 🧪 Tested OK`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '← Back to Section', callback_data: active.back },
                { text: '🎛 Main Menu', callback_data: 'cc:home' },
              ]],
            },
          },
        );
      } catch (error) {
        return ctx.reply('❌ Action failed: ' + error.message, { reply_markup: retryKeyboard });
      }
    }

    if (!['creator_broadcast', 'owner_broadcast'].includes(active.action)) return next();
    let mediaType = null, mediaFileId = null;
    if (m.photo?.length) { mediaType = 'photo'; mediaFileId = m.photo[m.photo.length - 1].file_id; }
    else if (m.video) { mediaType = 'video'; mediaFileId = m.video.file_id; }
    else if (m.document) { mediaType = 'document'; mediaFileId = m.document.file_id; }
    else if (m.animation) { mediaType = 'animation'; mediaFileId = m.animation.file_id; }
    else return next();
    clearPrompt(ctx.from.id);
    try {
      let creatorId, botId, allowPlatformBot = false;
      if (active.action === 'owner_broadcast') {
        if (!isOwnerAdmin(ctx)) throw new Error('Owner permission required.');
        creatorId = Number(active.meta?.creatorId);
        botId = Number(active.meta?.botId);
        allowPlatformBot = Boolean(active.meta?.allowPlatformBot);
        const bots = await deliveryManager.list(allowPlatformBot ? null : creatorId);
        if (!bots.some(b => Number(b.id) === botId && b.is_enabled)) throw new Error('Selected delivery bot is disabled or no longer available.');
      } else {
        if (isOwnerAdmin(ctx)) throw new Error('Creator broadcasts must be sent from a creator account.');
        creatorId = Number(ctx.from.id);
        const bots = await deliveryManager.list(creatorId);
        const activeBot = pickCreatorBroadcastBot(bots);
        if (!activeBot) throw new Error('No active delivery bot is running.');
        botId = Number(activeBot.id);
      }
      const parsed = parseBroadcastContent(m.caption ?? '');
      return showBroadcastPreview(ctx, {
        kind: active.action === 'owner_broadcast' ? 'owner' : 'creator',
        ownerTelegramId: creatorId,
        deliveryBotId: botId,
        allowPlatformBot,
        mediaType,
        mediaFileId,
        caption: parsed.body,
        buttons: parsed.buttons,
      });
    } catch (error) {
      return ctx.reply('❌ Could not queue media broadcast: ' + error.message, { reply_markup: { inline_keyboard: [[{ text: '↻ Try Again', callback_data: active.back || 'cc:broadcast' }]] } });
    }
  });
}
