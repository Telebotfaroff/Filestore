import { isAdmin } from './admin-guard.js';
import { escapeHtml, renderView, safeAnswer } from './telegram-utils.js';
import { formatMoney, parseMinorAmount } from '../utils/validation.js';
import {
  MIN_WITHDRAWAL_INR_MINOR,
  getCreatorWalletSummary,
  setCreatorPayoutUpi,
  requestWithdrawal,
  listWithdrawalRequests,
  getWithdrawalRequestById,
  approveWithdrawalPaid,
  rejectWithdrawalRefund,
} from '../wallet/repository.js';
import { notifyAdminsWithdrawalRequest } from '../wallet/notifications.js';

const SESSION_TTL_MS = 10 * 60 * 1000;
const WITHDRAW_PAGE_SIZE = 6;
const HTML = { parse_mode: 'HTML' };

function formatLedgerType(entryType) {
  if (entryType === 'sale_credit') return '📈 Sale';
  if (entryType === 'withdrawal_hold') return '⏳ Hold';
  if (entryType === 'withdrawal_paid') return '✅ Paid';
  if (entryType === 'withdrawal_refund') return '↩ Refund';
  return entryType;
}

function formatWithdrawalStatus(status) {
  if (status === 'pending') return '⏳ Pending';
  if (status === 'paid') return '✅ Paid';
  if (status === 'rejected') return '❌ Rejected';
  return status;
}

