// Storage-channel callback controller.
export function registerStorageActions(bot, context) {
  const { safeAnswer, showStorageDetail, getOwnerScope, findOwnedStorageRow, validateStorageChannel, pool, updateStorageTest, isOwnerAdmin, setPrimaryStorageChannel, setStorageEnabled, removeStorageChannel, showStorage } = context;
  // Storage actions
  bot.action(/^cc:stg:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showStorageDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:stg_rm:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showStorageDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:stg_test:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedStorageRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const chatId = Number(ch.telegram_chat_id);
    try {
      await validateStorageChannel(ctx, chatId, { requireUserAdmin: !isOwnerAdmin(ctx) });
      await updateStorageTest(pool, chatId, 'ok', null, ownerId);
      await safeAnswer(ctx, 'Storage permission test passed!', true);
    } catch (error) {
      await updateStorageTest(pool, chatId, 'failed', error.message, ownerId).catch(() => {});
      await safeAnswer(ctx, 'Test failed: ' + error.message, true);
    }
    await showStorageDetail(ctx, id, true);
  });

  bot.action(/^cc:stg_(en|dis|pri):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedStorageRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const chatId = Number(ch.telegram_chat_id);
    if (action === 'pri') await setPrimaryStorageChannel(pool, chatId, ownerId);
    else await setStorageEnabled(pool, chatId, action === 'en', ownerId);
    await safeAnswer(ctx, action === 'pri' ? 'Primary channel updated.' : action === 'en' ? 'Channel enabled.' : 'Channel disabled.');
    await showStorageDetail(ctx, id, true);
  });

  bot.action(/^cc:stg_rm_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedStorageRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const removed = await removeStorageChannel(pool, Number(ch.telegram_chat_id), ownerId);
    await safeAnswer(
      ctx,
      removed.removed ? 'Storage channel removed.' : `Channel has ${removed.references} files; disabled instead.`,
      true,
    );
    await showStorage(ctx, true);
  });
}
