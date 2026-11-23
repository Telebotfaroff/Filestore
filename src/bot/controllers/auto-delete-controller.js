// Auto-delete configuration callback controller.
export function registerAutoDeleteActions(bot, context) {
  const { isOwnerAdmin, denyAdminOnly, pool, setAutoDeleteMinutes, safeAnswer, showAutoDelete } = context;
  // Auto-delete presets
  bot.action(/^cc:autodel_set:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const minutes = Number(ctx.match[1]);
    if (minutes > 10080) return safeAnswer(ctx, 'Max 10080 minutes.', true);
    await setAutoDeleteMinutes(pool, minutes, ctx.from.id);
    await safeAnswer(ctx, minutes ? `Auto-delete set to ${minutes}m.` : 'Auto-delete turned OFF.');
    await showAutoDelete(ctx, true);
  });
}
