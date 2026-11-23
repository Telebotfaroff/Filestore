// Creator wallet API endpoints extracted from the panel router.
export async function handleWalletRoutes({ method, pathname, auth, pool, state, sendJson, readJsonBody, getCreatorWalletSummary, getUserReferralSummary, getPlatformFeeSettings, MIN_WITHDRAWAL_INR_MINOR, setCreatorPayoutUpi, parseMinorAmount, requestWithdrawal, notifyAdminsWithdrawalRequest, adminIds, logger }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/wallet') {
        const [summary, referral, platformFees] = await Promise.all([
          getCreatorWalletSummary(pool, auth.userId),
          getUserReferralSummary(pool, auth.userId, state.botUsername ?? null).catch(() => null),
          getPlatformFeeSettings(pool).catch(() => null),
        ]);
        const inr = summary.inrWallet || {};
        return respond(res, 200, {
          wallet: {
            availableMinor: Number(inr.available_minor ?? 0),
            lockedMinor: Number(inr.locked_minor ?? 0),
            totalEarnedMinor: Number(inr.total_earned_minor ?? 0),
            totalWithdrawnMinor: Number(inr.total_withdrawn_minor ?? 0),
            upiId: summary.settings?.payout_upi_id ?? null,
          },
          minWithdrawalMinor: MIN_WITHDRAWAL_INR_MINOR,
          referral,
          platformFees,
          recentLedger: summary.recentLedger.map((e) => ({
            id: e.id,
            entryType: e.entry_type,
            amountMinor: Number(e.amount_minor),
            currency: e.currency,
            description: e.note || e.reference_code || '',
            createdAt: e.created_at,
          })),
          recentWithdrawals: summary.recentWithdrawals.map((w) => ({
            id: w.id,
            amountMinor: Number(w.amount_minor),
            currency: w.currency,
            upiId: w.upi_id,
            status: w.status,
            payoutReference: w.payout_reference,
            adminNote: w.admin_note,
            createdAt: w.created_at,
            processedAt: w.processed_at,
          })),
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/wallet/upi') {
        const body = await readJsonBody(req);
        const saved = await setCreatorPayoutUpi(pool, auth.userId, String(body.upiId || ''));
        return respond(res, 200, { ok: true, upiId: saved.payout_upi_id });
      }
  
      if (method === 'POST' && pathname === '/api/panel/wallet/withdraw') {
        const body = await readJsonBody(req);
        const amountMinor = body.amount !== undefined && String(body.amount).trim() !== ''
          ? parseMinorAmount(body.amount, { allowZero: false })
          : null;
        const result = await requestWithdrawal(pool, {
          userId: auth.userId,
          amountMinor,
          upiId: body.upiId ? String(body.upiId).trim() : null,
        });
        if (state.notifyTelegram && result?.withdrawal) {
          void notifyAdminsWithdrawalRequest(
            state.notifyTelegram,
            adminIds,
            result.withdrawal,
            { username: auth.username, first_name: auth.firstName },
            logger,
          ).catch(() => {});
        }
        return respond(res, 201, {
          ok: true,
          withdrawal: result.withdrawal,
          availableAfterMinor: result.availableAfterMinor,
          lockedAfterMinor: result.lockedAfterMinor,
        });
      }
  return false;
}
