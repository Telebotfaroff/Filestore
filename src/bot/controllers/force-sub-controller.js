// Force-subscription channel callback controller.
export function registerForceSubActions(bot, context) {
  const { pool, setForceSubGlobal, getOwnerScope, safeAnswer, showForceSub, showForceSubDetail, findOwnedForceSubRow, validateForceSubChannel, isOwnerAdmin, removeForceSubChannel, setForceSubEnabled } = context;
  // Force-Sub actions
  bot.action(/^cc:fsub_g:(0|1)$/, async (ctx) => {
    const enabled = ctx.match[1] === '1';
    await setForceSubGlobal(pool, enabled, ctx.from.id, getOwnerScope(ctx));
    await safeAnswer(ctx, `Force-subscription ${enabled ? 'enabled' : 'disabled'}.`);
    await showForceSub(ctx, true);
  });

  bot.action(/^cc:fsub_ch:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showForceSubDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:fsub_rm:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showForceSubDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:fsub_test:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedForceSubRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const chatId = Number(ch.telegram_chat_id);
    try {
      await validateForceSubChannel(ctx, chatId, { requireUserAdmin: !isOwnerAdmin(ctx) });
      await pool.query("UPDATE force_sub_channels SET last_test_status = 'ok', last_test_error = NULL, updated_at = NOW() WHERE id = $1", [ch.id]);
      await safeAnswer(ctx, 'Force-sub admin check passed!', true);
    } catch (error) {
      await pool.query("UPDATE force_sub_channels SET last_test_status = 'failed', last_test_error = $2, updated_at = NOW() WHERE id = $1", [ch.id, error.message.slice(0, 500)]).catch(() => {});
      await safeAnswer(ctx, 'Test failed: ' + error.message, true);
    }
    await showForceSubDetail(ctx, id, true);
  });

  bot.action(/^cc:fsub_(en|dis|rm_ok):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedForceSubRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const chatId = Number(ch.telegram_chat_id);
    if (action === 'rm_ok') {
      await removeForceSubChannel(pool, chatId, ownerId);
      await safeAnswer(ctx, 'Force-sub channel removed.');
      return showForceSub(ctx, true);
    }
    await setForceSubEnabled(pool, chatId, action === 'en', ownerId);
    await safeAnswer(ctx, action === 'en' ? 'Channel enabled.' : 'Channel disabled.');
    return showForceSubDetail(ctx, id, true);
  });
}
