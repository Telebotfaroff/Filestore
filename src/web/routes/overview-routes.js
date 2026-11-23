// Creator and owner dashboard overview API routes.
export async function handleOverviewRoutes({ res, method, pathname, auth, ownerScope, pool, state, parsedUrl, sendJson, listShareLinks, listPaidFileLinks, listPaidBatchLinks, listShortenerProviders, listStorageChannels, listForceSubChannels, getCreatorWalletSummary, listPremiumPlans, getShareableBotUsername, getGlobalCheckpointEnabled, getCreatorSettings, getForceSubGlobal, listWithdrawalRequests, getAdminDashboardStats, normalizeOwnerStats, MIN_WITHDRAWAL_INR_MINOR }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/overview') {
        const daysParam = Number(parsedUrl.searchParams.get('days'));
        const statsDays = daysParam === 30 ? 30 : 7;
  
        const [
          shareLinksRes,
          paidFiles,
          paidBatches,
          shorteners,
          storageChannels,
          forceSubChannels,
          walletSummary,
          creatorPlans,
          deliveryBotUsername,
          filesCountRes,
          opensSeriesRes,
          opensTotalRes,
          earningsSeriesRes,
          recentFilesRes,
          checkpointEnabled,
          forceSubEnabled,
          ownBotsRows,
          ownerRawDash,
          ownerPendingWds,
          ownerBotTotalRes,
        ] = await Promise.all([
          listShareLinks(pool, { limit: 6, offset: 0, ownerId: ownerScope }),
          listPaidFileLinks(pool, 100, ownerScope),
          listPaidBatchLinks(pool, 100, ownerScope),
          listShortenerProviders(pool, ownerScope),
          listStorageChannels(pool, ownerScope),
          listForceSubChannels(pool, ownerScope),
          getCreatorWalletSummary(pool, auth.userId),
          listPremiumPlans(pool, auth.isOwner ? null : auth.userId),
          getShareableBotUsername(pool, ownerScope),
          ownerScope === null
            ? pool.query("SELECT COUNT(*)::int AS total FROM files WHERE status = 'active'")
            : pool.query("SELECT COUNT(*)::int AS total FROM files WHERE status = 'active' AND uploaded_by = $1", [ownerScope]),
          ownerScope === null
            ? pool.query(
                `SELECT TO_CHAR(DATE(opened_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                        COUNT(*)::int AS opens
                 FROM link_open_events
                 WHERE opened_at >= NOW() - ($1::int * INTERVAL '1 day')
                 GROUP BY 1`,
                [statsDays],
              ).catch(() => ({ rows: [] }))
            : pool.query(
                `WITH my_links AS (
                   SELECT 'share'::text AS kind, id FROM share_links WHERE created_by = $1
                   UNION ALL
                   SELECT 'paid_file'::text AS kind, id FROM paid_file_links WHERE created_by = $1
                   UNION ALL
                   SELECT 'paid_batch'::text AS kind, id FROM paid_batch_links WHERE created_by = $1
                 )
                 SELECT TO_CHAR(DATE(e.opened_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                        COUNT(*)::int AS opens
                 FROM link_open_events e
                 JOIN my_links ml ON ml.kind = e.link_kind AND ml.id = e.link_id
                 WHERE e.opened_at >= NOW() - ($2::int * INTERVAL '1 day')
                 GROUP BY 1`,
                [ownerScope, statsDays],
              ).catch(() => ({ rows: [] })),
          ownerScope === null
            ? pool.query(
                `SELECT COUNT(*)::int AS total_opens, COUNT(DISTINCT viewer_telegram_id)::int AS unique_viewers
                 FROM link_open_events
                 WHERE opened_at >= NOW() - ($1::int * INTERVAL '1 day')`,
                [statsDays],
              ).catch(() => ({ rows: [] }))
            : pool.query(
                `WITH my_links AS (
                   SELECT 'share'::text AS kind, id FROM share_links WHERE created_by = $1
                   UNION ALL
                   SELECT 'paid_file'::text AS kind, id FROM paid_file_links WHERE created_by = $1
                   UNION ALL
                   SELECT 'paid_batch'::text AS kind, id FROM paid_batch_links WHERE created_by = $1
                 )
                 SELECT COUNT(*)::int AS total_opens, COUNT(DISTINCT e.viewer_telegram_id)::int AS unique_viewers
                 FROM link_open_events e
                 JOIN my_links ml ON ml.kind = e.link_kind AND ml.id = e.link_id
                 WHERE e.opened_at >= NOW() - ($2::int * INTERVAL '1 day')`,
                [ownerScope, statsDays],
              ).catch(() => ({ rows: [] })),
          pool.query(
            `SELECT TO_CHAR(DATE(created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                    COALESCE(SUM(amount_minor), 0)::bigint AS earnings_minor
             FROM wallet_ledger
             WHERE user_telegram_id = $1 AND entry_type = 'sale_credit' AND currency = 'INR'
               AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
             GROUP BY 1`,
            [auth.userId, statsDays],
          ).catch(() => ({ rows: [] })),
          (ownerScope === null
            ? pool.query("SELECT file_code, file_name, file_size, created_at FROM files WHERE status = 'active' ORDER BY created_at DESC LIMIT 4")
            : pool.query("SELECT file_code, file_name, file_size, created_at FROM files WHERE status = 'active' AND uploaded_by = $1 ORDER BY created_at DESC LIMIT 4", [ownerScope])
          ).catch(() => ({ rows: [] })),
          auth.isOwner
            ? getGlobalCheckpointEnabled(pool)
            : getCreatorSettings(pool, auth.userId).then((s) => Boolean(s.checkpoint_enabled)),
          getForceSubGlobal(pool, ownerScope),
          (ownerScope === null
            ? pool.query('SELECT id, username, role, is_enabled, runtime_status FROM delivery_bots WHERE owner_telegram_id IS NULL ORDER BY priority ASC, id ASC')
            : pool.query('SELECT id, username, role, is_enabled, runtime_status FROM delivery_bots WHERE owner_telegram_id = $1 ORDER BY priority ASC, id ASC', [ownerScope])
          ).catch(() => ({ rows: [] })),
          auth.isOwner ? getAdminDashboardStats(pool) : Promise.resolve(null),
          auth.isOwner ? listWithdrawalRequests(pool, { status: 'pending', limit: 1, offset: 0 }) : Promise.resolve(null),
          auth.isOwner ? pool.query('SELECT COUNT(*)::int AS total FROM delivery_bots') : Promise.resolve(null),
        ]);
  
        const opensByDay = new Map((opensSeriesRes.rows || []).map((r) => [r.day, Number(r.opens || 0)]));
        const earningsByDay = new Map((earningsSeriesRes.rows || []).map((r) => [r.day, Number(r.earnings_minor || 0)]));
        const series = [];
        const now = new Date();
        for (let i = statsDays - 1; i >= 0; i -= 1) {
          const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
          const key = dt.toISOString().slice(0, 10);
          series.push({
            date: key,
            label: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
            opens: opensByDay.get(key) || 0,
            earningsMinor: earningsByDay.get(key) || 0,
          });
        }
  
        const recentActivity = [
          ...(recentFilesRes.rows || []).map((f) => ({
            kind: 'file',
            title: 'File Indexed',
            detail: `${f.file_name || f.file_code || 'Media file'}${f.file_size ? ` · ${(Number(f.file_size) / (1024 * 1024)).toFixed(1)} MB` : ''}`,
            createdAt: f.created_at,
          })),
          ...(shareLinksRes.rows || []).slice(0, 4).map((r) => ({
            kind: 'link',
            title: 'Link Created',
            detail: `${r.title || r.primary_file_name || r.link_code} · ${r.link_type === 'batch' ? `${Number(r.item_count || 1)} files` : 'Single'}`,
            createdAt: r.created_at,
          })),
          ...(walletSummary.recentLedger || []).slice(0, 4).map((e) => ({
            kind: 'earning',
            title: e.entry_type === 'sale_credit' ? 'Earnings Credited' : 'Wallet Activity',
            detail: `${e.note || e.reference_code || e.entry_type}`,
            amountMinor: Number(e.amount_minor || 0),
            currency: e.currency || 'INR',
            createdAt: e.created_at,
          })),
          ...(walletSummary.recentWithdrawals || []).slice(0, 4).map((w) => ({
            kind: 'withdrawal',
            title: w.status === 'paid' ? 'Withdrawal Paid' : w.status === 'rejected' ? 'Withdrawal Rejected' : 'Withdrawal Requested',
            detail: `${w.upi_id || 'UPI'} · ${String(w.status || 'pending')}`,
            amountMinor: Number(w.amount_minor || 0),
            currency: w.currency || 'INR',
            status: w.status,
            createdAt: w.created_at,
          })),
        ]
          .filter((item) => item.createdAt)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 5);
  
        const ownBots = ownBotsRows.rows || [];
        const primaryOwnBot = ownBots.find((b) => b.role === 'primary' && b.is_enabled) || ownBots.find((b) => b.is_enabled) || null;
  
        let ownerSummary = null;
        if (auth.isOwner && ownerRawDash) {
          const dash = normalizeOwnerStats(ownerRawDash);
          ownerSummary = {
            trackedUsers: dash.trackedUsers,
            activePremium: dash.activePremium,
            paymentsApplied: dash.paymentsApplied,
            revenueByCurrency: dash.revenueByCurrency,
            pendingWithdrawals: ownerPendingWds?.total ?? 0,
            totalDeliveryBots: Number(ownerBotTotalRes?.rows?.[0]?.total ?? 0),
          };
        }
  
        const inr = walletSummary.inrWallet || {};
        const xtr = walletSummary.xtrWallet || {};
        return respond(res, 200, {
          role: auth.role,
          isOwner: auth.isOwner,
          botUsername: state.botUsername ?? null,
          deliveryBotUsername: deliveryBotUsername ?? null,
          deliveryBots: {
            total: ownBots.length,
            running: ownBots.filter((b) => b.is_enabled && b.runtime_status === 'running').length,
            primaryUsername: primaryOwnBot?.username ?? null,
          },
          counts: {
            files: Number(filesCountRes.rows[0]?.total ?? 0),
            shareLinks: Number(shareLinksRes.total ?? 0),
            paidLinks: paidFiles.length + paidBatches.length,
            activeShorteners: shorteners.filter((s) => s.is_enabled).length,
            totalShorteners: shorteners.length,
            storageChannels: storageChannels.length,
            activeStorageChannels: storageChannels.filter((c) => c.is_enabled).length,
            forceSubChannels: forceSubChannels.length,
            plans: creatorPlans.length,
            ownDeliveryBots: ownBots.length,
          },
          toggles: {
            checkpointEnabled,
            forceSubEnabled,
          },
          wallet: {
            availableMinor: Number(inr.available_minor ?? 0),
            lockedMinor: Number(inr.locked_minor ?? 0),
            totalEarnedMinor: Number(inr.total_earned_minor ?? 0),
            totalWithdrawnMinor: Number(inr.total_withdrawn_minor ?? 0),
            xtrEarnedMinor: Number(xtr.total_earned_minor ?? 0),
            upiId: walletSummary.settings?.payout_upi_id ?? null,
            minWithdrawalMinor: MIN_WITHDRAWAL_INR_MINOR,
          },
          overviewStats: {
            days: statsDays,
            totalOpens: Number(opensTotalRes.rows?.[0]?.total_opens ?? 0),
            uniqueViewers: Number(opensTotalRes.rows?.[0]?.unique_viewers ?? 0),
            totalEarningsMinor: series.reduce((sum, pt) => sum + Number(pt.earningsMinor || 0), 0),
            series,
          },
          recentActivity,
          ownerSummary,
        });
      }
  return false;
}
