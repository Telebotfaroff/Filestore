// Platform-owner delivery-bot administration API routes.
export async function handleOwnerBotRoutes({ req, res, method, pathname, auth, pool, state, parsedUrl, sendJson, readJsonBody, serializeOwnerBotRow, listAllDeliveryBotsForOwner, getBotSlotSettings, getDeliveryBotDetailsForOwner, updateDeliveryBotForOwner, saveDeliveryBotStartConfig, serializeStartConfig, cacheDeletePrefix }) {
  const respond = (...args) => { sendJson(...args); return true; };
        if (method === 'GET' && pathname === '/api/panel/owner/bots') {
          const q = parsedUrl.searchParams.get('q') || '';
          const scope = parsedUrl.searchParams.get('scope') || 'all';
          const status = parsedUrl.searchParams.get('status') || 'all';
          const [data, botSlotSettings] = await Promise.all([
            listAllDeliveryBotsForOwner(pool, { q, scope, status }),
            getBotSlotSettings(pool),
          ]);
          const rows = data.rows.map(serializeOwnerBotRow);
          return respond(res, 200, {
            total: rows.length,
            botSlotSettings,
            summary: {
              totalBots: rows.length,
              runningBots: rows.filter((r) => r.isEnabled && r.runtimeStatus === 'running').length,
              platformBots: rows.filter((r) => r.isPlatform).length,
              creatorBots: rows.filter((r) => !r.isPlatform).length,
              uniqueBotUsers: data.uniqueBotUsers,
            },
            rows,
          });
        }
  
        const ownerBotTestMatch = pathname.match(/^\/api\/panel\/owner\/bots\/(\d+)\/test$/);
        if (method === 'POST' && ownerBotTestMatch) {
          const botId = Number(ownerBotTestMatch[1]);
          if (!state.deliveryManager?.test) {
            return respond(res, 503, { error: 'Delivery bot runtime manager is not active.' });
          }
          const result = await state.deliveryManager.test(botId);
          return respond(res, 200, {
            ok: true,
            bot: { id: result.bot.id, username: result.bot.username, firstName: result.bot.first_name },
            checks: result.checks,
          });
        }
  
        const ownerBotStartMatch = pathname.match(/^\/api\/panel\/owner\/bots\/(\d+)\/start-message$/);
        if (method === 'DELETE' && ownerBotStartMatch) {
          const botId = Number(ownerBotStartMatch[1]);
          const cleared = await saveDeliveryBotStartConfig(pool, botId, undefined, { clear: true });
          if (!cleared) return respond(res, 404, { error: 'Delivery bot not found.' });
          return respond(res, 200, { ok: true, ...serializeStartConfig(cleared) });
        }
  
        const ownerBotMatch = pathname.match(/^\/api\/panel\/owner\/bots\/(\d+)$/);
        if (ownerBotMatch) {
          const botId = Number(ownerBotMatch[1]);
          if (method === 'GET') {
            const details = await getDeliveryBotDetailsForOwner(pool, botId);
            if (!details) return respond(res, 404, { error: 'Delivery bot not found.' });
            return respond(res, 200, {
              bot: serializeOwnerBotRow(details.bot),
              recentUsers: details.recentUsers.map((u) => ({
                userId: String(u.telegram_user_id),
                username: u.username ?? null,
                firstName: u.first_name ?? null,
                lastName: u.last_name ?? null,
                isBlocked: Boolean(u.is_blocked),
                interactions: Number(u.interaction_count ?? 0),
                firstSeenAt: u.first_seen_at,
                lastSeenAt: u.last_seen_at,
              })),
              storageChannels: details.storageChannels.map((c) => ({
                id: Number(c.id),
                chatId: String(c.telegram_chat_id),
                title: c.title || c.username || String(c.telegram_chat_id),
                role: c.role,
                isEnabled: Boolean(c.is_enabled),
                lastTestStatus: c.last_test_status,
              })),
              forceSubChannels: details.forceSubChannels.map((c) => ({
                id: Number(c.id),
                chatId: String(c.telegram_chat_id),
                title: c.title || String(c.telegram_chat_id),
                joinUrl: c.join_url,
                isEnabled: Boolean(c.is_enabled),
                lastTestStatus: c.last_test_status,
              })),
            });
          }
          if (method === 'PATCH') {
            const body = await readJsonBody(req);
            const updated = await updateDeliveryBotForOwner(pool, botId, body, state.deliveryManager ?? null);
            if (!updated) return respond(res, 404, { error: 'Delivery bot not found.' });
            return respond(res, 200, { ok: true, bot: serializeOwnerBotRow(updated.bot) });
          }
          if (method === 'DELETE') {
            let removed = false;
            if (state.deliveryManager?.remove) {
              removed = await state.deliveryManager.remove(botId);
            } else {
              const del = await pool.query('DELETE FROM delivery_bots WHERE id = $1 RETURNING id', [botId]);
              removed = del.rowCount > 0;
              cacheDeletePrefix('delivery-bots:');
            }
            if (!removed) return respond(res, 404, { error: 'Delivery bot not found.' });
            return respond(res, 200, { ok: true });
          }
        }
  return false;
}
