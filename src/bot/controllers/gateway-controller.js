// Payment gateway and Telegram Stars callback controller.
export function registerGatewayActions(bot, context) {
  const { isOwnerAdmin, denyAdminOnly, pool, enableTelegramStars, safeAnswer, showPaymentMethods, showStarsConfig, disablePaymentMethod, testTelegramStars, enableFamPay, config, showFamPayConfig, testFamPayImapConnection, maskEmail, markPaymentMethodTest } = context;
  bot.action('cc:pay_en_stars', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      await enableTelegramStars(pool, ctx.from.id);
      await safeAnswer(ctx, 'Telegram Stars checkout enabled!', true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showPaymentMethods(ctx, true);
  });

  bot.action('cc:stars_en', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      await enableTelegramStars(pool, ctx.from.id);
      await safeAnswer(ctx, 'Telegram Stars checkout enabled!', true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showStarsConfig(ctx, true);
  });

  bot.action('cc:stars_dis', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await disablePaymentMethod(pool, 'telegram_stars', ctx.from.id);
    await safeAnswer(ctx, 'Telegram Stars disabled.');
    await showStarsConfig(ctx, true);
  });

  bot.action('cc:stars_test', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      const res = await testTelegramStars(ctx.telegram, pool);
      await safeAnswer(ctx, `Stars OK (@${res.botUsername ?? 'bot'}) · ${res.counts.total} price(s) set`, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showStarsConfig(ctx, true);
  });

  bot.action('cc:pay_en_fampay', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      await enableFamPay(pool, config, ctx.from.id);
      await safeAnswer(ctx, 'FamPay UPI checkout enabled!', true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showFamPayConfig(ctx, true);
  });

  bot.action('cc:fampay_dis', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await disablePaymentMethod(pool, 'fampay', ctx.from.id);
    await safeAnswer(ctx, 'FamPay disabled.');
    await showFamPayConfig(ctx, true);
  });

  bot.action('cc:fampay_test', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      const res = await testFamPayImapConnection(pool, config);
      await safeAnswer(ctx, `IMAP OK (${maskEmail(res.gmailEmail)}) · INBOX: ${res.inboxMessages}`, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showFamPayConfig(ctx, true);
  });

  bot.action(/^cc:pay_test:(fampay|telegram_stars|stripe|crypto)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const method = ctx.match[1];
    try {
      if (method === 'fampay') {
        const res = await testFamPayImapConnection(pool, config);
        await safeAnswer(ctx, `FamPay IMAP OK · INBOX: ${res.inboxMessages}`, true);
      } else if (method === 'telegram_stars') {
        const res = await testTelegramStars(ctx.telegram, pool);
        await safeAnswer(ctx, `Telegram Stars OK · ${res.counts.total} price(s) set`, true);
      } else {
        throw new Error(`${method} gateway adapter is not connected yet.`);
      }
    } catch (error) {
      await markPaymentMethodTest(pool, method, 'failed', error.message).catch(() => {});
      await safeAnswer(ctx, error.message, true);
    }
    await showPaymentMethods(ctx, true);
  });

  bot.action(/^cc:pay_dis:(fampay|telegram_stars|stripe|crypto)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const method = ctx.match[1];
    await disablePaymentMethod(pool, method, ctx.from.id);
    await safeAnswer(ctx, `${method} disabled.`);
    await showPaymentMethods(ctx, true);
  });
}
