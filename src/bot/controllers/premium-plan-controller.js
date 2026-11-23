// Premium plan callback controller.
export function registerPremiumPlanActions(bot, context) {
  const { isOwnerAdmin, denyAdminOnly, safeAnswer, showPlanDetail, pool, showPlans } = context;
  // Premium plan actions
  bot.action(/^cc:plan:(\d+)$/, async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPlanDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:plan_rm:(\d+)$/, async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPlanDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:plan_(en|dis):(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const enabled = ctx.match[1] === 'en';
    const id = Number(ctx.match[2]);
    await pool.query('UPDATE premium_plans SET is_enabled = $2, updated_at = NOW() WHERE id = $1', [id, enabled]);
    await safeAnswer(ctx, enabled ? 'Plan enabled.' : 'Plan disabled.');
    await showPlanDetail(ctx, id, true);
  });

  bot.action(/^cc:plan_rm_ok:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    await pool.query('DELETE FROM premium_plans WHERE id = $1', [id]);
    await safeAnswer(ctx, 'Plan deleted.');
    await showPlans(ctx, true);
  });
}
