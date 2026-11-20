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

export async function getPaymentTransactionDetail(pool, transactionId) {
  const id = Number(transactionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid payment transaction ID.');
  const txResult = await pool.query(
    `SELECT t.id, t.user_telegram_id, t.method, t.external_transaction_id, t.utr, t.purpose,
            t.plan_id, t.file_id, t.batch_link_id, t.paid_link_id, t.amount_minor, t.currency,
            t.status, t.session_id, t.verified_at, t.applied_at, t.created_at, t.updated_at,
            s.status AS session_status, s.expected_amount_minor AS session_amount_minor,
            s.currency AS session_currency, s.expires_at AS session_expires_at,
            s.provider_session_id, s.provider_checkout_url, s.metadata AS session_metadata,
            s.created_at AS session_created_at, s.updated_at AS session_updated_at
     FROM payment_transactions t
     LEFT JOIN payment_sessions s ON s.id = t.session_id
     WHERE t.id = $1 LIMIT 1`,
    [id],
  );
  const transaction = txResult.rows[0];
  if (!transaction) return null;
  const eventResult = await pool.query(
    `SELECT id, method, provider_event_id, event_type, processing_status,
            payment_transaction_id, received_at, processed_at, last_error
     FROM payment_provider_events
     WHERE payment_transaction_id = $1
        OR (method = $2 AND provider_event_id = $3)
     ORDER BY received_at ASC LIMIT 25`,
    [id, transaction.method, transaction.external_transaction_id],
  );
  return { transaction, events: eventResult.rows };
}

const PAYMENT_LIST_STATUSES = new Set(['all', 'verified', 'applied', 'rejected', 'expired']);

export async function listPaymentTransactions(pool, { limit = 5, offset = 0, status = 'all' } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const safeOffset = Math.max(0, Number.isSafeInteger(Number(offset)) ? Number(offset) : 0);
  const safeStatus = PAYMENT_LIST_STATUSES.has(status) ? status : 'all';
  const where = safeStatus === 'all' ? '' : ' WHERE status = $1';
  const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM payment_transactions' + where, safeStatus === 'all' ? [] : [safeStatus]);
  const queryParams = safeStatus === 'all' ? [safeLimit, safeOffset] : [safeStatus, safeLimit, safeOffset];
  const limitIndex = safeStatus === 'all' ? '$1' : '$2';
  const offsetIndex = safeStatus === 'all' ? '$2' : '$3';
  const { rows } = await pool.query(
    'SELECT id, user_telegram_id, method, purpose, amount_minor, currency, status, external_transaction_id, created_at FROM payment_transactions' + where + ' ORDER BY created_at DESC LIMIT ' + limitIndex + ' OFFSET ' + offsetIndex,
    queryParams,
  );
  return { rows, total: Number(countResult.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset, status: safeStatus };
}

export async function searchPaymentTransactions(pool, searchTerm, limit = 10) {
  const term = String(searchTerm ?? '').trim().slice(0, 128);
  if (!term) return { rows: [], total: 0, term: '' };
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 10));
  const pattern = '%' + term + '%';
  const params = [term, pattern];
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM payment_transactions
     WHERE id::text = $1 OR user_telegram_id::text = $1
        OR external_transaction_id ILIKE $2
        OR utr ILIKE $2`,
    params,
  );
  const { rows } = await pool.query(
    `SELECT id, user_telegram_id, method, purpose, amount_minor, currency, status, external_transaction_id, created_at
     FROM payment_transactions
     WHERE id::text = $1 OR user_telegram_id::text = $1
        OR external_transaction_id ILIKE $2
        OR utr ILIKE $2
     ORDER BY created_at DESC LIMIT $3`,
    [...params, safeLimit],
  );
  return { rows, total: Number(countResult.rows[0]?.total ?? 0), term, limit: safeLimit };
}

export async function getPaymentAnalytics(pool) {
  const daily = await pool.query(`SELECT date_trunc('day', created_at)::date AS day, currency,
      COUNT(*) FILTER (WHERE status = 'applied')::int AS successful_count,
      COUNT(*) FILTER (WHERE status IN ('rejected','expired'))::int AS unsuccessful_count,
      COALESCE(SUM(amount_minor) FILTER (WHERE status = 'applied'), 0)::bigint AS successful_minor,
      COUNT(*)::int AS total_count
    FROM payment_transactions WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1, 2 ORDER BY 1, 2`);
  const methods = await pool.query(`SELECT method, currency,
      COUNT(*) FILTER (WHERE status = 'applied')::int AS successful_count,
      COUNT(*) FILTER (WHERE status IN ('rejected','expired'))::int AS unsuccessful_count,
      COALESCE(SUM(amount_minor) FILTER (WHERE status = 'applied'), 0)::bigint AS successful_minor,
      COUNT(*)::int AS total_count
    FROM payment_transactions WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY method, currency ORDER BY method, currency`);
  const totals = await pool.query(`SELECT currency,
      COUNT(*) FILTER (WHERE status = 'applied')::int AS successful_count,
      COUNT(*) FILTER (WHERE status IN ('rejected','expired'))::int AS unsuccessful_count,
      COUNT(*)::int AS total_count,
      COALESCE(SUM(amount_minor) FILTER (WHERE status = 'applied'), 0)::bigint AS successful_minor
    FROM payment_transactions WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY currency ORDER BY currency`);
  const premium = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status = 'active' AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW()))::int AS active_members,
      COUNT(*) FILTER (WHERE status = 'active' AND created_at >= NOW() - INTERVAL '30 days')::int AS new_members_30d,
      COUNT(*)::int AS membership_records_30d
    FROM premium_memberships WHERE created_at >= NOW() - INTERVAL '30 days'`);
  const users = await pool.query(`SELECT COUNT(DISTINCT user_telegram_id)::int AS paying_users_30d
    FROM payment_transactions WHERE status = 'applied' AND created_at >= NOW() - INTERVAL '30 days'`);
  return { daily: daily.rows, methods: methods.rows, totals: totals.rows, premium: premium.rows[0] ?? {}, payingUsers: Number(users.rows[0]?.paying_users_30d ?? 0) };
}

