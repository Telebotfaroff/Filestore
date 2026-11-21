import { scanPendingFamPaySessions } from './fampay.js';

export function startFamPayVerificationWorker(pool, config, logger, telegram, botId = null, intervalMs = 20_000) {
  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const settled = await scanPendingFamPaySessions(pool, config, logger);
      for (const item of settled) {
        const session = item.session;
        const targetBotId = session.metadata?.deliveryBotId;
        if (botId && targetBotId && String(targetBotId) !== String(botId)) continue;

        let msg;
        if (item.fulfilled?.type === 'premium') {
          msg = `✅ FamPay UPI payment verified!\nPlan: ${item.fulfilled.plan ?? 'Premium'}\nUTR: ${item.utr ?? 'matched'}\nYour Premium access is now active.`;
        } else if (item.fulfilled?.type === 'paid_batch') {
          msg = `✅ FamPay UPI payment verified!\nUTR: ${item.utr ?? 'matched'}\nYour batch (${item.fulfilled.fileCount ?? ''} files) is now unlocked. Use /batch_get <code> to receive all files.`;
        } else {
          msg = `✅ FamPay UPI payment verified!\nUTR: ${item.utr ?? 'matched'}\nYour file is now unlocked. Use /get <file_code> or open your share link to receive it.`;
        }

        try {
          await telegram.sendMessage(session.user_telegram_id, msg);
        } catch (notifyErr) {
          logger?.warn({ userId: session.user_telegram_id, error: notifyErr.message }, 'FamPay activation notification failed');
        }
      }
    } catch (error) {
      logger?.warn({ error: error.message }, 'FamPay background verification tick failed');
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
