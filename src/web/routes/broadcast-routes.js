// Creator/owner broadcast API routes extracted from the panel router.
import {
  createCreatorBroadcast,
  getCreatorBroadcast,
  listCreatorBroadcasts,
  listAllBroadcastsForOwner,
  retryCreatorBroadcast,
  setCreatorBroadcastStatus,
} from '../../broadcast/repository.js';
import { parsePositiveInt } from '../../utils/validation.js';

export async function handleBroadcastRoutes({ method, pathname, auth, pool, parsedUrl, sendJson, readJsonBody }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/broadcasts') {
        if (auth.isOwner) {
          const [botsRes, campaigns] = await Promise.all([
            pool.query(
              `SELECT d.id, d.username, d.role, d.is_enabled, d.runtime_status, d.owner_telegram_id,
                      u.username AS owner_username, u.first_name AS owner_first_name,
                      COALESCE((SELECT COUNT(*)::int FROM delivery_bot_user_activity a WHERE a.delivery_bot_id = d.id), 0) AS total_users
               FROM delivery_bots d
               LEFT JOIN users u ON u.telegram_id = d.owner_telegram_id
               WHERE d.is_enabled = TRUE
               ORDER BY (d.owner_telegram_id IS NULL) ASC, total_users DESC, d.priority ASC, d.id ASC`,
            ).catch(() => ({ rows: [] })),
            listAllBroadcastsForOwner(pool, 30).catch(() => []),
          ]);
          return respond(res, 200, {
            isOwnerMode: true,
            bots: (botsRes.rows || []).map((b) => ({
              id: Number(b.id),
              username: b.username,
              role: b.role,
              isEnabled: Boolean(b.is_enabled),
              runtimeStatus: b.runtime_status,
              isPlatform: b.owner_telegram_id === null || b.owner_telegram_id === undefined,
              ownerId: b.owner_telegram_id == null ? null : String(b.owner_telegram_id),
              ownerUsername: b.owner_username ?? null,
              ownerFirstName: b.owner_first_name ?? null,
              totalUsers: Number(b.total_users || 0),
            })),
            campaigns: (campaigns || []).map((c) => ({
              id: Number(c.id),
              deliveryBotId: Number(c.delivery_bot_id),
              botUsername: c.bot_username ?? null,
              ownerId: c.owner_telegram_id == null ? null : String(c.owner_telegram_id),
              ownerUsername: c.owner_username ?? null,
              ownerFirstName: c.owner_first_name ?? null,
              isPlatformBot: c.bot_owner_telegram_id === null || c.bot_owner_telegram_id === undefined,
              status: c.status,
              totalRecipients: Number(c.total_recipients || 0),
              sentCount: Number(c.sent_count || 0),
              failedCount: Number(c.failed_count || 0),
              lastError: c.last_error ?? null,
              createdAt: c.created_at,
              completedAt: c.completed_at,
            })),
          });
        }
  
        const creatorTarget = auth.userId;
        const [botsRes, campaigns] = await Promise.all([
          pool.query(
            `SELECT d.id, d.username, d.role, d.is_enabled, d.runtime_status,
                    COALESCE((SELECT COUNT(*)::int FROM delivery_bot_user_activity a WHERE a.delivery_bot_id = d.id), 0) AS total_users
             FROM delivery_bots d
             WHERE d.owner_telegram_id = $1
             ORDER BY d.priority ASC, d.id ASC`,
            [creatorTarget],
          ).catch(() => ({ rows: [] })),
          listCreatorBroadcasts(pool, creatorTarget, 20).catch(() => []),
        ]);
        const botNameById = new Map((botsRes.rows || []).map((b) => [Number(b.id), b.username]));
        return respond(res, 200, {
          isOwnerMode: false,
          bots: (botsRes.rows || []).map((b) => ({
            id: Number(b.id),
            username: b.username,
            role: b.role,
            isEnabled: Boolean(b.is_enabled),
            runtimeStatus: b.runtime_status,
            isPlatform: false,
            ownerId: String(creatorTarget),
            totalUsers: Number(b.total_users || 0),
          })),
          campaigns: (campaigns || []).map((c) => ({
            id: Number(c.id),
            deliveryBotId: Number(c.delivery_bot_id),
            botUsername: botNameById.get(Number(c.delivery_bot_id)) ?? null,
            status: c.status,
            totalRecipients: Number(c.total_recipients || 0),
            sentCount: Number(c.sent_count || 0),
            failedCount: Number(c.failed_count || 0),
            lastError: c.last_error ?? null,
            createdAt: c.created_at,
            completedAt: c.completed_at,
          })),
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/broadcasts') {
        const body = await readJsonBody(req);
        const deliveryBotId = parsePositiveInt(body.deliveryBotId, 'Delivery Bot ID');
        const messageText = String(body.messageText || '').trim();
        if (!messageText || messageText.length > 4000) {
          return respond(res, 400, { error: 'Broadcast message must be 1–4000 characters.' });
        }
        const buttons = [];
        if (body.buttonText || body.buttonUrl) {
          const btnText = String(body.buttonText || '').trim().slice(0, 64);
          const btnUrlRaw = String(body.buttonUrl || '').trim();
          if (!btnText || !btnUrlRaw) {
            return respond(res, 400, { error: 'Both Button Label and HTTPS URL are required if adding a button.' });
          }
          let parsedBtnUrl;
          try {
            parsedBtnUrl = new URL(btnUrlRaw);
          } catch {
            return respond(res, 400, { error: 'Button URL must be a valid https:// link.' });
          }
          if (parsedBtnUrl.protocol !== 'https:') {
            return respond(res, 400, { error: 'Button URL must start with https://.' });
          }
          buttons.push([{ text: btnText, url: parsedBtnUrl.toString() }]);
        }
  
        let targetOwnerId = auth.userId;
        let allowPlatformBot = false;
        if (auth.isOwner) {
          const botLookup = await pool.query(
            'SELECT id, owner_telegram_id, is_enabled FROM delivery_bots WHERE id = $1 LIMIT 1',
            [deliveryBotId],
          );
          const targetBot = botLookup.rows[0];
          if (!targetBot || !targetBot.is_enabled) {
            return respond(res, 404, { error: 'Selected delivery bot not found or disabled.' });
          }
          if (targetBot.owner_telegram_id === null || targetBot.owner_telegram_id === undefined) {
            allowPlatformBot = true;
            targetOwnerId = auth.userId;
          } else {
            targetOwnerId = Number(targetBot.owner_telegram_id);
          }
        }
  
        const created = await createCreatorBroadcast(pool, {
          ownerTelegramId: targetOwnerId,
          deliveryBotId,
          createdBy: auth.userId,
          messageText,
          buttons,
          allowPlatformBot,
        });
        return respond(res, 201, { ok: true, id: created.id, totalRecipients: created.totalRecipients });
      }
  
      const broadcastActionMatch = pathname.match(/^\/api\/panel\/broadcasts\/(\d+)\/(pause|resume|cancel|retry)$/);
      if (method === 'POST' && broadcastActionMatch) {
        const campaignId = Number(broadcastActionMatch[1]);
        const action = broadcastActionMatch[2];
        const broadcastOwnerScope = auth.isOwner ? null : auth.userId;
        const existing = await getCreatorBroadcast(pool, broadcastOwnerScope, campaignId);
        if (!existing) return respond(res, 404, { error: 'Broadcast campaign not found.' });
        if (action === 'retry') {
          const retried = await retryCreatorBroadcast(pool, broadcastOwnerScope, campaignId);
          return respond(res, 200, { ok: true, retriedCount: retried });
        }
        const targetStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'pending' : 'cancelled';
        const updated = await setCreatorBroadcastStatus(pool, broadcastOwnerScope, campaignId, targetStatus);
        if (!updated) return respond(res, 400, { error: 'Broadcast state could not be updated.' });
        return respond(res, 200, { ok: true, status: targetStatus });
      }
  return false;
}
