import { applyVerifiedPayment } from './fulfillment-repository.js';

export function startPaymentRecoveryWorker(pool, logger, telegram = null, intervalMs = 30_000) {
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const pending = await pool.query(
        `SELECT id,user_telegram_id,purpose,method,recovery_attempts
         FROM payment_transactions
         WHERE status='verified' AND recovery_next_at <= NOW()
         ORDER BY recovery_next_at ASC, verified_at ASC NULLS FIRST, id ASC LIMIT 25`,
      );
      for (const tx of pending.rows) {
        if (stopped) break;
        try {
          const result = await applyVerifiedPayment(pool, tx.id);
          if (result.applied) {
            await pool.query(`UPDATE payment_transactions SET recovery_last_error=NULL,recovery_next_at=NOW() WHERE id=$1 AND status='applied'`, [tx.id]);
            logger.info({ transactionId: tx.id, userId: tx.user_telegram_id, purpose: tx.purpose, method: tx.method }, 'Recovered verified payment fulfillment');
            if (telegram && tx.user_telegram_id) {
              const message = result.type === 'premium' ? 'Your Premium payment has now been activated.' : 'Your payment has now been processed. Your purchased files are unlocked. Use /get or /batch_get to request delivery.';
              await telegram.sendMessage(tx.user_telegram_id, message).catch(error => logger.warn({ transactionId: tx.id, error: error.message }, 'Recovered-payment notification failed'));
            }
          }
        } catch (error) {
          const attempts = Math.min(30, Number(tx.recovery_attempts ?? 0) + 1);
          const delaySeconds = Math.min(21_600, 30 * (2 ** Math.min(attempts - 1, 10)));
          const safeError = String(error.message ?? error).slice(0, 500);
          await pool.query(
            `UPDATE payment_transactions SET recovery_attempts=recovery_attempts+1,
             recovery_next_at=NOW()+($2::int * INTERVAL '1 second'), recovery_last_error=$3
             WHERE id=$1 AND status='verified'`,
            [tx.id, delaySeconds, safeError],
          ).catch(dbError => logger.error({ transactionId: tx.id, error: dbError.message }, 'Payment recovery backoff update failed'));
          logger.warn({ transactionId: tx.id, attempts, retryInSeconds: delaySeconds, error: safeError }, 'Verified payment recovery attempt failed');
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
