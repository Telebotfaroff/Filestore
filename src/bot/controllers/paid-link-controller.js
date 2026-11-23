// Paid-file and paid-batch callback controller.
export function registerPaidLinkActions(bot, context) {
  const { safeAnswer, showPaidLinkDetail, deletePaidFileLink, pool, getOwnerScope, showPaidLinks, getPaidFileLinkByIdOrCode, setPaidFileLinkEnabled, disablePaidFileLink, isOwnerAdmin, denyAdminOnly, confirmPaidFilePurchase, getPaidFileLink, showPaidRequests, showBatchLinkDetail, deletePaidBatchLink, showBatchLinks, getPaidBatchByIdOrCode, setPaidBatchLinkEnabled, disablePaidBatchLink, confirmPaidBatchPurchase, getPaidBatch, showBatchRequests } = context;
  // Paid file link & batch actions
  bot.action(/^cc:paid_view:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showPaidLinkDetail(ctx, Number(ctx.match[1]), true, false);
  });

  bot.action(/^cc:paid_del:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showPaidLinkDetail(ctx, Number(ctx.match[1]), true, true);
  });

  bot.action(/^cc:paid_del_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    try {
      const deleted = await deletePaidFileLink(pool, id, getOwnerScope(ctx));
      await safeAnswer(ctx, deleted ? `Deleted paid link ${deleted.public_code}.` : 'Paid link not found.');
    } catch (error) {
      await safeAnswer(ctx, 'Delete failed: ' + error.message, true);
    }
    await showPaidLinks(ctx, true);
  });

  bot.action(/^cc:paid_tog:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const row = await getPaidFileLinkByIdOrCode(pool, id, ownerId);
    if (!row) return safeAnswer(ctx, 'Paid link not found.', true);
    await setPaidFileLinkEnabled(pool, id, !row.is_enabled, ownerId);
    await safeAnswer(ctx, !row.is_enabled ? 'Paid link enabled.' : 'Paid link disabled.');
    await showPaidLinkDetail(ctx, id, true, false);
  });

  bot.action(/^cc:paid_dis:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const row = await getPaidFileLinkByIdOrCode(pool, id, ownerId);
    if (!row) return safeAnswer(ctx, 'Paid link not found.', true);
    await disablePaidFileLink(pool, row.public_code, ctx.from.id, ownerId);
    await safeAnswer(ctx, 'Paid link disabled.');
    await showPaidLinks(ctx, true);
  });

  bot.action(/^cc:paid_ok:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const purchaseId = Number(ctx.match[1]);
    const res = await pool.query(
      `SELECT p.user_telegram_id, l.public_code
       FROM paid_file_purchases p JOIN paid_file_links l ON l.id = p.paid_link_id
       WHERE p.id = $1 LIMIT 1`,
      [purchaseId],
    );
    const row = res.rows[0];
    if (!row) return safeAnswer(ctx, 'Purchase record not found.', true);
    const result = await confirmPaidFilePurchase(pool, row.public_code, String(row.user_telegram_id), ctx.from.id);
    if (!result.alreadyConfirmed) {
      const link = await getPaidFileLink(pool, row.public_code);
      try {
        await ctx.telegram.sendMessage(
          row.user_telegram_id,
          `🎉 Payment Verified!\n━━━━━━━━━━━━━━━━━━\n🔓 Paid access is now unlocked for:\n📄 ${link?.file_name ?? 'your file'}\n\n👇 Request delivery anytime:\n/get ${link?.file_code ?? ''}`,
        );
      } catch {}
    }
    await safeAnswer(ctx, result.alreadyConfirmed ? 'Already confirmed.' : 'Purchase confirmed & unlocked!', true);
    await showPaidRequests(ctx, true);
  });

  bot.action(/^cc:batch_view:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showBatchLinkDetail(ctx, Number(ctx.match[1]), true, false);
  });

  bot.action(/^cc:batch_del:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showBatchLinkDetail(ctx, Number(ctx.match[1]), true, true);
  });

  bot.action(/^cc:batch_del_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    try {
      const deleted = await deletePaidBatchLink(pool, id, getOwnerScope(ctx));
      await safeAnswer(ctx, deleted ? `Deleted batch link ${deleted.public_code}.` : 'Batch link not found.');
    } catch (error) {
      await safeAnswer(ctx, 'Delete failed: ' + error.message, true);
    }
    await showBatchLinks(ctx, true);
  });

  bot.action(/^cc:batch_tog:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const row = await getPaidBatchByIdOrCode(pool, id, ownerId);
    if (!row) return safeAnswer(ctx, 'Batch link not found.', true);
    await setPaidBatchLinkEnabled(pool, id, !row.is_enabled, ownerId);
    await safeAnswer(ctx, !row.is_enabled ? 'Batch link enabled.' : 'Batch link disabled.');
    await showBatchLinkDetail(ctx, id, true, false);
  });

  bot.action(/^cc:batch_dis:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const row = await getPaidBatchByIdOrCode(pool, id, ownerId);
    if (!row) return safeAnswer(ctx, 'Batch link not found.', true);
    await disablePaidBatchLink(pool, row.public_code, ownerId);
    await safeAnswer(ctx, 'Batch link disabled.');
    await showBatchLinks(ctx, true);
  });

  bot.action(/^cc:batch_ok:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const purchaseId = Number(ctx.match[1]);
    const res = await pool.query(
      `SELECT p.user_telegram_id, b.public_code
       FROM paid_batch_purchases p JOIN paid_batch_links b ON b.id = p.batch_link_id
       WHERE p.id = $1 LIMIT 1`,
      [purchaseId],
    );
    const row = res.rows[0];
    if (!row) return safeAnswer(ctx, 'Batch purchase not found.', true);
    const result = await confirmPaidBatchPurchase(pool, row.public_code, String(row.user_telegram_id), ctx.from.id);
    if (!result.alreadyConfirmed) {
      const batch = await getPaidBatch(pool, row.public_code);
      try {
        await ctx.telegram.sendMessage(
          row.user_telegram_id,
          `🎉 Batch Payment Verified!\n━━━━━━━━━━━━━━━━━━\n📦 Collection: ${batch?.title ?? 'your collection'}\n🔓 All files in this batch are unlocked!\n\n👇 Queue delivery anytime:\n/batch_get ${row.public_code}`,
        );
      } catch {}
    }
    await safeAnswer(ctx, result.alreadyConfirmed ? 'Already confirmed.' : 'Batch confirmed & unlocked!', true);
    await showBatchRequests(ctx, true);
  });
}
