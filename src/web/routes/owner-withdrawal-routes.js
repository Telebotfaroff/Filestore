// Platform-owner withdrawal administration API routes.
export async function handleOwnerWithdrawalRoutes({ req, res, method, pathname, auth, pool, state, parsedUrl, sendJson, readJsonBody, listWithdrawalRequests, approveWithdrawalPaid, rejectWithdrawalRefund, notifyWithdrawalOutcome, logger }) {
  const respond = (...args) => { sendJson(...args); return true; };
        if (method === 'GET' && pathname === '/api/panel/owner/withdrawals') {
          const statusParam = parsedUrl.searchParams.get('status') || 'pending';
          const allowed = ['pending', 'paid', 'rejected', 'all'];
          const status = allowed.includes(statusParam) ? statusParam : 'pending';
          const data = await listWithdrawalRequests(pool, { status, limit: 50, offset: 0 });
          return respond(res, 200, {
            status,
            total: data.total,
            rows: data.rows.map((w) => ({
              id: w.id,
              userId: String(w.user_telegram_id),
              username: w.username ?? null,
              firstName: w.first_name ?? null,
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
  
        const wdActionMatch = pathname.match(/^\/api\/panel\/owner\/withdrawals\/(\d+)\/(approve|reject)$/);
        if (method === 'POST' && wdActionMatch) {
          const requestId = Number(wdActionMatch[1]);
          const action = wdActionMatch[2];
          const body = await readJsonBody(req);
          if (action === 'approve') {
            const result = await approveWithdrawalPaid(pool, requestId, auth.userId, {
              payoutReference: body.payoutReference ? String(body.payoutReference).trim().slice(0, 80) : null,
              adminNote: body.adminNote ? String(body.adminNote).trim().slice(0, 200) : null,
            });
            if (state.notifyTelegram && result?.request) {
              void notifyWithdrawalOutcome(state.notifyTelegram, result.request, 'paid', logger).catch(() => {});
            }
            return respond(res, 200, { ok: true, withdrawal: result.request });
          }
          const result = await rejectWithdrawalRefund(pool, requestId, auth.userId, {
            adminNote: body.adminNote ? String(body.adminNote).trim().slice(0, 200) : null,
          });
          if (state.notifyTelegram && result?.request) {
            void notifyWithdrawalOutcome(state.notifyTelegram, result.request, 'rejected', logger).catch(() => {});
          }
          return respond(res, 200, { ok: true, withdrawal: result.request });
        }
  return false;
}
