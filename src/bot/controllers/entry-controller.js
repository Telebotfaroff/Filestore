// Bot entry-command and referral callback controller.
export function registerEntryActions(bot, context) {
  const { clearPrompt, clearShortenerDraft, shareLinksUi, paidLinksUi, walletUi, claimReferralOnStart, pool, config, formatMoney, escapeHtml, logger, showHome, showCloneBotScreen, isOwnerAdmin, getBotSlotSettings, sendStarsInvoice, showSlotUnlockScreen, showReferralScreen, safeAnswer, showUserGuide, showCreatorPlans, showGuide, getActivePrompt, getShortenerDraft, options } = context;
  // Entry commands
  bot.command('start', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    const startPayload = String(ctx.startPayload ?? (ctx.message?.text || '').split(/\s+/)[1] ?? '').trim();
    const refMatch = startPayload.match(/^ref_([A-Za-z0-9_-]{8,32})$/i);
    if (refMatch) {
      try {
        const claim = await claimReferralOnStart(pool, {
          referredUser: ctx.from,
          token: refMatch[1],
          isNewUser: ctx.state?.isNewTelegramUser ?? null,
        });
        if (claim?.credited) {
          const rewardText = formatMoney(claim.rewardMinor, claim.currency || 'INR');
          const invitedLabel = ctx.from?.username
            ? `@${escapeHtml(ctx.from.username)}`
            : escapeHtml(ctx.from?.first_name || `User ${ctx.from?.id}`);
          const notifier = config?.notifyTelegram ?? bot.telegram;
          if (typeof notifier?.sendMessage === 'function' && claim.rewardMinor > 0) {
            void notifier.sendMessage(
              claim.referrerId,
              [
                '🎉 <b>New Successful Referral!</b>',
                '━━━━━━━━━━━━━━━━━━',
                `👤 <b>Invited User:</b> ${invitedLabel}`,
                `💵 <b>Reward Credited:</b> <code>+${escapeHtml(rewardText)}</code>`,
                `💰 <b>New Wallet Balance:</b> <code>${escapeHtml(formatMoney(claim.balanceAfterMinor ?? 0, claim.currency || 'INR'))}</code>`,
              ].join('\n'),
              { parse_mode: 'HTML' },
            ).catch(() => {});
          }
          await ctx.reply(
            '🎁 <b>Welcome via Referral!</b>\nYour account is ready — tap <b>🎁 Refer &amp; Earn</b> below to invite others too.',
            { parse_mode: 'HTML' },
          ).catch(() => {});
        } else if (claim?.reason === 'self_referral') {
          await ctx.reply('ℹ️ You cannot claim a referral reward using your own referral link.').catch(() => {});
        }
      } catch (error) {
        logger?.warn?.({ userId: ctx.from?.id, error: error.message }, 'Referral claim failed on /start');
      }
      await showHome(ctx, false);
      return;
    }
    if (/^clone$/i.test(startPayload)) {
      await showCloneBotScreen(ctx, false);
      return;
    }
    if (/^botslot$/i.test(startPayload) && !isOwnerAdmin(ctx)) {
      try {
        const slotSettings = await getBotSlotSettings(pool);
        if (slotSettings.starsPrice) {
          await sendStarsInvoice(
            bot,
            pool,
            ctx,
            'bot_slot',
            {},
            'Extra Delivery Bot Slot',
            'Unlock +1 additional custom Delivery Bot slot in FileStore',
            config.mainBotToken,
          );
          return;
        }
      } catch (error) {
        await ctx.reply('❌ Telegram Stars slot checkout is unavailable right now: ' + error.message);
        return;
      }
      await showSlotUnlockScreen(ctx, false);
      return;
    }
    await showHome(ctx, false);
  });

  bot.command('menu', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showHome(ctx, false);
  });

  bot.command(['referral', 'refer'], async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showReferralScreen(ctx, false);
  });

  bot.action('cc:referral', async (ctx) => {
    await safeAnswer(ctx);
    await showReferralScreen(ctx, true);
  });

  bot.command('guide', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showUserGuide(ctx, 'overview', false);
  });

  bot.command(['my_plans', 'cplans'], async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showCreatorPlans(ctx, false);
  });

  bot.command('help', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showGuide(ctx, 'main', false);
  });

  bot.command('cancel', async (ctx) => {
    const hadPrompt = Boolean(getActivePrompt(ctx.from.id)) || Boolean(getShortenerDraft(ctx.from.id)) || Boolean(shareLinksUi.getSession(ctx.from.id)) || Boolean(paidLinksUi.getSession(ctx.from.id)) || Boolean(walletUi.getSession(ctx.from.id)) || Boolean(options.hasActiveAdminPrompt?.(ctx.from.id));
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await ctx.reply(
      hadPrompt
        ? '🛑 Action Cancelled\n━━━━━━━━━━━━━━━━━━\nYour active input session has been cleared.'
        : 'ℹ️ Nothing to Cancel\n━━━━━━━━━━━━━━━━━━\nYou have no active input prompt right now.',
      { reply_markup: { inline_keyboard: [[{ text: '🎛 Main Menu', callback_data: 'cc:home' }]] } },
    );
  });
}
