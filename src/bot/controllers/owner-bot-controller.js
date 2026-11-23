// Owner delivery-bot admin callback controller.
export function registerOwnerBotActions(bot, context) {
  const { isOwnerAdmin, denyAdminOnly, safeAnswer, showAllBotsForOwner, showOwnerBotDetail, deliveryManager, updateDeliveryBotForOwner, pool, getDeliveryBotDetailsForOwner, setPrompt, renderView } = context;
  // Owner All Delivery Bots directory actions
  bot.action(/^cc:all_bots:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await safeAnswer(ctx);
    await showAllBotsForOwner(ctx, Number(ctx.match[1]), true);
  });

  bot.action(/^cc:all_bot:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await safeAnswer(ctx);
    await showOwnerBotDetail(ctx, Number(ctx.match[1]), true, false);
  });

  bot.action(/^cc:all_bot_rm:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await safeAnswer(ctx);
    await showOwnerBotDetail(ctx, Number(ctx.match[1]), true, true);
  });

  bot.action(/^cc:all_bot_test:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    try {
      const result = await deliveryManager.test(id);
      const okCount = result.checks.filter((c) => c.status === 'ok' || c.status === 'force_sub_admin_ok').length;
      await safeAnswer(ctx, `@${result.bot.username} OK · ${okCount}/${result.checks.length} channel checks passed`, true);
    } catch (error) {
      await safeAnswer(ctx, 'Test failed: ' + error.message, true);
    }
    await showOwnerBotDetail(ctx, id, true);
  });

  bot.action(/^cc:all_bot_(pause|res|rst|pri|en|dis):(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const patch = action === 'pause'
      ? { action: 'pause' }
      : action === 'res'
        ? { action: 'resume' }
        : action === 'rst'
          ? { action: 'restart' }
          : action === 'pri'
            ? { role: 'primary' }
            : action === 'en'
              ? { isEnabled: true }
              : { isEnabled: false };
    try {
      const updated = await updateDeliveryBotForOwner(pool, id, patch, deliveryManager);
      if (!updated) return safeAnswer(ctx, 'Delivery bot not found.', true);
      await safeAnswer(ctx, 'Delivery bot updated.');
    } catch (error) {
      await safeAnswer(ctx, error.message || 'Bot action failed.', true);
    }
    await showOwnerBotDetail(ctx, id, true);
  });

  bot.action(/^cc:all_bot_prio:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    const details = await getDeliveryBotDetailsForOwner(pool, id);
    if (!details) return safeAnswer(ctx, 'Delivery bot not found.', true);
    setPrompt(ctx.from.id, 'owner_bot_prio', { back: `cc:all_bot:${id}`, meta: { botId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔢 Edit Delivery Bot Priority · #${details.bot.id}\n━━━━━━━━━━━━━━━━━━\n🤖 @${details.bot.username}\n📌 Current priority: ${details.bot.priority}\n\n✏️ Send new priority number (0–100000):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:all_bot_rm_ok:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    if (deliveryManager?.remove) {
      await deliveryManager.remove(id);
    } else {
      await pool.query('DELETE FROM delivery_bots WHERE id = $1', [id]);
    }
    await safeAnswer(ctx, 'Delivery Bot removed.');
    await showAllBotsForOwner(ctx, 0, true);
  });
}
