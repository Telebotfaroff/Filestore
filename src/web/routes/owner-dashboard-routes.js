// Owner analytics, dashboard, and operational settings API routes.
export async function handleOwnerDashboardRoutes({ req, res, method, pathname, auth, pool, parsedUrl, sendJson, readJsonBody, getOwnerLinkAnalytics, getAdminDashboardStats, getOperationalHealth, getPaymentReconciliationStats, getPaymentAnalytics, getRecentDeliveryJobs, getAutoDeleteMinutes, listFailedScheduledDeletions, listPaymentMethods, normalizeOwnerStats, setAutoDeleteMinutes, retryFailedDeliveryJob })n  {
  const respond = (...args) => { sendJson(...args); return true; };
        if (method === 'GET' && pathname === '/api/panel/owner/link-analytics') {
          const rows = await getOwnerLinkAnalytics(pool, 100);
          return respond(res, 200, { total: rows.length, rows: rows.map((r) => ({
            id: Number(r.id), code: r.code, title: r.title, type: r.type, kind: r.kind,
            ownerId: r.created_by == null ? null : String(r.created_by), views: Number(r.views ?? 0),
            uniqueViewers: Number(r.unique_viewers ?? 0), lastOpened: r.last_opened, viewers: r.viewers ?? [],
          })) });
        }
  
        if (method === 'GET' && pathname === '/api/panel/owner/dashboard') {
          const [stats, health, reconciliation, analytics, jobs, autoDeleteMinutes, failedDeletions, methods] = await Promise.all([
            getAdminDashboardStats(pool),
            getOperationalHealth(pool),
            getPaymentReconciliationStats(pool),
            getPaymentAnalytics(pool),
            getRecentDeliveryJobs(pool, 15),
            getAutoDeleteMinutes(pool),
            listFailedScheduledDeletions(pool, 10),
            listPaymentMethods(pool),
          ]);
          return respond(res, 200, {
            stats: normalizeOwnerStats(stats),
            health,
            reconciliation,
            analytics,
            autoDeleteMinutes,
            failedDeletions,
            jobs: jobs.map((j) => ({
              id: j.id,
              status: j.status,
              requesterId: String(j.requester_telegram_id),
              attemptCount: Number(j.attempt_count ?? 0),
              lastError: j.last_error,
              createdAt: j.created_at,
            })),
            paymentMethods: methods.map((m) => ({
              method: m.method,
              isEnabled: Boolean(m.is_enabled),
              lastTestStatus: m.last_test_status,
              lastTestError: m.last_test_error,
              updatedAt: m.updated_at,
            })),
          });
        }
  
        if (method === 'POST' && pathname === '/api/panel/owner/auto-delete') {
          const body = await readJsonBody(req);
          const minutes = Number(body.minutes);
          if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080) {
            return respond(res, 400, { error: 'Minutes must be 0 (off) or 1–10080.' });
          }
          await setAutoDeleteMinutes(pool, minutes, auth.userId);
          return respond(res, 200, { ok: true, autoDeleteMinutes: minutes });
        }
  
        const retryMatch = pathname.match(/^\/api\/panel\/owner\/jobs\/(\d+)\/retry$/);
        if (method === 'POST' && retryMatch) {
          const jobId = Number(retryMatch[1]);
          const retried = await retryFailedDeliveryJob(pool, jobId);
          if (!retried) return respond(res, 404, { error: 'Failed job not found or not eligible for retry.' });
          return respond(res, 200, { ok: true, jobId: retried.id });
        }
  return false;
}
