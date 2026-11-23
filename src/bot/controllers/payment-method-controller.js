// Telegram Stars price callback controller.
export function registerPaymentMethodActions(bot, context) {
  const { isOwnerAdmin, denyAdminOnly, pool, safeAnswer, setPrompt, renderView } = context;
  // Payment method actions
  bot.action(/^cc:plan_stars:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const planId = Number(ctx.match[1]);
    const res = await pool.query('SELECT id, name FROM premium_plans WHERE id = $1 LIMIT 1', [planId]);
    if (!res.rowCount) return safeAnswer(ctx, 'Plan not found.', true);
    const plan = res.rows[0];
    setPrompt(ctx.from.id, 'plan_stars_single', { back: `cc:plan:${planId}`, meta: { planId } });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      `⭐ Set Telegram Stars Price\n━━━━━━━━━━━━━━━━━━\n💎 Plan #${plan.id}: ${plan.name}\n\n✏️ Send the integer Stars price (e.g. 50), or 0 to remove:`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });
}