export function formatPaymentAnalytics(analytics) {
  const amount = (minor, currency) => (Number(minor ?? 0) / 100).toFixed(2) + ' ' + currency;
  const lines = ['Payment Analytics · Last 30 days', '', 'Revenue and outcomes'];
  for (const row of analytics.totals) lines.push(row.currency + ' · Revenue: ' + amount(row.successful_minor, row.currency) + ' · Successful: ' + row.successful_count + ' · Failed/expired: ' + row.unsuccessful_count + ' · Total: ' + row.total_count);
  if (!analytics.totals.length) lines.push('No payment records in the selected period.');
  lines.push('', 'Payment method breakdown');
  for (const row of analytics.methods) lines.push(row.method + ' · ' + row.currency + ' · Revenue ' + amount(row.successful_minor, row.currency) + ' · Success ' + row.successful_count + ' · Failed/expired ' + row.unsuccessful_count + ' · Total ' + row.total_count);
  if (!analytics.methods.length) lines.push('No method records.');
  lines.push('', 'Premium conversion snapshot', 'Active memberships now: ' + Number(analytics.premium.active_members ?? 0), 'New active memberships (30d): ' + Number(analytics.premium.new_members_30d ?? 0), 'Membership records created (30d): ' + Number(analytics.premium.membership_records_30d ?? 0), 'Unique paying users (30d): ' + Number(analytics.payingUsers ?? 0), '', 'Daily applied revenue');
  for (const row of analytics.daily) lines.push(new Date(row.day).toISOString().slice(0, 10) + ' · ' + row.currency + ' · ' + amount(row.successful_minor, row.currency) + ' · ' + row.successful_count + ' successful');
  if (!analytics.daily.length) lines.push('No daily payment totals.');
  return lines.join('\n');
}
