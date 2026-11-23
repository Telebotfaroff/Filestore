// Creator-scoped premium-plan callback controller.
export function registerCreatorPlanActions(bot, context) {
  const { safeAnswer, showCreatorPlanDetail, getOwnerScope, setPremiumPlanEnabled, pool, removePremiumPlan, showCreatorPlans, getPremiumPlanById, setPrompt, renderView } = context;
  // Creator-scoped Premium plan actions
  bot.action(/^cc:cplan:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showCreatorPlanDetail(ctx, Number(ctx.match[1]), true, false);
  });

  bot.action(/^cc:cplan_rm:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showCreatorPlanDetail(ctx, Number(ctx.match[1]), true, true);
  });

  bot.action(/^cc:cplan_(en|dis):(\d+)$/, async (ctx) => {
    const enabled = ctx.match[1] === 'en';
    const id = Number(ctx.match[2]);
    const ownerScope = getOwnerScope(ctx);
    const updated = await setPremiumPlanEnabled(pool, id, enabled, ownerScope);
    if (!updated) return safeAnswer(ctx, 'Plan not found.', true);
    await safeAnswer(ctx, enabled ? 'Plan enabled.' : 'Plan disabled.');
    await showCreatorPlanDetail(ctx, id, true, false);
  });

  bot.action(/^cc:cplan_rm_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerScope = getOwnerScope(ctx);
    const deleted = await removePremiumPlan(pool, id, ownerScope);
    if (!deleted) return safeAnswer(ctx, 'Plan not found.', true);
    await safeAnswer(ctx, 'Plan deleted.');
    await showCreatorPlans(ctx, true);
  });

  bot.action(/^cc:cplan_stars:(\d+)$/, async (ctx) => {
    const planId = Number(ctx.match[1]);
    const ownerScope = getOwnerScope(ctx);
    const plan = await getPremiumPlanById(pool, planId, ownerScope);
    if (!plan) return safeAnswer(ctx, 'Plan not found.', true);
    setPrompt(ctx.from.id, 'cplan_stars_single', { back: `cc:cplan:${planId}`, meta: { planId } });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      `⭐ Set Telegram Stars Price\n━━━━━━━━━━━━━━━━━━\n👑 Plan #${plan.id}: ${plan.name}\n\n✏️ Send the integer Stars price (e.g. 50), or 0 to remove:`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });
}
