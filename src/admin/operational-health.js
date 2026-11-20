export async function getOperationalHealth(pool) {
  const startedAt = Date.now();
  const { rows } = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status='pending') AS delivery_pending,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status='pending' AND created_at < NOW()-INTERVAL '10 minutes') AS delivery_pending_stale,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status='processing') AS delivery_processing,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status='processing' AND (locked_until IS NULL OR locked_until <= NOW())) AS delivery_processing_stale,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status='failed') AS delivery_failed,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status='uncertain') AS delivery_uncertain,
    (SELECT COUNT(*)::int FROM scheduled_message_deletions WHERE status='pending' AND delete_at <= NOW() AND (retry_after IS NULL OR retry_after <= NOW())) AS deletions_due,
    (SELECT COUNT(*)::int FROM scheduled_message_deletions WHERE status='processing' AND (locked_until IS NULL OR locked_until <= NOW())) AS deletions_stale,
    (SELECT COUNT(*)::int FROM scheduled_message_deletions WHERE status='failed') AS deletions_failed,
    (SELECT COUNT(*)::int FROM payment_transactions WHERE status='verified') AS payment_recovery_pending,
    (SELECT COUNT(*) FROM payment_transactions WHERE status='applied' AND recovery_notification_required=TRUE AND recovery_notification_sent_at IS NULL AND recovery_notification_attempts < 10)::int AS payment_notifications_pending,
    (SELECT COUNT(*) FROM payment_transactions WHERE status='applied' AND recovery_notification_required=TRUE AND recovery_notification_attempts >= 10)::int AS payment_notifications_exhausted,
    (SELECT COUNT(*)::int FROM checkpoint_sessions WHERE status='pending' AND expires_at <= NOW()) AS checkpoint_expired_pending`);
  const stats = rows[0];
  const latencyMs = Date.now() - startedAt;
  const warningKeys = ['delivery_pending_stale','delivery_processing_stale','delivery_failed','delivery_uncertain','deletions_stale','deletions_failed','payment_recovery_pending','payment_notifications_exhausted','checkpoint_expired_pending'];
  const warnings = warningKeys.filter(key => Number(stats[key] ?? 0) > 0);
  return { status: warnings.length ? 'warning' : 'ok', latencyMs, stats, warnings };
}

export function formatOperationalHealth(health) {
  const s = health.stats;
  const lines = [
    'FileStore Operational Health',
    'Database: OK · query ' + health.latencyMs + 'ms',
    'Overall: ' + health.status.toUpperCase(),
    '',
    'Delivery queue',
    'Pending: ' + s.delivery_pending + ' (older than 10m: ' + s.delivery_pending_stale + ')',
    'Processing: ' + s.delivery_processing + ' (stale leases: ' + s.delivery_processing_stale + ')',
    'Failed: ' + s.delivery_failed + ' · Uncertain: ' + s.delivery_uncertain,
    '',
    'Auto-delete',
    'Due now: ' + s.deletions_due + ' · Stale leases: ' + s.deletions_stale + ' · Failed: ' + s.deletions_failed,
    '',
    'Payments',
    'Verified recovery pending: ' + s.payment_recovery_pending,
    'Customer notifications pending: ' + s.payment_notifications_pending + ' · Exhausted retries: ' + s.payment_notifications_exhausted,
    '',
    'Checkpoint cleanup',
    'Expired pending sessions: ' + s.checkpoint_expired_pending,
  ];
  if (health.warnings.length) lines.push('', 'Attention: ' + health.warnings.map(key => key.replaceAll('_',' ')).join(' · '));
  return lines.join('\n');
}
