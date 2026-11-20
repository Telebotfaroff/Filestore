import { applyVerifiedPayment } from './fulfillment-repository.js';

const NOTIFICATION_BATCH = 25;
const MAX_NOTIFICATION_ATTEMPTS = 10;

async function notifyRecoveredPayments(pool, logger, telegram) {
  if (!telegram) return;
  const claimed = await pool.query(
    `WITH claimed AS (
       SELECT id FROM payment_transactions
       WHERE status='applied' AND recovery_notification_required=TRUE AND recovery_notification_sent_at IS NULL
         AND recovery_notification_attempts < $1
         AND (recovery_notification_claimed_at IS NULL OR recovery_notification_claimed_at < NOW()-INTERVAL '2 minutes')
       ORDER BY applied_at ASC NULLS FIRST, id ASC
       LIMIT $2 FOR UPDATE SKIP LOCKED
     )
     UPDATE payment_transactions p SET recovery_notification_claimed_at=NOW()
     FROM claimed c WHERE p.id=c.id
     RETURNING p.id,p.user_telegram_id,p.purpose`,
    [MAX_NOTIFICATION_ATTEMPTS, NOTIFICATION_BATCH],
  );
  for (const tx of claimed.rows) {
    if (!tx.user_telegram_id) {
      await pool.query(`UPDATE payment_transactions SET recovery_notification_required=FALSE,recovery_notification_sent_at=NOW(),recovery_notification_claimed_at=NULL WHERE id=$1 AND recovery_notification_claimed_at IS NOT NULL`, [tx.id]);
      continue;
    }
    const message = tx.purpose === 'premium'
      ? 'Your Premium payment has now been activated.'
      : 'Your payment has now been processed. Your purchased files are unlocked. Use /get or /batch_get to request delivery.';
    try {
      await telegram.sendMessage(tx.user_telegram_id, message);
      await pool.query(
        `UPDATE payment_transactions SET recovery_notification_sent_at=NOW(),recovery_notification_claimed_at=NULL,recovery_notification_last_error=NULL
         WHERE id=$1 AND recovery_notification_claimed_at IS NOT NULL`,
        [tx.id],
      );
    } catch (error) {
      const safeError = String(error.message ?? error).slice(0, 500);
      await pool.query(
        `UPDATE payment_transactions SET recovery_notification_attempts=recovery_notification_attempts+1,
         recovery_notification_claimed_at=NULL,recovery_notification_last_error=$2
         WHERE id=$1 AND recovery_notification_claimed_at IS NOT NULL`,
        [tx.id, safeError],
      ).catch(dbError => logger.error({ transactionId: tx.id, error: dbError.message }, 'Recovery notification retry update failed'));
      logger.warn({ transactionId: tx.id, error: safeError }, 'Recovered payment notification failed');
    }
  }
}

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
            await pool.query(`UPDATE payment_transactions SET recovery_last_error=NULL,recovery_next_at=NOW(),recovery_notification_required=TRUE WHERE id=$1 AND status='applied'`, [tx.id]);
            logger.info({ transactionId: tx.id, userId: tx.user_telegram_id, purpose: tx.purpose, method: tx.method }, 'Recovered verified payment fulfillment');
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
      await notifyRecoveredPayments(pool, logger, telegram);
    } catch (error) {
      logger.error({ error: error.message }, 'Payment recovery scan failed');
    } finally { running = false; }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
