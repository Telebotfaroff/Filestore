import { formatMoney } from '../utils/validation.js';
import { escapeHtml } from '../bot/telegram-utils.js';

export async function notifyCreatorSale(telegram, creatorCredit, logger = null) {
  if (!telegram || !creatorCredit?.creatorId) return;
  try {
    const fmt = (minor) => (
      creatorCredit.currency === 'XTR'
        ? `${minor} ⭐`
        : formatMoney(minor, creatorCredit.currency)
    );
    const amountText = fmt(creatorCredit.amountMinor);
    const hasFee = Number(creatorCredit.feeAmountMinor || 0) > 0;
    const isPremiumPlan = creatorCredit.saleType === 'premium_plan';
    const heading = isPremiumPlan
      ? '💎 <b>New Premium Plan Sale Credited!</b>'
      : '🎉 <b>New Paid Link Sale Credited!</b>';
    const refLine = isPremiumPlan
      ? (creatorCredit.planName
          ? [`💎 <b>Plan:</b> ${escapeHtml(creatorCredit.planName)} (<code>${escapeHtml(creatorCredit.referenceCode ?? '')}</code>)`]
          : (creatorCredit.referenceCode ? [`💎 <b>Plan Ref:</b> <code>${escapeHtml(creatorCredit.referenceCode)}</code>`] : []))
      : (creatorCredit.referenceCode ? [`🏷 <b>Link Code:</b> <code>${escapeHtml(creatorCredit.referenceCode)}</code>`] : []);
    const amountLines = hasFee
      ? [
          `💵 <b>Sale Price:</b> <code>${escapeHtml(fmt(creatorCredit.grossAmountMinor))}</code>`,
          `🏛 <b>Platform Fee (${escapeHtml(String(creatorCredit.feePercent ?? 0))}%):</b> <code>-${escapeHtml(fmt(creatorCredit.feeAmountMinor))}</code>`,
          `💰 <b>Net Credited:</b> <code>+${escapeHtml(amountText)}</code>`,
        ]
      : [`💰 <b>Amount Added:</b> <code>+${escapeHtml(amountText)}</code>`];
    const lines = [
      heading,
      '━━━━━━━━━━━━━━━━━━',
      '',
      ...amountLines,
      ...refLine,
      ...(creatorCredit.currency === 'INR' && creatorCredit.balanceAfterMinor !== undefined
        ? [`💵 <b>Available Balance: ${escapeHtml(formatMoney(creatorCredit.balanceAfterMinor, 'INR'))}</b>`]
        : []),
      '',
      '💡 <i>Open /me anytime to check your balance or request a UPI withdrawal.</i>',
    ];
    await telegram.sendMessage(creatorCredit.creatorId, lines.join('\n'), { parse_mode: 'HTML' });
  } catch (error) {
    logger?.warn?.({ creatorId: creatorCredit.creatorId, error: error.message }, 'Creator sale notification failed');
  }
}

export async function notifyAdminsWithdrawalRequest(telegram, adminIds, withdrawal, requesterInfo = {}, logger = null) {
  if (!telegram || !Array.isArray(adminIds) || !adminIds.length || !withdrawal) return;
  const userTag = requesterInfo.username ? `@${requesterInfo.username}` : `User #${withdrawal.user_telegram_id}`;
  const text = [
    `💸 <b>New Withdrawal Request #${withdrawal.id}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    '',
    `👤 <b>Creator:</b> ${escapeHtml(userTag)} (<code>${escapeHtml(withdrawal.user_telegram_id)}</code>)`,
    `💰 <b>Amount:</b> <code>${escapeHtml(formatMoney(withdrawal.amount_minor, withdrawal.currency))}</code>`,
    `📲 <b>UPI ID:</b> <code>${escapeHtml(withdrawal.upi_id)}</code>`,
    '',
    '📝 <i>Complete the manual UPI transfer, then tap a button below or open Control Center → 💸 Withdrawals.</i>',
  ].join('\n');
  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Mark Paid', callback_data: `cc:wd_ok:${withdrawal.id}` },
      { text: '❌ Reject & Refund', callback_data: `cc:wd_rej:${withdrawal.id}` },
    ], [
      { text: '📋 View Payout Queue', callback_data: 'cc:wdq:pending:0' },
    ]],
  };
  for (const adminId of adminIds) {
    try {
      await telegram.sendMessage(adminId, text, { parse_mode: 'HTML', reply_markup: replyMarkup });
    } catch (error) {
      logger?.warn?.({ adminId, withdrawalId: withdrawal.id, error: error.message }, 'Owner withdrawal notification failed');
    }
  }
}

export async function notifyWithdrawalOutcome(telegram, withdrawal, outcome, logger = null) {
  if (!telegram || !withdrawal?.user_telegram_id) return;
  try {
    const amountText = formatMoney(withdrawal.amount_minor, withdrawal.currency || 'INR');
    const isPaid = outcome === 'paid';
    const lines = isPaid
      ? [
          `✅ <b>Withdrawal #${withdrawal.id} Paid!</b>`,
          '━━━━━━━━━━━━━━━━━━',
          '',
          `💰 <b>Amount:</b> <code>${escapeHtml(amountText)}</code>`,
          `📲 <b>UPI ID:</b> <code>${escapeHtml(withdrawal.upi_id)}</code>`,
          ...(withdrawal.payout_reference ? [`🧾 <b>UTR / Ref:</b> <code>${escapeHtml(withdrawal.payout_reference)}</code>`] : []),
          ...(withdrawal.admin_note ? [`📝 <b>Note:</b> ${escapeHtml(withdrawal.admin_note)}`] : []),
        ]
      : [
          `❌ <b>Withdrawal #${withdrawal.id} Rejected &amp; Refunded</b>`,
          '━━━━━━━━━━━━━━━━━━',
          '',
          `💰 <b>Refunded Amount:</b> <code>${escapeHtml(amountText)}</code>`,
          `📲 <b>UPI ID:</b> <code>${escapeHtml(withdrawal.upi_id)}</code>`,
          ...(withdrawal.admin_note ? [`📝 <b>Reason:</b> ${escapeHtml(withdrawal.admin_note)}`] : []),
          '',
          '💵 <i>The full amount has been returned to your available wallet balance.</i>',
        ];
    await telegram.sendMessage(withdrawal.user_telegram_id, lines.join('\n'), { parse_mode: 'HTML' });
  } catch (error) {
    logger?.warn?.({ userId: withdrawal.user_telegram_id, withdrawalId: withdrawal.id, error: error.message }, 'Creator withdrawal outcome notification failed');
  }
}
