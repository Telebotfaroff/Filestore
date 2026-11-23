// Delivery-job retry callback controller.
export function registerDeliveryJobActions(bot, context) {
  const { isOwnerAdmin, denyAdminOnly, retryFailedDeliveryJob, pool, safeAnswer, showJobs } = context;
  // Delivery job retry
  bot.action(/^cc:job_retry:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const jobId = Number(ctx.match[1]);
    const result = await retryFailedDeliveryJob(pool, jobId);
    await safeAnswer(
      ctx,
      result.ok ? `Requeued job #${jobId} (${result.retriedItems} item(s))` : `Retry blocked (${result.reason})`,
      !result.ok,
    );
    await showJobs(ctx, true);
  });
}
