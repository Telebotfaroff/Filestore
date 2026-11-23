// Section navigation callback controller.
export function registerSectionNavigationActions(bot, context) {
  const { safeAnswer, showBots, isOwnerAdmin, denyAdminOnly, showJobs, showForceSub, showShorteners, showPlans, showCreatorPlans, showPaymentsHub, showPaymentMethods, showFamPayConfig, showStarsConfig, showPaymentRecovery, showExpiredSessions, showPaidLinks, showPaidRequests, showBatchLinks, showBatchRequests, showAutoDelete, showAutoDeleteFailed, showGuide, showUserGuide } = context;
  bot.action('cc:bots', async (ctx) => { await safeAnswer(ctx); await showBots(ctx, true); });
  bot.action('cc:jobs', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showJobs(ctx, true); });
  bot.action('cc:fsub', async (ctx) => { await safeAnswer(ctx); await showForceSub(ctx, true); });
  bot.action('cc:short', async (ctx) => { await safeAnswer(ctx); await showShorteners(ctx, true); });
  bot.action('cc:plans', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPlans(ctx, true); });
  bot.action('cc:cplans', async (ctx) => { await safeAnswer(ctx); await showCreatorPlans(ctx, true); });
  bot.action('cc:payments', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPaymentsHub(ctx, true); });
  bot.action('cc:pay_methods', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPaymentMethods(ctx, true); });
  bot.action('cc:fampay_cfg', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showFamPayConfig(ctx, true); });
  bot.action('cc:stars_cfg', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showStarsConfig(ctx, true); });
  bot.action('cc:pay_rec', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPaymentRecovery(ctx, true); });
  bot.action('cc:pay_sessions', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showExpiredSessions(ctx, true); });
  bot.action('cc:paid', async (ctx) => { await safeAnswer(ctx); await showPaidLinks(ctx, true); });
  bot.action('cc:paid_reqs', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPaidRequests(ctx, true); });
  bot.action('cc:batch', async (ctx) => { await safeAnswer(ctx); await showBatchLinks(ctx, true); });
  bot.action('cc:batch_reqs', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showBatchRequests(ctx, true); });
  bot.action('cc:autodel', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showAutoDelete(ctx, true); });
  bot.action('cc:autodel_failed', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showAutoDeleteFailed(ctx, true); });
  bot.action(/^cc:guide:(main|storage|delivery|access|payments|paid)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showGuide(ctx, ctx.match[1], true);
  });
  bot.action(/^cc:uguide:(overview|links|paid|setup|short|earn)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showUserGuide(ctx, ctx.match[1], true);
  });
}
