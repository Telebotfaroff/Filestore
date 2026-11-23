// Owner-only manual premium membership management routes.
export async function handleOwnerPremiumRoutes({ res, method, pathname, auth, pool, sendJson, readJsonBody, parseTelegramUserId, parsePositiveInt, grantPremiumMembership, revokePremiumMembership })n  {
  const respond = (...args) => { sendJson(...args); return true; };
        if (method === 'POST' && pathname === '/api/panel/owner/premium/grant') {
          const body = await readJsonBody(req);
          const userId = parseTelegramUserId(body.userId);
          const planId = parsePositiveInt(body.planId, 'Plan ID');
          const days = body.days !== undefined && String(body.days).trim() !== '' ? Number(body.days) : null;
          if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
            return respond(res, 400, { error: 'Override days must be 1–3650.' });
          }
          const result = await grantPremiumMembership(pool, userId, planId, days, auth.userId);
          return respond(res, 200, { ok: true, result });
        }
  
        if (method === 'POST' && pathname === '/api/panel/owner/premium/revoke') {
          const body = await readJsonBody(req);
          const userId = parseTelegramUserId(body.userId);
          const revokedCount = await revokePremiumMembership(pool, userId, auth.userId);
          return respond(res, 200, { ok: true, revokedCount });
        }
  return false;
}
