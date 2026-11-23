// Creator/owner dashboard user directory API routes.
export async function handleCreatorRoutes({ res, method, pathname, auth, pool, parsedUrl, sendJson, listPanelUsers, listPanelPremiumMembers }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/users') {
        const q = parsedUrl.searchParams.get('q') || '';
        const botId = parsedUrl.searchParams.get('botId') || '';
        const rows = await listPanelUsers(pool, { isOwner: auth.isOwner, userId: auth.userId, q, botId });
        return respond(res, 200, { total: rows.length, rows: rows.map((u) => ({
          userId: String(u.telegram_id), username: u.username ?? null, firstName: u.first_name ?? null,
          lastName: u.last_name ?? null, languageCode: u.language_code ?? null, isBlocked: Boolean(u.is_blocked),
          joinedAt: u.bot_first_seen ?? u.started_at, lastSeenAt: u.bot_last_seen ?? u.last_seen_at,
          botsUsed: Number(u.bots_used ?? 0), botNames: u.bot_names ?? [], interactions: Number(u.bot_interactions ?? 0), premiumActive: Boolean(u.premium_active),
        })) });
      }
      if (method === 'GET' && pathname === '/api/panel/premium-members') {
        const q = parsedUrl.searchParams.get('q') || '';
        const status = parsedUrl.searchParams.get('status') || 'all';
        const rows = await listPanelPremiumMembers(pool, { isOwner: auth.isOwner, userId: auth.userId, q, status });
        return respond(res, 200, { total: rows.length, rows: rows.map((m) => ({
          membershipId: Number(m.id), userId: String(m.user_telegram_id), username: m.username ?? null,
          firstName: m.first_name ?? null, lastName: m.last_name ?? null, ownerId: m.owner_telegram_id === null ? null : String(m.owner_telegram_id),
          planName: m.plan_name ?? 'Premium', status: m.status, startedAt: m.starts_at, expiresAt: m.expires_at,
          daysRemaining: m.days_remaining === null ? null : Number(m.days_remaining), source: m.source,
        })) });
      }
  return false;
}
