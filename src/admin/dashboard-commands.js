import { getAdminDashboardStats, formatAdminDashboard, getPaymentReconciliationStats, listRecentPayments, getPaymentTransactionDetail } from './dashboard-repository.js';
import { applyVerifiedPayment } from '../payments/fulfillment-repository.js';

export function formatPaymentReconciliation(stats) {
  return [
    'Payment Reconciliation', '',
    'Verified awaiting fulfillment: ' + stats.verified_pending,
    'Applied: ' + stats.applied + ' · Rejected/expired: ' + stats.rejected_or_expired,
    '',
    'Checkout sessions: pending ' + stats.checkout_pending + ' · failed ' + stats.checkout_failed + ' · expired ' + stats.checkout_expired,
    'Provider events: received ' + stats.events_received + ' · processed ' + stats.events_processed + ' · failed ' + stats.events_failed + ' · ignored ' + stats.events_ignored,
    '',
    'Commands: /payment_recent · /payment_reconcile <transaction_id>',
  ].join('\n');
}

function formatRecentPayment(row) {
  return [
    '#' + row.id + ' · ' + String(row.status).toUpperCase(),
    'User: ' + (row.user_telegram_id ?? 'unknown') + ' · ' + row.method,
    'Purpose: ' + row.purpose + ' · ' + (Number(row.amount_minor) / 100).toFixed(2) + ' ' + row.currency,
    'Transaction: ' + (row.external_transaction_id ? String(row.external_transaction_id).slice(0, 28) : '—'),
    'Created: ' + new Date(row.created_at).toISOString(),
  ].join('\n');
}

export function registerDashboardCommands(bot, pool, logger) {
  async function show(ctx) {
    try { await ctx.reply(formatAdminDashboard(await getAdminDashboardStats(pool))); }
    catch (error) {
      logger.error({ error: error.message }, 'Dashboard stats query failed');
      await ctx.reply('Dashboard unavailable. Check migrations and database connection.');
    }
  }
  bot.command('dashboard', show);
  bot.command('stats', show);

  bot.command('payments', async (ctx) => {
    try { await ctx.reply(formatPaymentReconciliation(await getPaymentReconciliationStats(pool))); }
    catch (error) {
      logger.error({ error: error.message }, 'Payment reconciliation dashboard query failed');
      await ctx.reply('Payment dashboard unavailable. Check database migrations and connection.');
    }
  });

  bot.command('payment_recent', async (ctx) => {
    try {
      const rows = await listRecentPayments(pool, 10);
      await ctx.reply('Recent payment transactions\n\n' + (rows.length ? rows.map(formatRecentPayment).join('\n\n') : 'No payment transactions yet.'));
    } catch (error) {
      logger.error({ error: error.message }, 'Recent payment list failed');
      await ctx.reply('Could not load recent payment transactions.');
    }
  });

  bot.command('payment_reconcile', async (ctx) => {
    const id = Number(ctx.message?.text?.trim().split(/\s+/)[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('Usage: /payment_reconcile <verified_transaction_id>');
    try {
      const result = await applyVerifiedPayment(pool, id);
      await ctx.reply(result.alreadyApplied
        ? 'Transaction #' + id + ' was already applied. No duplicate grant created.'
        : 'Reconciliation succeeded for transaction #' + id + ' · purpose ' + result.type + ' · user ' + result.userId);
    } catch (error) {
      logger.error({ transactionId: id, error: error.message }, 'Payment reconciliation failed');
      await ctx.reply('Reconciliation failed safely for #' + id + ': ' + error.message);
    }
  });
}

function formatPaymentDetail(detail) {
  const tx = detail.transaction;
  const metadata = tx.session_metadata && typeof tx.session_metadata === 'object' ? tx.session_metadata : {};
  const amount = (Number(tx.amount_minor) / 100).toFixed(2) + ' ' + tx.currency;
  const external = tx.external_transaction_id ? String(tx.external_transaction_id) : '—';
  const sessionId = tx.session_id ?? '—';
  const lines = [
    'Payment Transaction #' + tx.id,
    '',
    'Transaction',
    'Status: ' + String(tx.status).toUpperCase(),
    'User: ' + (tx.user_telegram_id ?? 'unknown'),
    'Method: ' + tx.method,
    'Purpose: ' + tx.purpose,
    'Amount: ' + amount,
    'External ID: ' + external,
    'UTR: ' + (tx.utr ?? '—'),
    'Session ID: ' + sessionId,
    'Verified: ' + (tx.verified_at ? new Date(tx.verified_at).toISOString() : '—'),
    'Applied: ' + (tx.applied_at ? new Date(tx.applied_at).toISOString() : '—'),
    'Created: ' + new Date(tx.created_at).toISOString(),
    '',
    'Checkout session',
    'Status: ' + (tx.session_status ?? 'missing'),
    'Expected: ' + (tx.session_amount_minor != null ? (Number(tx.session_amount_minor) / 100).toFixed(2) + ' ' + (tx.session_currency ?? tx.currency) : '—'),
    'Expires: ' + (tx.session_expires_at ? new Date(tx.session_expires_at).toISOString() : '—'),
    'Provider session: ' + (tx.provider_session_id ?? '—'),
    'Checkout URL: ' + (tx.provider_checkout_url ?? '—'),
    'Label: ' + (metadata.label ? String(metadata.label).slice(0, 120) : '—'),
    'Stars price: ' + (metadata.starsPrice ?? '—'),
    '',
    'Provider event history (' + detail.events.length + ')',
  ];
  for (const event of detail.events) {
    lines.push(
      '',
      'Event #' + event.id + ' · ' + event.event_type,
      'Status: ' + event.processing_status,
      'Provider ID: ' + String(event.provider_event_id).slice(0, 100),
      'Received: ' + new Date(event.received_at).toISOString(),
      'Processed: ' + (event.processed_at ? new Date(event.processed_at).toISOString() : '—'),
      'Error: ' + (event.last_error ? String(event.last_error).replace(/[\\r\\n]+/g, ' ').slice(0, 300) : '—'),
    );
  }
  if (!detail.events.length) lines.push('No provider events linked.');
  return lines.join('\\n');
}

  bot.command('payment_detail', async (ctx) => {
    const id = Number(ctx.message?.text?.trim().split(/\\s+/)[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('Usage: /payment_detail <transaction_id>');
    try {
      const detail = await getPaymentTransactionDetail(pool, id);
      if (!detail) return ctx.reply('Payment transaction #' + id + ' not found.');
      await ctx.reply(formatPaymentDetail(detail), { disable_web_page_preview: true });
    } catch (error) {
      logger.error({ transactionId: id, error: error.message }, 'Payment detail query failed');
      await ctx.reply('Could not load transaction detail #' + id + '.');
    }
  });
