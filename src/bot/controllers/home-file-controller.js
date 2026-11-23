// Main navigation, dashboard, and indexed-file callback controller.
export function registerHomeFileActions(bot, context) {
  const { clearPrompt, clearShortenerDraft, shareLinksUi, paidLinksUi, walletUi, safeAnswer, showHome, isOwnerAdmin, denyAdminOnly, showDashboard, showHealth, showStorage, showFiles, countUnusedFilesForOwner, getOwnerScope, pool, renderView, showFileDetail, disableUnusedFilesForOwner, disableFileByIdOrCode } = context;
  // Top-level navigation callbacks
  bot.action('cc:home', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await safeAnswer(ctx);
    await showHome(ctx, true);
  });

  bot.action('cc:dash', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showDashboard(ctx, true); });
  bot.action('cc:health', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showHealth(ctx, true); });
  bot.action('cc:storage', async (ctx) => { await safeAnswer(ctx); await showStorage(ctx, true); });
  bot.action(/^cc:files:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showFiles(ctx, Number(ctx.match[1]), true); });
  bot.action('cc:files_clean', async (ctx) => {
    const ownerId = getOwnerScope(ctx);
    const count = await countUnusedFilesForOwner(pool, ownerId).catch(() => 0);
    await safeAnswer(ctx);
    if (!count) return showFiles(ctx, 0, true);
    return renderView(
      ctx,
      `🧹 <b>Clean Unused Files</b>\n━━━━━━━━━━━━━━━━━━\n\nFound <b>${count}</b> file(s) not attached to any active free or paid link.\n\nConfirm cleanup to remove them from your workspace count?`,
      {
        inline_keyboard: [
          [
            { text: `⚠ Clean ${count} File(s)`, callback_data: 'cc:files_clean_ok' },
            { text: 'Cancel', callback_data: 'cc:files:0' },
          ],
        ],
      },
      true,
      true,
      { parse_mode: 'HTML' },
    );
  });
  bot.action('cc:files_clean_ok', async (ctx) => {
    const removed = await disableUnusedFilesForOwner(pool, getOwnerScope(ctx)).catch(() => 0);
    await safeAnswer(ctx, removed ? `Cleaned ${removed} unused file(s).` : 'No unused files found.');
    await showFiles(ctx, 0, true);
  });
  bot.action(/^cc:file:([A-Za-z0-9_-]{2,32})$/, async (ctx) => { await safeAnswer(ctx); await showFileDetail(ctx, ctx.match[1], true); });
  bot.action(/^cc:fdel:([A-Za-z0-9_-]{2,32})$/, async (ctx) => { await safeAnswer(ctx); await showFileDetail(ctx, ctx.match[1], true, true); });
  bot.action(/^cc:fdel_ok:([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
    try {
      const result = await disableFileByIdOrCode(pool, ctx.match[1], getOwnerScope(ctx));
      await safeAnswer(ctx, result.deleted ? 'File removed from workspace. 🗑' : 'File not found.', !result.deleted);
      await showFiles(ctx, 0, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });
}
