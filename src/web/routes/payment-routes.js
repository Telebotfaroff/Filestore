// Owner payment management routes extracted from the panel API router.
export async function handleOwnerPaymentRoutes({ req, res, method, pathname, auth, pool, config, parsedUrl, sendJson, readJsonBody, searchPaymentTransactions, listPaymentTransactions, listPaymentMethods, applyVerifiedPayment, adminIds, disablePaymentMethod, enableFamPay, enableTelegramStars }) {
  const respond = (...args) => { sendJson(...args); return true; };
        if (method === 'GET' && pathname === '/api/panel/owner/payments') {
          const q = (parsedUrl.searchParams.get('q') || '').trim();
          const status = (parsedUrl.searchParams.get('status') || 'all').trim();
          const [result, methods] = await Promise.all([
            q ? searchPaymentTransactions(pool, q, 25) : listPaymentTransactions(pool, { limit: 25, offset: 0, status }),
            listPaymentMethods(pool),
          ]);
          return respond(res, 200, {
            total: result.total,
            rows: result.rows,
            paymentMethods: methods.map((m) => ({
              method: m.method,
              isEnabled: Boolean(m.is_enabled),
              lastTestStatus: m.last_test_status,
              lastTestError: m.last_test_error,
              updatedAt: m.updated_at,
            })),
          });
        }
  
        const payReconcileMatch = pathname.match(/^\/api\/panel\/owner\/payments\/(\d+)\/reconcile$/);
        if (method === 'POST' && payReconcileMatch) {
          const txId = Number(payReconcileMatch[1]);
          const result = await applyVerifiedPayment(pool, txId, { adminIds });
          return respond(res, 200, { ok: true, result });
        }
  
        const gwToggleMatch = pathname.match(/^\/api\/panel\/owner\/gateways\/(fampay|telegram_stars)\/toggle$/);
        if (method === 'POST' && gwToggleMatch) {
          const gw = gwToggleMatch[1];
          const body = await readJsonBody(req);
          const enable = Boolean(body.enabled);
          if (!enable) {
            const row = await disablePaymentMethod(pool, gw, auth.userId);
            return respond(res, 200, { ok: true, method: gw, isEnabled: Boolean(row?.is_enabled) });
          }
          if (gw === 'fampay') {
            await enableFamPay(pool, config, auth.userId);
            return respond(res, 200, { ok: true, method: gw, isEnabled: true });
          }
          await enableTelegramStars(pool, auth.userId);
          return respond(res, 200, { ok: true, method: gw, isEnabled: true });
        }
  return false;
}
