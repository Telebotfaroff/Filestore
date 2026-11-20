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

function formatPaymentDetail(detail) {
  const tx = detail.transaction;
  const metadata = tx.session_metadata && typeof tx.session_metadata === 'object' ? tx.session_metadata : {};
  const amount = (Number(tx.amount_minor) / 100).toFixed(2) + ' ' + tx.currency;
  const lines = [
    'Payment Transaction #' + tx.id, '',
    'Transaction',
    'Status: ' + String(tx.status).toUpperCase(),
    'User: ' + (tx.user_telegram_id ?? 'unknown'),
    'Method: ' + tx.method,
    'Purpose: ' + tx.purpose,
    'Amount: ' + amount,
    'External ID: ' + (tx.external_transaction_id ? String(tx.external_transaction_id).slice(0, 100) : '—'),
    'UTR: ' + (tx.utr ?? '—'),
    'Session ID: ' + (tx.session_id ?? '—'),
    'Verified: ' + (tx.verified_at ? new Date(tx.verified_at).toISOString() : '—'),
    'Applied: ' + (tx.applied_at ? new Date(tx.applied_at).toISOString() : '—'),
    'Created: ' + (tx.created_at ? new Date(tx.created_at).toISOString() : '—'),
    '', 'Checkout session',
    'Status: ' + (tx.session_status ?? 'missing'),
    'Expected: ' + (tx.session_amount_minor != null ? (Number(tx.session_amount_minor) / 100).toFixed(2) + ' ' + (tx.session_currency ?? tx.currency) : '—'),
    'Expires: ' + (tx.session_expires_at ? new Date(tx.session_expires_at).toISOString() : '—'),
    'Provider session: ' + (tx.provider_session_id ?? '—'),
    'Checkout URL: ' + (tx.provider_checkout_url ?? '—'),
    'Label: ' + (metadata.label ? String(metadata.label).slice(0, 120) : '—'),
    'Stars price: ' + (metadata.starsPrice ?? '—'),
    '', 'Provider event history (' + detail.events.length + ')',
  ];
  for (const event of detail.events) {
    lines.push(
      '', 'Event #' + event.id + ' · ' + event.event_type,
      'Status: ' + event.processing_status,
      'Provider ID: ' + String(event.provider_event_id ?? '—').slice(0, 100),
      'Received: ' + (event.received_at ? new Date(event.received_at).toISOString() : '—'),
      'Processed: ' + (event.processed_at ? new Date(event.processed_at).toISOString() : '—'),
      'Error: ' + (event.last_error ? String(event.last_error).replace(/[\r\n]+/g, ' ').slice(0, 300) : '—'),
    );
  }
  if (!detail.events.length) lines.push('No provider events linked.');
  return lines.join('\n');
}

function detailKeyboard(tx) {
  const rows = [];
  if (tx.status === 'verified') rows.push([{ text: '↻ Retry safe fulfillment', callback_data: 'payreconcile:' + tx.id }]);
  rows.push([{ text: '← Recent payments', callback_data: 'paymentrecent' }]);
  return { inline_keyboard: rows };
}

