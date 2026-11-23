// Creator delivery-bot and slot-payment callback controller.
export function registerDeliveryBotActions(bot, context) {
  const { safeAnswer, showCloneBotScreen, showSlotUnlockScreen, isOwnerAdmin, unlockSlotWithWallet, pool, renderView, escapeHtml, formatMoney, sendStarsInvoice, config, getBotSlotSettings, createFamPayCheckout, verifyFamPaySession, cancelFamPaySession, getOwnerScope, findOwnedBotRow, setPrompt, showBots, showBotDetail, deliveryManager } = context;
  // Delivery Bot & Slot actions
  bot.action('cc:clone', async (ctx) => {
    await safeAnswer(ctx);
    await showCloneBotScreen(ctx, true);
  });

  bot.action('cc:slot_unlock', async (ctx) => {
    await safeAnswer(ctx);
    await showSlotUnlockScreen(ctx, true);
  });

  bot.action('cc:slot_pay_wallet', async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Owners already have unlimited slots.', true);
    try {
      const result = await unlockSlotWithWallet(pool, Number(ctx.from.id));
      const newTotal = 1 + Number(result.extraSlots || 1);
      await safeAnswer(ctx, 'Extra Delivery Bot slot unlocked! 🔓');
      return renderView(
        ctx,
        [
          '✅ <b>+1 Delivery Bot Slot Unlocked!</b>',
          '━━━━━━━━━━━━━━━━━━',
          '',
          `<blockquote>🎟 <b>New Bot Limit:</b> <code>${newTotal}</code> bots\n`
          + `💵 <b>Paid from Wallet:</b> <code>${escapeHtml(formatMoney(result.amountMinor, 'INR'))}</code>\n`
          + `💰 <b>Remaining Wallet:</b> <code>${escapeHtml(formatMoney(result.availableAfterMinor, 'INR'))}</code></blockquote>`,
          '',
          '👇 Tap below to connect your new Delivery Bot right now.',
        ].join('\n'),
        {
          inline_keyboard: [
            [{ text: '➕ Add Delivery Bot Now', callback_data: 'cc:prompt:delivery_bot_add' }],
            [
              { text: '🤖 My Delivery Bots', callback_data: 'cc:bots' },
              { text: '🎛 Main Menu', callback_data: 'cc:home' },
            ],
          ],
        },
        true,
        true,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
      return showSlotUnlockScreen(ctx, true);
    }
  });

  bot.action('cc:slot_pay_stars', async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Owners already have unlimited slots.', true);
    try {
      await safeAnswer(ctx);
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
    } catch (error) {
      await ctx.reply('❌ Telegram Stars slot checkout is unavailable right now: ' + error.message);
    }
  });

  bot.action('cc:slot_pay_upi', async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Owners already have unlimited slots.', true);
    try {
      const slotSettings = await getBotSlotSettings(pool);
      const checkout = await createFamPayCheckout(pool, config, {
        userId: Number(ctx.from.id),
        purpose: 'bot_slot',
        target: {},
        baseAmountMinor: slotSettings.priceMinor,
        currency: slotSettings.currency || 'INR',
        label: 'Extra Bot Slot',
      });
      await safeAnswer(ctx);
      const caption = [
        '📲 <b>Pay via UPI to Unlock +1 Bot Slot</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `<blockquote>💵 <b>Exact Amount:</b> <code>₹${escapeHtml(checkout.amountDisplay)}</code>\n`
        + `🏦 <b>UPI ID:</b> <code>${escapeHtml(checkout.upiId)}</code>\n`
        + `🔖 <b>Ref:</b> <code>${escapeHtml(checkout.txnRef)}</code></blockquote>`,
        '',
        '⚡ <i>Scan QR or pay the exact amount above, then tap <b>Verify Payment</b>.</i>',
      ].join('\n');
      const markup = {
        inline_keyboard: [
          [{ text: '✅ I Have Paid · Verify Payment', callback_data: `cc:slot_check:${checkout.session.id}` }],
          [
            { text: '✖ Cancel', callback_data: `cc:slot_cancel:${checkout.session.id}` },
            { text: '← Back', callback_data: 'cc:slot_unlock' },
          ],
        ],
      };
      if (checkout.qrBuffer) {
        await ctx.replyWithPhoto({ source: checkout.qrBuffer }, { caption, parse_mode: 'HTML', reply_markup: markup });
      } else {
        await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: markup });
      }
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });

  bot.action(/^cc:slot_check:(\d+)$/, async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Owners already have unlimited slots.', true);
    const sessionId = Number(ctx.match[1]);
    try {
      const result = await verifyFamPaySession(pool, config, sessionId, { userId: Number(ctx.from.id) });
      if (result.status === 'verified' || result.status === 'already_applied') {
        await safeAnswer(ctx, 'Payment verified! +1 Bot Slot unlocked! 🔓', true);
        return ctx.reply(
          '✅ <b>Payment Verified!</b>\n━━━━━━━━━━━━━━━━━━\n\n🔓 <b>+1 Delivery Bot slot</b> has been added to your account.',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '➕ Add Delivery Bot Now', callback_data: 'cc:prompt:delivery_bot_add' }],
                [
                  { text: '🤖 My Delivery Bots', callback_data: 'cc:bots' },
                  { text: '🎛 Main Menu', callback_data: 'cc:home' },
                ],
              ],
            },
          },
        );
      }
      if (result.status === 'expired') {
        await safeAnswer(ctx, 'This payment QR has expired. Please generate a new one.', true);
        return;
      }
      await safeAnswer(ctx, 'Payment not detected yet. Wait a few seconds after paying and tap Verify again.', true);
    } catch (error) {
      await safeAnswer(ctx, error.message || 'Verification failed.', true);
    }
  });

  bot.action(/^cc:slot_cancel:(\d+)$/, async (ctx) => {
    const sessionId = Number(ctx.match[1]);
    await cancelFamPaySession(pool, sessionId, Number(ctx.from.id)).catch(() => false);
    await safeAnswer(ctx, 'Checkout cancelled.');
    await showSlotUnlockScreen(ctx, false);
  });

  bot.action(/^cc:bot_replace:(\d+)$/, async (ctx) => {
    const botId = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const botRow = await findOwnedBotRow(botId, ownerId);
    if (!botRow) {
      await safeAnswer(ctx, 'Delivery Bot not found.', true);
      return showBots(ctx, true);
    }
    const cfg = setPrompt(ctx.from.id, 'bot_replace', {
      back: `cc:bot:${botRow.id}`,
      meta: { botId: botRow.id },
    });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      `✏️ Replace Delivery Bot @${botRow.username}\n━━━━━━━━━━━━━━━━━━\n${cfg.prompt}`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:bot:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showBotDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:bot_rm:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showBotDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:bot_test:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    try {
      const result = await deliveryManager.test(id, ownerId);
      const okCount = result.checks.filter((c) => c.status === 'ok' || c.status === 'force_sub_admin_ok').length;
      await safeAnswer(ctx, `@${result.bot.username} OK · ${okCount}/${result.checks.length} channel checks passed`, true);
    } catch (error) {
      await safeAnswer(ctx, 'Test failed: ' + error.message, true);
    }
    await showBotDetail(ctx, id, true);
  });

  bot.action(/^cc:bot_(pause|res|rst|pri):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const ownerId = getOwnerScope(ctx);
    let ok = false;
    if (action === 'pause') ok = await deliveryManager.pause(id, ownerId);
    else if (action === 'res') ok = await deliveryManager.resume(id, ownerId);
    else if (action === 'rst') ok = await deliveryManager.restart(id, ownerId);
    else if (action === 'pri') ok = await deliveryManager.promotePrimary(id, ownerId);
    await safeAnswer(ctx, ok ? 'Bot action applied.' : 'Bot action could not be completed.', !ok);
    await showBotDetail(ctx, id, true);
  });

  bot.action(/^cc:bot_rm_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await deliveryManager.remove(id, getOwnerScope(ctx));
    await safeAnswer(ctx, 'Delivery Bot removed.');
    await showBots(ctx, true);
  });
}
