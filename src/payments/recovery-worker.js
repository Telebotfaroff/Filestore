import { applyVerifiedPayment } from './fulfillment-repository.js';

export function startPaymentRecoveryWorker(pool, logger, telegram = null, intervalMs = 30_000) {
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const pending = await pool.query(
        `SELECT id,user_telegram_id,purpose,method FROM payment_transactions WHERE status='verified' ORDER BY verified_at ASC NULLS FIRST,id ASC LIMIT 10`,
      );
      for (const tx of pending.rows) {
        if (stopped) break;
        try {
          const result = await applyVerifiedPayment(pool, tx.id);
          if (result.applied) {
            logger.info({ transactionId: tx.id, userId: tx.user_telegram_id, purpose: tx.purpose, method: tx.method }, 'Recovered verified payment fulfillment');
            if (telegram && tx.user_telegram_id) {
              const message = result.type === 'premium' ? 'Your Premium payment has now been activated.' : 'Your payment has now been processed. Your purchased files are unlocked. Use /get or /batch_get to request delivery.';
              await telegram.sendMessage(tx.user_telegram_id, message).catch(error => logger.warn({ transactionId: tx.id, error: error.message }, 'Recovered-payment notification failed'));
            }
          }
        } catch (error) {
          logger.warn({ transactionId: tx.id, error: error.message }, 'Verified payment recovery attempt failed');
        }
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Payment recovery scan failed');
    } finally { running = false; }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