export function registerDashboardCommands(bot, pool, logger) {
  async function show(ctx) {
    try { await ctx.reply(formatAdminDashboard(await getAdminDashboardStats(pool))); }
    catch (error) {
      logger.error({ error: error.message }, 'Dashboard stats query failed');
      await ctx.reply('Dashboard unavailable. Check migrations and database connection.');
    }
  }

  async function sendPaymentDetail(ctx, id, edit = false) {
    const detail = await getPaymentTransactionDetail(pool, id);
    if (!detail) {
      const message = 'Payment transaction #' + id + ' not found.';
      return edit ? ctx.editMessageText(message) : ctx.reply(message);
    }
    const text = formatPaymentDetail(detail);
    const options = { reply_markup: detailKeyboard(detail.transaction), disable_web_page_preview: true };
    return edit ? ctx.editMessageText(text, options) : ctx.reply(text, options);
  }

  async function showRecent(ctx, edit = false) {
    const rows = await listRecentPayments(pool, 10);
    const text = 'Recent payment transactions\n\n' + (rows.length ? rows.map(formatRecentPayment).join('\n\n') : 'No payment transactions yet.');
    const keyboard = rows.map((row) => [{ text: 'Details #' + row.id + ' · ' + String(row.status).toUpperCase(), callback_data: 'paydetail:' + row.id }]);
    keyboard.push([{ text: '↻ Refresh', callback_data: 'paymentrecent' }]);
    const options = { reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true };
    return edit ? ctx.editMessageText(text, options) : ctx.reply(text, options);
  }

  async function reconcile(ctx, id, edit = false) {
    const result = await applyVerifiedPayment(pool, id);
    const message = result.alreadyApplied
      ? 'Transaction #' + id + ' was already applied. No duplicate grant created.'
      : 'Reconciliation succeeded for transaction #' + id + ' · purpose ' + result.type + ' · user ' + result.userId;
    if (edit) {
      await ctx.answerCbQuery(message.slice(0, 180));
      return sendPaymentDetail(ctx, id, true);
    }
    return ctx.reply(message);
  }

  bot.command('dashboard', show);
  bot.command('stats', show);
  bot.command('payments', async (ctx) => {
    try {
      await ctx.reply(formatPaymentReconciliation(await getPaymentReconciliationStats(pool)), {
        reply_markup: { inline_keyboard: [[{ text: 'Recent transactions', callback_data: 'paymentrecent' }]] },
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Payment reconciliation dashboard query failed');
      await ctx.reply('Payment dashboard unavailable. Check database migrations and connection.');
    }
  });
  bot.command('payment_recent', async (ctx) => {
    try { await showRecent(ctx); }
    catch (error) {
      logger.error({ error: error.message }, 'Recent payment list failed');
      await ctx.reply('Could not load recent payment transactions.');
    }
  });
  bot.command('payment_reconcile', async (ctx) => {
    const id = Number(ctx.message?.text?.trim().split(/\s+/)[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('Usage: /payment_reconcile <verified_transaction_id>');
    try { await reconcile(ctx, id); }
    catch (error) {
      logger.error({ transactionId: id, error: error.message }, 'Payment reconciliation failed');
      await ctx.reply('Reconciliation failed safely for #' + id + ': ' + error.message);
    }
  });
  bot.command('payment_detail', async (ctx) => {
    const id = Number(ctx.message?.text?.trim().split(/\s+/)[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('Usage: /payment_detail <transaction_id>');
    try { await sendPaymentDetail(ctx, id); }
    catch (error) {
      logger.error({ transactionId: id, error: error.message }, 'Payment detail query failed');
      await ctx.reply('Could not load transaction detail #' + id + '.');
    }
  });

  bot.action('paymentrecent', async (ctx) => {
    try { await ctx.answerCbQuery(); await showRecent(ctx, true); }
    catch (error) {
      logger.error({ error: error.message }, 'Recent payments callback failed');
      await ctx.answerCbQuery('Could not load recent transactions.', { show_alert: true });
    }
  });
  bot.action(/^paydetail:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    try { await ctx.answerCbQuery(); await sendPaymentDetail(ctx, id, true); }
    catch (error) {
      logger.error({ transactionId: id, error: error.message }, 'Payment detail callback failed');
      await ctx.answerCbQuery('Could not load transaction details.', { show_alert: true });
    }
  });
  bot.action(/^payreconcile:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    try { await reconcile(ctx, id, true); }
    catch (error) {
      logger.error({ transactionId: id, error: error.message }, 'Payment reconciliation callback failed');
      await ctx.answerCbQuery('Recovery failed safely: ' + error.message.slice(0, 150), { show_alert: true });
    }
  });
}