export function registerWalletUi(bot, config, logger, pool, hooks = {}) {
  const sessions = new Map();

  function isOwnerAdmin(ctx) {
    return !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
  }

  function getSession(userId) {
    const key = String(userId);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    return session;
  }

  function setSession(userId, data) {
    const key = String(userId);
    const session = { ...data, expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(key, session);
    return session;
  }

  function clearSession(userId) {
    sessions.delete(String(userId));
  }

  async function showWallet(ctx, edit = false) {
    hooks.clearOtherSessions?.(ctx.from.id);
    clearSession(ctx.from.id);
    const summary = await getCreatorWalletSummary(pool, ctx.from.id);
    const inr = summary.inrWallet;
    const xtr = summary.xtrWallet;

    const lines = [
      '💰 <b>My Creator Wallet &amp; Payouts</b> (<code>/me</code>)',
      '━━━━━━━━━━━━━━━━━━',
      '',
      `💵 <b>Available Balance: ${escapeHtml(formatMoney(inr.available_minor, 'INR'))}</b>`,
      `⏳ <b>Pending Lock:</b> ${escapeHtml(formatMoney(inr.locked_minor, 'INR'))}`,
      `📈 <b>Total Earned (INR):</b> ${escapeHtml(formatMoney(inr.total_earned_minor, 'INR'))}`,
      `🏦 <b>Total Withdrawn:</b> ${escapeHtml(formatMoney(inr.total_withdrawn_minor, 'INR'))}`,
    ];

    if (xtr && Number(xtr.total_earned_minor) > 0) {
      lines.push(`⭐ <b>Stars Earned (XTR):</b> ${escapeHtml(xtr.total_earned_minor)} ⭐`);
    }

    lines.push(
      '',
      '📲 <b>Payout Settings</b>',
      `• <b>UPI ID:</b> ${summary.settings.payout_upi_id ? `<code>${escapeHtml(summary.settings.payout_upi_id)}</code>` : '<i>Not set yet</i>'}`,
      `• <b>Min. Withdrawal:</b> ${escapeHtml(formatMoney(MIN_WITHDRAWAL_INR_MINOR, 'INR'))}`,
      '',
      '<blockquote>ℹ️ Premium subscriptions go to the platform owner. All earnings from your paid files &amp; batches credit directly here!</blockquote>',
    );

    if (summary.recentWithdrawals.length) {
      lines.push('', '🧾 <b>Recent Withdrawals</b>');
      for (const w of summary.recentWithdrawals.slice(0, 4)) {
        lines.push(`• <b>#${w.id}</b> · ${escapeHtml(formatMoney(w.amount_minor, w.currency))} → <code>${escapeHtml(w.upi_id)}</code> · ${formatWithdrawalStatus(w.status)}`);
      }
    }

    if (summary.recentLedger.length) {
      lines.push('', '⚡ <b>Recent Activity</b>');
      for (const item of summary.recentLedger.slice(0, 4)) {
        const sign = Number(item.amount_minor) >= 0 ? '+' : '-';
        const amtText = item.currency === 'XTR'
          ? `${sign}${Math.abs(Number(item.amount_minor))} ⭐`
          : `${sign}${formatMoney(Math.abs(Number(item.amount_minor)), item.currency)}`;
        lines.push(`• ${formatLedgerType(item.entry_type)} · <b>${escapeHtml(amtText)}</b>${item.reference_code ? ` (<code>${escapeHtml(item.reference_code)}</code>)` : ''}`);
      }
    }

    const keyboard = [
      [{
        text: summary.settings.payout_upi_id ? '📲 Change UPI ID' : '📲 Set Payout UPI ID',
        callback_data: 'cc:me_upi',
      }],
    ];
    if (Number(inr.available_minor) >= MIN_WITHDRAWAL_INR_MINOR) {
      keyboard[0].push({ text: '💸 Withdraw Funds', callback_data: 'cc:me_wd' });
    }
    keyboard.push([
      { text: '📜 Full History', callback_data: 'cc:me_hist' },
      { text: '↻ Refresh', callback_data: 'cc:me' },
    ]);
    keyboard.push([{ text: '← Main Menu', callback_data: 'cc:home' }]);

    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, HTML);
  }

  async function showHistory(ctx, edit = false) {
    const summary = await getCreatorWalletSummary(pool, ctx.from.id);
    const wdLines = summary.recentWithdrawals.length
      ? summary.recentWithdrawals.map((w) =>
          `• <b>#${w.id}</b> · ${escapeHtml(formatMoney(w.amount_minor, w.currency))} → <code>${escapeHtml(w.upi_id)}</code> · ${formatWithdrawalStatus(w.status)}` +
          (w.payout_reference ? ` (Ref: <code>${escapeHtml(w.payout_reference)}</code>)` : '') +
          (w.admin_note ? ` — <i>${escapeHtml(w.admin_note)}</i>` : ''),
        )
      : ['<i>No withdrawal requests yet.</i>'];

    const ledgerLines = summary.recentLedger.length
      ? summary.recentLedger.map((item) => {
          const sign = Number(item.amount_minor) >= 0 ? '+' : '-';
          const amtText = item.currency === 'XTR'
            ? `${sign}${Math.abs(Number(item.amount_minor))} ⭐`
            : `${sign}${formatMoney(Math.abs(Number(item.amount_minor)), item.currency)}`;
          return `• ${formatLedgerType(item.entry_type)} · <b>${escapeHtml(amtText)}</b>${item.note ? ` — ${escapeHtml(item.note)}` : ''}`;
        })
      : ['<i>No wallet ledger entries yet.</i>'];

    const text = [
      '📜 <b>Wallet &amp; Withdrawal History</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '💸 <b>Withdrawals (Last 10)</b>',
      ...wdLines,
      '',
      '📊 <b>Ledger (Last 10)</b>',
      ...ledgerLines,
    ].join('\n');

    return renderView(
      ctx,
      text,
      {
        inline_keyboard: [[
          { text: '← Back to /me', callback_data: 'cc:me' },
          { text: '🎛 Main Menu', callback_data: 'cc:home' },
        ]],
      },
      edit,
      true,
      HTML,
    );
  }

  async function promptUpiSetup(ctx, edit = false, continueToWithdraw = false) {
    hooks.clearOtherSessions?.(ctx.from.id);
    const summary = await getCreatorWalletSummary(pool, ctx.from.id);
    setSession(ctx.from.id, { mode: 'set_upi', continueToWithdraw });
    return renderView(
      ctx,
      [
        '📲 <b>Set Payout UPI ID</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `🔹 <b>Current UPI ID:</b> ${summary.settings.payout_upi_id ? `<code>${escapeHtml(summary.settings.payout_upi_id)}</code>` : '<i>Not set</i>'}`,
        '',
        '✍️ Send your UPI ID where manual withdrawals should be transferred:',
        '<i>Example: <code>creator@okicici</code> or <code>yourname@fam</code></i>',
      ].join('\n'),
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:me' }]] },
      edit,
      true,
      HTML,
    );
  }

  async function showWithdrawOptions(ctx, edit = false) {
    const summary = await getCreatorWalletSummary(pool, ctx.from.id);
    if (!summary.settings.payout_upi_id) {
      return promptUpiSetup(ctx, edit, true);
    }
    const available = Number(summary.inrWallet.available_minor);
    if (available < MIN_WITHDRAWAL_INR_MINOR) {
      return renderView(
        ctx,
        `⚠️ <b>Minimum Withdrawal Not Reached</b>\n\nMinimum withdrawal is <b>${escapeHtml(formatMoney(MIN_WITHDRAWAL_INR_MINOR, 'INR'))}</b>.\nYour available balance is <b>${escapeHtml(formatMoney(available, 'INR'))}</b>.\n\n💡 Create paid links with <code>/plink</code> to grow your earnings!`,
        { inline_keyboard: [[{ text: '← Back to /me', callback_data: 'cc:me' }]] },
        edit,
        true,
        HTML,
      );
    }
    return renderView(
      ctx,
      [
        '💸 <b>Withdraw Creator Balance</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `💵 <b>Available:</b> <code>${escapeHtml(formatMoney(available, 'INR'))}</code>`,
        `📲 <b>Destination UPI:</b> <code>${escapeHtml(summary.settings.payout_upi_id)}</code>`,
        '',
        '<blockquote>⏳ Withdrawals are reviewed and transferred manually via UPI by the platform owner.</blockquote>',
        '',
        '👇 <b>Choose a payout option:</b>',
      ].join('\n'),
      {
        inline_keyboard: [
          [{ text: `💸 Withdraw Full (${formatMoney(available, 'INR')})`, callback_data: 'cc:me_wd_all' }],
          [
            { text: '✏ Custom Amount', callback_data: 'cc:me_wd_cus' },
            { text: '📲 Change UPI ID', callback_data: 'cc:me_upi' },
          ],
          [{ text: '← Back to /me', callback_data: 'cc:me' }],
        ],
      },
      edit,
      true,
      HTML,
    );
  }

  async function showWithdrawConfirm(ctx, amountMinor, upiId, edit = false) {
    return renderView(
      ctx,
      [
        '⚠️ <b>Confirm Withdrawal Request</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `💰 <b>Amount:</b> <code>${escapeHtml(formatMoney(amountMinor, 'INR'))}</code>`,
        `📲 <b>UPI ID:</b> <code>${escapeHtml(upiId)}</code>`,
        '',
        '🔒 <i>This amount will be locked while the platform owner transfers it to your UPI ID.</i>',
      ].join('\n'),
      {
        inline_keyboard: [[
          { text: '✅ Confirm Withdrawal', callback_data: `cc:me_wd_ok:${amountMinor}` },
          { text: '✖ Cancel', callback_data: 'cc:me' },
        ]],
      },
      edit,
      true,
      HTML,
    );
  }

  async function showWithdrawalsQueue(ctx, status = 'pending', page = 0, edit = false) {
    if (!isOwnerAdmin(ctx)) {
      return renderView(ctx, '🔒 Restricted to platform owner/admin.', { inline_keyboard: [[{ text: '← Main Menu', callback_data: 'cc:home' }]] }, edit);
    }
    hooks.clearOtherSessions?.(ctx.from.id);
    clearSession(ctx.from.id);

    const safeStatus = ['pending', 'paid', 'rejected', 'all'].includes(status) ? status : 'pending';
    const safePage = Math.max(0, Number(page) || 0);
    const { total, rows } = await listWithdrawalRequests(pool, {
      status: safeStatus,
      limit: WITHDRAW_PAGE_SIZE,
      offset: safePage * WITHDRAW_PAGE_SIZE,
    });
    const pages = Math.max(1, Math.ceil(total / WITHDRAW_PAGE_SIZE));
    const activePage = Math.min(safePage, pages - 1);
    const displayRows = activePage === safePage
      ? rows
      : (await listWithdrawalRequests(pool, {
          status: safeStatus,
          limit: WITHDRAW_PAGE_SIZE,
          offset: activePage * WITHDRAW_PAGE_SIZE,
        })).rows;

    const lines = displayRows.length
      ? displayRows.map((r) => {
          const tag = r.username ? `@${r.username}` : `User #${r.user_telegram_id}`;
          return `<b>#${r.id}</b> · ${formatWithdrawalStatus(r.status)} · <b>${escapeHtml(formatMoney(r.amount_minor, r.currency))}</b>\n👤 ${escapeHtml(tag)} (<code>${escapeHtml(r.user_telegram_id)}</code>) → <code>${escapeHtml(r.upi_id)}</code>`;
        })
      : [`<i>✨ No ${safeStatus === 'all' ? '' : `${safeStatus} `}withdrawal requests found.</i>`];

    const keyboard = [
      [
        { text: safeStatus === 'pending' ? '• Pending' : 'Pending', callback_data: 'cc:wdq:pending:0' },
        { text: safeStatus === 'paid' ? '• Paid' : 'Paid', callback_data: 'cc:wdq:paid:0' },
        { text: safeStatus === 'rejected' ? '• Rejected' : 'Rejected', callback_data: 'cc:wdq:rejected:0' },
        { text: safeStatus === 'all' ? '• All' : 'All', callback_data: 'cc:wdq:all:0' },
      ],
      ...displayRows.map((r) => [{
        text: `${r.status === 'pending' ? '⏳' : r.status === 'paid' ? '✅' : '❌'} #${r.id} · ${formatMoney(r.amount_minor, r.currency)} · ${r.upi_id}`,
        callback_data: `cc:wd_v:${r.id}`,
      }]),
    ];

    const nav = [];
    if (activePage > 0) nav.push({ text: '← Prev', callback_data: `cc:wdq:${safeStatus}:${activePage - 1}` });
    nav.push({ text: '↻ Refresh', callback_data: `cc:wdq:${safeStatus}:${activePage}` });
    if (activePage < pages - 1) nav.push({ text: 'Next →', callback_data: `cc:wdq:${safeStatus}:${activePage + 1}` });
    keyboard.push(nav);
    keyboard.push([{ text: '← Control Center', callback_data: 'cc:home' }]);

    return renderView(
      ctx,
      `💸 <b>Creator Payout Queue (${safeStatus.toUpperCase()})</b> · Page ${activePage + 1}/${pages} (${total})\n━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n\n')}`,
      { inline_keyboard: keyboard },
      edit,
      true,
      HTML,
    );
  }

  async function showWithdrawalDetail(ctx, requestId, edit = false) {
    if (!isOwnerAdmin(ctx)) {
      return renderView(ctx, '🔒 Restricted to platform owner/admin.', { inline_keyboard: [[{ text: '← Main Menu', callback_data: 'cc:home' }]] }, edit);
    }
    const req = await getWithdrawalRequestById(pool, requestId);
    if (!req) return showWithdrawalsQueue(ctx, 'pending', 0, edit);

    const userTag = req.username ? `@${req.username}` : `User #${req.user_telegram_id}`;
    const lines = [
      `💸 <b>Withdrawal Request #${req.id}</b>`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `👤 <b>Creator:</b> ${escapeHtml(userTag)} (<code>${escapeHtml(req.user_telegram_id)}</code>)`,
      `💰 <b>Amount:</b> <code>${escapeHtml(formatMoney(req.amount_minor, req.currency))}</code>`,
      `📲 <b>UPI ID:</b> <code>${escapeHtml(req.upi_id)}</code>`,
      `📌 <b>Status:</b> ${formatWithdrawalStatus(req.status)}`,
      `🕒 <b>Requested:</b> ${escapeHtml(new Date(req.created_at).toISOString())}`,
      ...(req.payout_reference ? [`🧾 <b>UTR / Reference:</b> <code>${escapeHtml(req.payout_reference)}</code>`] : []),
      ...(req.admin_note ? [`📝 <b>Admin Note:</b> ${escapeHtml(req.admin_note)}`] : []),
      ...(req.processed_at ? [`✅ <b>Processed:</b> ${escapeHtml(new Date(req.processed_at).toISOString())}`] : []),
    ];

    const keyboard = [];
    if (req.status === 'pending') {
      keyboard.push([
        { text: '✅ Mark Paid', callback_data: `cc:wd_ok:${req.id}` },
        { text: '✅ Paid + UTR Ref', callback_data: `cc:wd_utr:${req.id}` },
      ]);
      keyboard.push([
        { text: '❌ Reject & Refund', callback_data: `cc:wd_rej:${req.id}` },
      ]);
    }
    keyboard.push([
      { text: '← Payout Queue', callback_data: 'cc:wdq:pending:0' },
      { text: '🎛 Control Center', callback_data: 'cc:home' },
    ]);

    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, HTML);
  }

  async function notifyCreatorWithdrawalOutcome(req, outcome, detailText = null) {
    if (!req?.user_telegram_id) return;
    try {
      const header = outcome === 'paid'
        ? `🎉 <b>Withdrawal #${req.id} Paid!</b>`
        : `❌ <b>Withdrawal #${req.id} Rejected &amp; Refunded</b>`;
      const lines = [
        header,
        '━━━━━━━━━━━━━━━━━━',
        '',
        `💰 <b>Amount:</b> <code>${escapeHtml(formatMoney(req.amount_minor, req.currency))}</code>`,
        `📲 <b>UPI ID:</b> <code>${escapeHtml(req.upi_id)}</code>`,
        ...(outcome === 'paid' && detailText ? [`🧾 <b>UTR / Reference:</b> <code>${escapeHtml(detailText)}</code>`] : []),
        ...(outcome === 'rejected' && detailText ? [`📝 <b>Reason:</b> ${escapeHtml(detailText)}`] : []),
        '',
        outcome === 'paid'
          ? '✨ <i>Your manual UPI payout has been completed!</i>'
          : '↩ <i>The locked funds have been returned to your available /me balance.</i>',
      ];
      await bot.telegram.sendMessage(req.user_telegram_id, lines.join('\n'), HTML);
    } catch (error) {
      logger.warn({ withdrawalId: req.id, userId: req.user_telegram_id, error: error.message }, 'Creator withdrawal outcome DM failed');
    }
  }

  // --- Commands ---
  bot.command('me', async (ctx) => showWallet(ctx, false));
  bot.command('withdraw', async (ctx) => showWithdrawOptions(ctx, false));

  const ownerCmdBot = hooks.adminBot ?? bot;
  ownerCmdBot.command('withdrawals', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return ctx.reply('🔒 This command is restricted to the platform owner.');
    return showWithdrawalsQueue(ctx, 'pending', 0, false);
  });

  ownerCmdBot.command('withdraw_approve', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return ctx.reply('🔒 This command is restricted to the platform owner.');
    const raw = ctx.message?.text?.replace(/^\/\S+\s*/, '').trim() ?? '';
    const [idPart, ...refParts] = raw.split(/\s+/);
    if (!idPart) return ctx.reply('ℹ️ Usage: /admin withdraw_approve <request_id> [utr_reference]');
    try {
      const res = await approveWithdrawalPaid(pool, idPart, ctx.from.id, {
        payoutReference: refParts.join(' ').trim() || null,
      });
      if (!res.alreadyProcessed) {
        await notifyCreatorWithdrawalOutcome(res.request, 'paid', res.request.payout_reference);
      }
      return ctx.reply(
        res.alreadyProcessed
          ? `ℹ️ Withdrawal #${res.request.id} was already marked paid.`
          : `✅ Withdrawal #${res.request.id} marked paid (${formatMoney(res.request.amount_minor, res.request.currency)} → ${res.request.upi_id}).`,
      );
    } catch (error) {
      return ctx.reply('❌ Could not approve withdrawal: ' + error.message);
    }
  });

  ownerCmdBot.command('withdraw_reject', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return ctx.reply('🔒 This command is restricted to the platform owner.');
    const raw = ctx.message?.text?.replace(/^\/\S+\s*/, '').trim() ?? '';
    const [idPart, ...reasonParts] = raw.split(/\s+/);
    if (!idPart) return ctx.reply('ℹ️ Usage: /admin withdraw_reject <request_id> [reason]');
    try {
      const reason = reasonParts.join(' ').trim() || null;
      const res = await rejectWithdrawalRefund(pool, idPart, ctx.from.id, { adminNote: reason });
      if (!res.alreadyProcessed) {
        await notifyCreatorWithdrawalOutcome(res.request, 'rejected', res.request.admin_note);
      }
      return ctx.reply(
        res.alreadyProcessed
          ? `ℹ️ Withdrawal #${res.request.id} was already rejected.`
          : `❌ Withdrawal #${res.request.id} rejected and funds refunded to user #${res.request.user_telegram_id}.`,
      );
    } catch (error) {
      return ctx.reply('❌ Could not reject withdrawal: ' + error.message);
    }
  });

  // --- Creator Actions ---
  bot.action('cc:me', async (ctx) => {
    await safeAnswer(ctx);
    await showWallet(ctx, true);
  });

  bot.action('cc:me_hist', async (ctx) => {
    await safeAnswer(ctx);
    await showHistory(ctx, true);
  });

  bot.action('cc:me_upi', async (ctx) => {
    await safeAnswer(ctx);
    await promptUpiSetup(ctx, true, false);
  });

  bot.action('cc:me_wd', async (ctx) => {
    await safeAnswer(ctx);
    await showWithdrawOptions(ctx, true);
  });

  bot.action('cc:me_wd_all', async (ctx) => {
    const summary = await getCreatorWalletSummary(pool, ctx.from.id);
    if (!summary.settings.payout_upi_id) {
      await safeAnswer(ctx);
      return promptUpiSetup(ctx, true, true);
    }
    const available = Number(summary.inrWallet.available_minor);
    if (available < MIN_WITHDRAWAL_INR_MINOR) {
      return safeAnswer(ctx, `Minimum withdrawal is ${formatMoney(MIN_WITHDRAWAL_INR_MINOR, 'INR')}.`, true);
    }
    await safeAnswer(ctx);
    return showWithdrawConfirm(ctx, available, summary.settings.payout_upi_id, true);
  });

  bot.action('cc:me_wd_cus', async (ctx) => {
    const summary = await getCreatorWalletSummary(pool, ctx.from.id);
    if (!summary.settings.payout_upi_id) {
      await safeAnswer(ctx);
      return promptUpiSetup(ctx, true, true);
    }
    hooks.clearOtherSessions?.(ctx.from.id);
    setSession(ctx.from.id, { mode: 'withdraw_amount' });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      [
        '💸 <b>Custom Withdrawal Amount</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `💵 <b>Available Balance: ${escapeHtml(formatMoney(summary.inrWallet.available_minor, 'INR'))}</b>`,
        `🔹 <b>Minimum:</b> ${escapeHtml(formatMoney(MIN_WITHDRAWAL_INR_MINOR, 'INR'))}`,
        `📲 <b>Destination UPI:</b> <code>${escapeHtml(summary.settings.payout_upi_id)}</code>`,
        '',
        '✍️ Send the INR amount to withdraw (<i>example: <code>150</code> or <code>250.50</code></i>):',
      ].join('\n'),
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:me' }]] },
      true,
      true,
      HTML,
    );
  });

  bot.action(/^cc:me_wd_ok:(\d+)$/, async (ctx) => {
    const amountMinor = Number(ctx.match[1]);
    try {
      const result = await requestWithdrawal(pool, { userId: ctx.from.id, amountMinor, currency: 'INR' });
      await safeAnswer(ctx, 'Withdrawal request submitted! 🎉');
      await notifyAdminsWithdrawalRequest(ctx.telegram, config?.adminIds ?? [], result.withdrawal, ctx.from, logger);
      await renderView(
        ctx,
        [
          `🎉 <b>Withdrawal Request #${result.withdrawal.id} Submitted</b>`,
          '━━━━━━━━━━━━━━━━━━',
          '',
          `💰 <b>Amount:</b> <code>${escapeHtml(formatMoney(result.withdrawal.amount_minor, 'INR'))}</code>`,
          `📲 <b>UPI ID:</b> <code>${escapeHtml(result.withdrawal.upi_id)}</code>`,
          `💵 <b>Remaining Available Balance:</b> ${escapeHtml(formatMoney(result.availableAfterMinor, 'INR'))}`,
          '',
          '🔔 <i>The platform owner has been notified to complete your manual UPI transfer.</i>',
        ].join('\n'),
        { inline_keyboard: [[{ text: '← Back to /me', callback_data: 'cc:me' }]] },
        true,
        true,
        HTML,
      );
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });

  // --- Owner Payout Queue Actions ---
  bot.action(/^cc:wdq:(pending|paid|rejected|all):(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Restricted to platform owner/admin.', true);
    await safeAnswer(ctx);
    await showWithdrawalsQueue(ctx, ctx.match[1], Number(ctx.match[2]), true);
  });

  bot.action(/^cc:wd_v:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Restricted to platform owner/admin.', true);
    await safeAnswer(ctx);
    await showWithdrawalDetail(ctx, Number(ctx.match[1]), true);
  });

  bot.action(/^cc:wd_ok:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Restricted to platform owner/admin.', true);
    const id = Number(ctx.match[1]);
    try {
      const res = await approveWithdrawalPaid(pool, id, ctx.from.id, {});
      if (!res.alreadyProcessed) {
        await notifyCreatorWithdrawalOutcome(res.request, 'paid', null);
      }
      await safeAnswer(ctx, res.alreadyProcessed ? 'Already marked paid.' : 'Withdrawal marked Paid! ✅');
      await showWithdrawalDetail(ctx, id, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });

  bot.action(/^cc:wd_utr:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Restricted to platform owner/admin.', true);
    const id = Number(ctx.match[1]);
    hooks.clearOtherSessions?.(ctx.from.id);
    setSession(ctx.from.id, { mode: 'wd_utr', requestId: id });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `✅ <b>Mark Withdrawal #${id} Paid with UTR</b>\n━━━━━━━━━━━━━━━━━━\n\n✍️ Send the UPI UTR / transaction reference below:`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: `cc:wd_v:${id}` }]] },
      true,
      true,
      HTML,
    );
  });

  bot.action(/^cc:wd_rej:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Restricted to platform owner/admin.', true);
    const id = Number(ctx.match[1]);
    hooks.clearOtherSessions?.(ctx.from.id);
    setSession(ctx.from.id, { mode: 'wd_reject', requestId: id });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `❌ <b>Reject &amp; Refund Withdrawal #${id}</b>\n━━━━━━━━━━━━━━━━━━\n\n✍️ Send a short reason to notify the creator (<i>e.g. "Invalid UPI ID"</i>):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: `cc:wd_v:${id}` }]] },
      true,
      true,
      HTML,
    );
  });

  return {
    getSession,
    clearSession,
    showWallet,
    showWithdrawalsQueue,
    async handleTextMessage(ctx) {
      const text = ctx.message?.text?.trim() ?? '';
      const session = getSession(ctx.from?.id);
      if (!session) return false;
      if (text.startsWith('/')) return false;

      try {
        if (session.mode === 'set_upi') {
          const continueToWithdraw = Boolean(session.continueToWithdraw);
          const updated = await setCreatorPayoutUpi(pool, ctx.from.id, text);
          clearSession(ctx.from.id);
          await ctx.reply(`✅ <b>Payout UPI ID saved: ${escapeHtml(updated.payout_upi_id)}</b>`, HTML);
          if (continueToWithdraw) {
            await showWithdrawOptions(ctx, false);
          } else {
            await showWallet(ctx, false);
          }
          return true;
        }

        if (session.mode === 'withdraw_amount') {
          const amountMinor = parseMinorAmount(text);
          const summary = await getCreatorWalletSummary(pool, ctx.from.id);
          const available = Number(summary.inrWallet.available_minor);
          if (amountMinor < MIN_WITHDRAWAL_INR_MINOR) {
            throw new Error(`Minimum withdrawal is ${formatMoney(MIN_WITHDRAWAL_INR_MINOR, 'INR')}.`);
          }
          if (amountMinor > available) {
            throw new Error(`Insufficient balance. Available: ${formatMoney(available, 'INR')}.`);
          }
          if (!summary.settings.payout_upi_id) {
            throw new Error('Set your payout UPI ID first.');
          }
          clearSession(ctx.from.id);
          await showWithdrawConfirm(ctx, amountMinor, summary.settings.payout_upi_id, false);
          return true;
        }

        if (session.mode === 'wd_utr') {
          if (!isOwnerAdmin(ctx)) {
            clearSession(ctx.from.id);
            await ctx.reply('🔒 Restricted to platform owner/admin.');
            return true;
          }
          const requestId = session.requestId;
          clearSession(ctx.from.id);
          const res = await approveWithdrawalPaid(pool, requestId, ctx.from.id, { payoutReference: text });
          if (!res.alreadyProcessed) {
            await notifyCreatorWithdrawalOutcome(res.request, 'paid', res.request.payout_reference);
          }
          await ctx.reply(`✅ <b>Withdrawal #${requestId} marked paid</b> (UTR: <code>${escapeHtml(res.request.payout_reference)}</code>).`, HTML);
          await showWithdrawalDetail(ctx, requestId, false);
          return true;
        }

        if (session.mode === 'wd_reject') {
          if (!isOwnerAdmin(ctx)) {
            clearSession(ctx.from.id);
            await ctx.reply('🔒 Restricted to platform owner/admin.');
            return true;
          }
          const requestId = session.requestId;
          clearSession(ctx.from.id);
          const res = await rejectWithdrawalRefund(pool, requestId, ctx.from.id, { adminNote: text });
          if (!res.alreadyProcessed) {
            await notifyCreatorWithdrawalOutcome(res.request, 'rejected', res.request.admin_note);
          }
          await ctx.reply(`❌ <b>Withdrawal #${requestId} rejected</b> and balance refunded.`, HTML);
          await showWithdrawalDetail(ctx, requestId, false);
          return true;
        }
      } catch (error) {
        await ctx.reply('❌ Action failed: ' + error.message);
        return true;
      }

      return false;
    },
  };
}
