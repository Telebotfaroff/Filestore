export async function getAdminDashboardStats(pool) {
  const result = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM users) AS users_total,
    (SELECT COUNT(*)::int FROM users WHERE last_seen_at >= NOW() - INTERVAL '7 days') AS users_active_7d,
    (SELECT COUNT(*)::int FROM files WHERE status = 'active') AS files_active,
    (SELECT COUNT(*)::int FROM files WHERE status = 'disabled') AS files_disabled,
    (SELECT COUNT(*)::int FROM storage_channels WHERE is_enabled = TRUE) AS storage_channels_active,
    (SELECT COUNT(*)::int FROM delivery_bots WHERE is_enabled = TRUE) AS delivery_bots_active,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status = 'pending') AS jobs_pending,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status = 'processing') AS jobs_processing,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status = 'completed') AS jobs_completed,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status = 'failed') AS jobs_failed,
    (SELECT COUNT(*)::int FROM delivery_jobs WHERE status = 'uncertain') AS jobs_uncertain,
    (SELECT COUNT(*)::int FROM premium_memberships WHERE status = 'active' AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())) AS premium_active,
    (SELECT COUNT(*)::int FROM paid_file_links WHERE is_enabled = TRUE AND (expires_at IS NULL OR expires_at > NOW())) AS paid_file_links_active,
    (SELECT COUNT(*)::int FROM paid_batch_links WHERE is_enabled = TRUE AND (expires_at IS NULL OR expires_at > NOW())) AS paid_batch_links_active,
    (SELECT COUNT(*)::int FROM paid_file_purchases WHERE status = 'pending') AS paid_file_requests_pending,
    (SELECT COUNT(*)::int FROM paid_batch_purchases WHERE status = 'pending') AS paid_batch_requests_pending,
    (SELECT COUNT(*)::int FROM payment_transactions WHERE status = 'applied') AS payments_applied,
    (SELECT COALESCE(jsonb_object_agg(currency, total_minor), '{}'::jsonb) FROM (SELECT currency, SUM(amount_minor)::bigint AS total_minor FROM payment_transactions WHERE status = 'applied' GROUP BY currency) revenue) AS revenue_by_currency,
    (SELECT COUNT(*)::int FROM activity_logs WHERE created_at >= NOW() - INTERVAL '24 hours') AS events_24h`);
  return result.rows[0];
}

export function formatAdminDashboard(stats) {
  return [
    'FileStore Dashboard',
    '',
    'Users: ' + stats.users_total + ' (active 7d: ' + stats.users_active_7d + ')',
    'Files: ' + stats.files_active + ' active · ' + stats.files_disabled + ' disabled',
    'Storage channels: ' + stats.storage_channels_active,
    'Delivery bots: ' + stats.delivery_bots_active,
    '',
    'Delivery queue',
    'Pending: ' + stats.jobs_pending + ' · Processing: ' + stats.jobs_processing,
    'Completed: ' + stats.jobs_completed + ' · Failed: ' + stats.jobs_failed + ' · Uncertain: ' + stats.jobs_uncertain,
    '',
    'Premium active: ' + stats.premium_active,
    'Active paid links: single ' + stats.paid_file_links_active + ' · batch ' + stats.paid_batch_links_active,
    'Pending purchases: single ' + stats.paid_file_requests_pending + ' · batch ' + stats.paid_batch_requests_pending,
    'Payments applied: ' + stats.payments_applied,
    'Recorded revenue: ' + (Object.entries(stats.revenue_by_currency ?? {}).map(([currency, minor]) => currency + ' ' + (Number(minor) / 100).toFixed(2)).join(' · ') || 'none'),
    'Activity events (24h): ' + stats.events_24h,
  ].join('\n');
}


export async function getPaymentReconciliationStats(pool) {
  const { rows } = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM payment_transactions WHERE status='verified') AS verified_pending,
    (SELECT COUNT(*)::int FROM payment_transactions WHERE status='applied') AS applied,
    (SELECT COUNT(*)::int FROM payment_transactions WHERE status IN ('rejected','expired')) AS rejected_or_expired,
    (SELECT COUNT(*)::int FROM payment_sessions WHERE status='pending' AND expires_at > NOW()) AS checkout_pending,
    (SELECT COUNT(*)::int FROM payment_sessions WHERE status='failed') AS checkout_failed,
    (SELECT COUNT(*)::int FROM payment_sessions WHERE status='expired' OR (status='pending' AND expires_at <= NOW())) AS checkout_expired,
    (SELECT COUNT(*)::int FROM payment_provider_events WHERE processing_status='received') AS events_received,
    (SELECT COUNT(*)::int FROM payment_provider_events WHERE processing_status='failed') AS events_failed,
    (SELECT COUNT(*)::int FROM payment_provider_events WHERE processing_status='processed') AS events_processed,
    (SELECT COUNT(*)::int FROM payment_provider_events WHERE processing_status='ignored') AS events_ignored`);
  return rows[0];
}

export async function listRecentPayments(pool, limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
  const { rows } = await pool.query(
    `SELECT id, user_telegram_id, method, purpose, amount_minor, currency, status, external_transaction_id, created_at
     FROM payment_transactions ORDER BY created_at DESC LIMIT $1`,
    [safeLimit],
);
  return rows;
}
