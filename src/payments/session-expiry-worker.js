export async function expirePendingPaymentSessions(pool, limit = 500) {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
  const { rows } = await pool.query(
    `WITH expired AS (
       SELECT id FROM payment_sessions
       WHERE status='pending' AND expires_at <= NOW()
       ORDER BY expires_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE payment_sessions p SET status='expired', updated_at=NOW()
     FROM expired e WHERE p.id=e.id AND p.status='pending'
     RETURNING p.id`,
    [safeLimit],
  );
  return rows.length;
}

export function startPaymentSessionExpiryWorker(pool, logger, intervalMs = 60_000, batchSize = 500) {
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const count = await expirePendingPaymentSessions(pool, batchSize);
      if (count) logger.info({ count }, 'Expired abandoned payment sessions');
    } catch (error) {
      logger.error({ error: error.message }, 'Payment session expiry sweep failed');
    } finally { running = false; }
  }
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
