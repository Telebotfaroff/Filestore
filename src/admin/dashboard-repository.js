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
    (SELECT COUNT(*)::int FROM premium_memberships WHERE status = 'active' AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW()())) AS premium_active,
    (SELECT COUNT(*)::int FROM paid_file_links WHERE is_enabled = TRUE AND (expires_at IS NULL OR expires_at > NOW()())) AS paid_file_links_active,
    (SELECT COUNT(*)::int FROM paid_batch_links WHERE is_enabled = TRUE AND (expires_at IS NULL OR expires_at > NOW()())) AS paid_batch_links_active,
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
