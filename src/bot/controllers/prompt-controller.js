// Guided input prompt callback controller.
export function registerPromptActions(bot, context) {
  const { OWNER_ONLY_PROMPTS, isOwnerAdmin, denyAdminOnly, setPrompt, deliveryManager, pool, getCreatorSlotsSnapshot, clearPrompt, safeAnswer, showSlotUnlockScreen, renderView, getActivePrompt, getShortenerDraft, clearShortenerDraft } = context;
  // Prompt starters & cancel
  bot.action(/^cc:prompt:([a-z_]+)$/, async (ctx) => {
    const action = ctx.match[1];
    if (OWNER_ONLY_PROMPTS.has(action) && !isOwnerAdmin(ctx)) {
      return denyAdminOnly(ctx);
    }
    try {
      const cfg = setPrompt(ctx.from.id, action);
      let promptText = cfg.prompt;
      const inlineKeyboard = [];

      if (action === 'storage_add') {
        const botInfo = await ctx.telegram.getMe().catch(() => null);
        const botLabel = botInfo?.username ? `@${botInfo.username}` : 'this Main Bot';
        promptText = [
          '🗄 Add Storage Channel',
          '',
          `1️⃣ Add ${botLabel} as an Administrator in your channel (with Post Messages permission). If you use your own Delivery Bot, add it as Administrator too.`,
          '2️⃣ Then send the -100... channel ID, @username, or t.me link — OR simply forward any post from your channel right here.',
        ].join('\n');
      } else if (action === 'delivery_bot_add' && !isOwnerAdmin(ctx)) {
        const creatorId = Number(ctx.from.id);
        const [bots, storageRows, slots] = await Promise.all([
          deliveryManager.list(creatorId),
          listStorageChannels(pool, creatorId).catch(() => []),
          getCreatorSlotsSnapshot(creatorId, false),
        ]);
        const usedSlots = Math.max(slots.usedSlots, bots.length);
        const remainingSlots = Math.max(0, slots.totalAllowed - usedSlots);
        if (remainingSlots <= 0) {
          clearPrompt(ctx.from.id);
          await safeAnswer(ctx, 'Delivery Bot slot limit reached.', true);
          return showSlotUnlockScreen(ctx, true, { limitReached: true });
        }
        const hasOwnStorage = storageRows.some((c) => c.is_enabled);
        promptText = hasOwnStorage
          ? `${cfg.prompt}\n\n🎟 Slot: ${usedSlots}/${slots.totalAllowed} used (${remainingSlots} available)\n🛡️ Reminder: Make sure your new Delivery Bot is also added as an Administrator in your own Storage Channel(s) — otherwise it will not work.`
          : `${cfg.prompt}\n\n🎟 Slot: ${usedSlots}/${slots.totalAllowed} used (${remainingSlots} available)\n⚠️ IMPORTANT REQUIREMENT:\nYou MUST add your own Storage Channel (and make both this Main Bot and your Delivery Bot Administrators in it) — otherwise your Delivery Bot will NOT work!`;
        if (!hasOwnStorage) {
          inlineKeyboard.push([{ text: '🗄 Add Storage Channel First', callback_data: 'cc:prompt:storage_add' }]);
        }
      }

      inlineKeyboard.push([{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]);
      await safeAnswer(ctx);
      await renderView(
        ctx,
        `✏️ Interactive Input\n━━━━━━━━━━━━━━━━━━\n${promptText}`,
        { inline_keyboard: inlineKeyboard },
        true,
      );
    } catch {
      await safeAnswer(ctx, 'Unknown prompt.', true);
    }
  });

  bot.action('cc:cancel_prompt', async (ctx) => {
    const active = getActivePrompt(ctx.from.id);
    const back = active?.back ?? (getShortenerDraft(ctx.from.id) ? 'cc:short' : 'cc:home');
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    await safeAnswer(ctx, 'Cancelled.');
    await renderView(
      ctx,
      '🛑 Input Cancelled\n━━━━━━━━━━━━━━━━━━\nNo changes were saved.',
      { inline_keyboard: [[{ text: '← Back', callback_data: back }, { text: '🎛 Main Menu', callback_data: 'cc:home' }]] },
      true,
    );
  });
}
