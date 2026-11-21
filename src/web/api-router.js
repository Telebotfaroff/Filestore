import {
  issueOrRegenerateAccessToken,
  verifyAccessToken,
} from './token-repository.js';
import {
  listShareLinks,
  renameShareLink,
  setShareLinkEnabled,
  deleteShareLink,
  getShareableBotUsername,
  buildShareableUrl,
} from '../storage/share-links-repository.js';
import {
  listPaidFileLinks,
  setPaidFileLinkEnabled,
  deletePaidFileLink,
} from '../paid-files/repository.js';
import {
  listPaidBatchLinks,
  setPaidBatchLinkEnabled,
  deletePaidBatchLink,
} from '../paid-files/batch-repository.js';
import {
  listShortenerProviders,
  addShortenerProvider,
  setShortenerEnabled,
  setShortenerPriority,
  setShortenerDuration,
  removeShortenerProvider,
  normalizeShortenerUrls,
  deriveUniqueShortenerName,
} from '../access/shortener-repository.js';
import {
  listStorageChannels,
  setStorageEnabled,
  setPrimaryStorageChannel,
  removeStorageChannel,
} from '../storage/repository.js';
import {
  listForceSubChannels,
  getForceSubGlobal,
  setForceSubEnabled,
  removeForceSubChannel,
  setForceSubGlobal,
} from '../access/force-sub-repository.js';
import {
  listPremiumPlans,
  upsertPremiumPlan,
  setPremiumPlanEnabled,
  removePremiumPlan,
  grantPremiumMembership,
  revokePremiumMembership,
} from '../premium/repository.js';
import {
  getCreatorSettings,
  setCreatorCheckpointEnabled,
  getCreatorWalletSummary,
  setCreatorPayoutUpi,
  requestWithdrawal,
  listWithdrawalRequests,
  approveWithdrawalPaid,
  rejectWithdrawalRefund,
  MIN_WITHDRAWAL_INR_MINOR,
} from '../wallet/repository.js';
import {
  notifyAdminsWithdrawalRequest,
  notifyWithdrawalOutcome,
} from '../wallet/notifications.js';
import {
  getAdminDashboardStats,
  getPaymentReconciliationStats,
  listPaymentTransactions,
  searchPaymentTransactions,
  getPaymentAnalytics,
} from '../admin/dashboard-repository.js';
import { getOperationalHealth } from '../admin/operational-health.js';
import {
  getRecentDeliveryJobs,
  retryFailedDeliveryJob,
} from '../delivery/repository.js';
import {
  getAutoDeleteMinutes,
  setAutoDeleteMinutes,
  listFailedScheduledDeletions,
} from '../delivery/auto-delete-repository.js';
import {
  listPaymentMethods,
  disablePaymentMethod,
} from '../payments/repository.js';
import { enableFamPay } from '../payments/fampay.js';
import { enableTelegramStars } from '../payments/telegram-stars.js';
import { applyVerifiedPayment } from '../payments/fulfillment-repository.js';
import {
  parsePositiveInt,
  parseTelegramUserId,
  parseMinorAmount,
  parseCurrencyCode,
} from '../utils/validation.js';

const MAX_BODY_BYTES = 64 * 1024;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_FAILURES = 20;

const failedAuthAttempts = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = failedAuthAttempts.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= now) {
    failedAuthAttempts.delete(ip);
    return false;
  }
  return entry.count >= AUTH_MAX_FAILURES;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  if (failedAuthAttempts.size > 1000) {
    for (const [k, v] of failedAuthAttempts.entries()) {
      if (v.resetAt <= now) failedAuthAttempts.delete(k);
    }
  }
  const entry = failedAuthAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    failedAuthAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearAuthFailures(ip) {
  failedAuthAttempts.delete(ip);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request payload too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('JSON object body expected.'), { statusCode: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON payload.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function extractBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice(7).trim();
}

async function getGlobalCheckpointEnabled(pool) {
  const { rows } = await pool.query(
    "SELECT value FROM app_settings WHERE key = 'checkpoint_enabled' LIMIT 1",
  );
  return rows[0]?.value === true || rows[0]?.value === 'true';
}

async function setGlobalCheckpointEnabled(pool, enabled, actorId) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ('checkpoint_enabled', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [enabled ? 'true' : 'false', actorId],
  );
}

function normalizeOwnerStats(raw = {}) {
  const s = raw || {};
  return {
    trackedUsers: Number(s.users_total ?? 0),
    activeUsers7d: Number(s.users_active_7d ?? 0),
    activeFiles: Number(s.files_active ?? 0),
    disabledFiles: Number(s.files_disabled ?? 0),
    storageChannelsActive: Number(s.storage_channels_active ?? 0),
    deliveryBotsActive: Number(s.delivery_bots_active ?? 0),
    jobsPending: Number(s.jobs_pending ?? 0),
    jobsProcessing: Number(s.jobs_processing ?? 0),
    jobsCompleted: Number(s.jobs_completed ?? 0),
    jobsFailed: Number(s.jobs_failed ?? 0),
    activePremium: Number(s.premium_active ?? 0),
    paidFileLinks: Number(s.paid_file_links_active ?? 0),
    paidBatchLinks: Number(s.paid_batch_links_active ?? 0),
    paymentsApplied: Number(s.payments_applied ?? 0),
    revenueByCurrency: s.revenue_by_currency ?? {},
    events24h: Number(s.events_24h ?? 0),
  };
}

export async function handlePanelApiRequest(req, res, state, logger) {
  const parsedUrl = new URL(req.url || '/', 'http://localhost');
  const pathname = parsedUrl.pathname;
  const method = (req.method || 'GET').toUpperCase();
  const pool = state.pool;
  const config = state.config ?? { adminIds: [] };
  const adminIds = config.adminIds ?? [];
  const ip = getClientIp(req);

  if (!pool || pool.isMock) {
    return sendJson(res, 503, { error: 'Database is not connected yet.' });
  }

  // Public info endpoint for the token gate screen (no sensitive data)
  if (method === 'GET' && pathname === '/api/panel/meta') {
    return sendJson(res, 200, {
      app: 'FileStore',
      botUsername: state.botUsername ?? null,
      mode: state.database === 'connected' && state.telegram === 'connected' ? 'live' : 'standby',
    });
  }

  // Token authentication endpoint
  if (method === 'POST' && pathname === '/api/panel/auth') {
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { error: 'Too many failed token attempts. Please wait a few minutes and try again.' });
    }
    try {
      const body = await readJsonBody(req);
      const token = String(body.token || extractBearerToken(req) || '').trim();
      const auth = await verifyAccessToken(pool, token, adminIds);
      if (!auth) {
        recordAuthFailure(ip);
        return sendJson(res, 401, { error: 'Invalid or revoked access token. Get a valid token from the bot with /token.' });
      }
      clearAuthFailures(ip);
      return sendJson(res, 200, {
        authenticated: true,
        user: {
          userId: auth.userId,
          username: auth.username,
          firstName: auth.firstName,
          role: auth.role,
          isOwner: auth.isOwner,
          tokenPrefix: auth.tokenPrefix,
          rotatedAt: auth.rotatedAt,
          lastUsedAt: auth.lastUsedAt,
        },
        botUsername: state.botUsername ?? null,
      });
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message });
    }
  }

  // All remaining /api/panel/* routes require a valid Authorization: Bearer token
  if (isRateLimited(ip)) {
    return sendJson(res, 429, { error: 'Too many failed token attempts. Please wait a few minutes.' });
  }
  const bearer = extractBearerToken(req);
  const auth = await verifyAccessToken(pool, bearer, adminIds);
  if (!auth) {
    recordAuthFailure(ip);
    return sendJson(res, 401, { error: 'Authentication required. Enter your unique bot token.' });
  }
  clearAuthFailures(ip);

  // Tenant scope: creators only ever see/modify their own resources; owner sees global scope
  const ownerScope = auth.isOwner ? null : auth.userId;

  try {
    // ── Rotate own token ────────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/panel/token/regenerate') {
      const issued = await issueOrRegenerateAccessToken(pool, auth.userId, {
        username: auth.username,
        first_name: auth.firstName,
      });
      return sendJson(res, 200, {
        token: issued.token,
        tokenPrefix: issued.prefix,
        rotatedAt: issued.rotatedAt,
      });
    }

    // ── Overview (Creator + Owner quick summary) ────────────────────────
    if (method === 'GET' && pathname === '/api/panel/overview') {
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
      ] = await Promise.all([
        listShareLinks(pool, { limit: 1, offset: 0, ownerId: ownerScope }),
        listPaidFileLinks(pool, 100, ownerScope),
        listPaidBatchLinks(pool, 100, ownerScope),
        listShortenerProviders(pool, ownerScope),
        listStorageChannels(pool, ownerScope),
        listForceSubChannels(pool, ownerScope),
        getCreatorWalletSummary(pool, auth.userId),
        listPremiumPlans(pool, auth.isOwner ? null : auth.userId),
        getShareableBotUsername(pool, ownerScope),
      ]);

      const filesCountRes = ownerScope === null
        ? await pool.query("SELECT COUNT(*)::int AS total FROM files WHERE status = 'active'")
        : await pool.query("SELECT COUNT(*)::int AS total FROM files WHERE status = 'active' AND uploaded_by = $1", [ownerScope]);

      const checkpointEnabled = auth.isOwner
        ? await getGlobalCheckpointEnabled(pool)
        : Boolean((await getCreatorSettings(pool, auth.userId)).checkpoint_enabled);

      const forceSubEnabled = await getForceSubGlobal(pool, ownerScope);

      let ownerSummary = null;
      if (auth.isOwner) {
        const [rawDash, pendingWds] = await Promise.all([
          getAdminDashboardStats(pool),
          listWithdrawalRequests(pool, { status: 'pending', limit: 1, offset: 0 }),
        ]);
        const dash = normalizeOwnerStats(rawDash);
        ownerSummary = {
          trackedUsers: dash.trackedUsers,
          activePremium: dash.activePremium,
          paymentsApplied: dash.paymentsApplied,
          revenueByCurrency: dash.revenueByCurrency,
          pendingWithdrawals: pendingWds.total,
        };
      }

      const inr = walletSummary.inrWallet || {};
      return sendJson(res, 200, {
        role: auth.role,
        isOwner: auth.isOwner,
        botUsername: state.botUsername ?? null,
        deliveryBotUsername: deliveryBotUsername ?? null,
        counts: {
          files: Number(filesCountRes.rows[0]?.total ?? 0),
          shareLinks: Number(shareLinksRes.total ?? 0),
          paidLinks: paidFiles.length + paidBatches.length,
          activeShorteners: shorteners.filter((s) => s.is_enabled).length,
          totalShorteners: shorteners.length,
          storageChannels: storageChannels.length,
          forceSubChannels: forceSubChannels.length,
          plans: creatorPlans.length,
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
          upiId: walletSummary.settings?.payout_upi_id ?? null,
          minWithdrawalMinor: MIN_WITHDRAWAL_INR_MINOR,
        },
        ownerSummary,
      });
    }

    // ── Links (Free Share Links + Paid File Links + Paid Batch Links) ───
    if (method === 'GET' && pathname === '/api/panel/links') {
      const [shareRes, paidFiles, paidBatches, botUsername] = await Promise.all([
        listShareLinks(pool, { limit: 100, offset: 0, ownerId: ownerScope }),
        listPaidFileLinks(pool, 100, ownerScope),
        listPaidBatchLinks(pool, 100, ownerScope),
        getShareableBotUsername(pool, ownerScope),
      ]);

      return sendJson(res, 200, {
        deliveryBotUsername: botUsername ?? null,
        shareLinks: shareRes.rows.map((r) => ({
          id: r.id,
          kind: 'share',
          code: r.link_code,
          linkType: r.link_type,
          title: r.title || r.primary_file_name || r.link_code,
          itemCount: Number(r.item_count ?? 1),
          isEnabled: Boolean(r.is_enabled),
          createdAt: r.created_at,
          url: botUsername ? buildShareableUrl(botUsername, r.link_code) : null,
        })),
        paidFileLinks: paidFiles.map((r) => ({
          id: r.id,
          kind: 'paid_file',
          code: r.public_code,
          title: r.file_name || r.public_code,
          priceMinor: Number(r.price_minor ?? 0),
          currency: r.currency || 'INR',
          isEnabled: Boolean(r.is_enabled),
          expiresAt: r.expires_at,
          createdAt: r.created_at,
          url: botUsername ? `https://t.me/${botUsername}?start=paid_${r.public_code}` : null,
        })),
        paidBatchLinks: paidBatches.map((r) => ({
          id: r.id,
          kind: 'paid_batch',
          code: r.public_code,
          title: r.title || r.public_code,
          itemCount: Number(r.item_count ?? 0),
          priceMinor: Number(r.price_minor ?? 0),
          currency: r.currency || 'INR',
          isEnabled: Boolean(r.is_enabled),
          expiresAt: r.expires_at,
          createdAt: r.created_at,
          url: botUsername ? `https://t.me/${botUsername}?start=batch_${r.public_code}` : null,
        })),
      });
    }

    const linkMatch = pathname.match(/^\/api\/panel\/links\/(share|paid_file|paid_batch)\/(\d+)$/);
    if (linkMatch) {
      const kind = linkMatch[1];
      const id = Number(linkMatch[2]);
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        let updated = null;
        if (kind === 'share') {
          if (typeof body.title === 'string' && body.title.trim()) {
            updated = await renameShareLink(pool, id, body.title.trim(), ownerScope);
          }
          if (typeof body.isEnabled === 'boolean') {
            updated = await setShareLinkEnabled(pool, id, body.isEnabled, ownerScope);
          }
        } else if (kind === 'paid_file' && typeof body.isEnabled === 'boolean') {
          updated = await setPaidFileLinkEnabled(pool, id, body.isEnabled, ownerScope);
        } else if (kind === 'paid_batch' && typeof body.isEnabled === 'boolean') {
          updated = await setPaidBatchLinkEnabled(pool, id, body.isEnabled, ownerScope);
        }
        if (!updated) return sendJson(res, 404, { error: 'Link not found or no valid change provided.' });
        return sendJson(res, 200, { ok: true, id: updated.id });
      }
      if (method === 'DELETE') {
        let deleted = null;
        if (kind === 'share') deleted = await deleteShareLink(pool, id, ownerScope);
        else if (kind === 'paid_file') deleted = await deletePaidFileLink(pool, id, ownerScope);
        else if (kind === 'paid_batch') deleted = await deletePaidBatchLink(pool, id, ownerScope);
        if (!deleted) return sendJson(res, 404, { error: 'Link not found.' });
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── Shorteners ──────────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/panel/shorteners') {
      const [providers, checkpointEnabled] = await Promise.all([
        listShortenerProviders(pool, ownerScope),
        auth.isOwner
          ? getGlobalCheckpointEnabled(pool)
          : getCreatorSettings(pool, auth.userId).then((s) => Boolean(s.checkpoint_enabled)),
      ]);
      return sendJson(res, 200, {
        checkpointEnabled,
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          baseUrl: p.base_url,
          apiEndpoint: p.api_endpoint,
          isEnabled: Boolean(p.is_enabled),
          priority: Number(p.priority),
          durationMinutes: Number(p.checkpoint_duration_minutes),
          lastTestStatus: p.last_test_status,
          lastTestError: p.last_test_error,
          lastTestedAt: p.last_tested_at,
        })),
      });
    }

    if (method === 'POST' && pathname === '/api/panel/shorteners') {
      const body = await readJsonBody(req);
      const baseUrlRaw = String(body.baseUrl || '').trim();
      const apiKey = String(body.apiKey || '').trim();
      const apiEndpointRaw = body.apiEndpoint ? String(body.apiEndpoint).trim() : null;
      if (!baseUrlRaw || apiKey.length < 4) {
        return sendJson(res, 400, { error: 'Base URL and API key (min 4 chars) are required.' });
      }
      const durationMinutes = body.durationMinutes !== undefined ? Number(body.durationMinutes) : 1440;
      const priority = body.priority !== undefined ? Number(body.priority) : 100;
      if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) {
        return sendJson(res, 400, { error: 'Duration must be 1–10080 minutes.' });
      }
      if (!Number.isInteger(priority) || priority < 1 || priority > 100000) {
        return sendJson(res, 400, { error: 'Priority must be 1–100000.' });
      }
      const existing = await listShortenerProviders(pool, ownerScope);
      const urls = normalizeShortenerUrls(baseUrlRaw, apiEndpointRaw);
      const name = String(body.name || '').trim() || deriveUniqueShortenerName(urls.hostname, existing);
      const created = await addShortenerProvider(
        pool,
        config,
        {
          name: name.slice(0, 48),
          baseUrl: urls.baseUrl,
          apiEndpoint: urls.apiEndpoint,
          apiKey,
          durationMinutes,
          priority,
        },
        auth.userId,
        ownerScope,
      );
      return sendJson(res, 201, {
        ok: true,
        provider: {
          id: created.id,
          name: created.name,
          baseUrl: created.base_url,
          apiEndpoint: created.api_endpoint,
          isEnabled: Boolean(created.is_enabled),
          priority: Number(created.priority),
          durationMinutes: Number(created.checkpoint_duration_minutes),
        },
      });
    }

    if (method === 'POST' && pathname === '/api/panel/shorteners/checkpoint') {
      const body = await readJsonBody(req);
      const enabled = Boolean(body.enabled);
      if (auth.isOwner) {
        await setGlobalCheckpointEnabled(pool, enabled, auth.userId);
      } else {
        await setCreatorCheckpointEnabled(pool, auth.userId, enabled);
      }
      return sendJson(res, 200, { ok: true, checkpointEnabled: enabled });
    }

    const shortenerMatch = pathname.match(/^\/api\/panel\/shorteners\/(\d+)$/);
    if (shortenerMatch) {
      const id = Number(shortenerMatch[1]);
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        let row = null;
        if (typeof body.isEnabled === 'boolean') {
          row = await setShortenerEnabled(pool, id, body.isEnabled, ownerScope);
        }
        if (body.priority !== undefined) {
          const prio = Number(body.priority);
          if (!Number.isInteger(prio) || prio < 1 || prio > 100000) {
            return sendJson(res, 400, { error: 'Priority must be 1–100000.' });
          }
          row = await setShortenerPriority(pool, id, prio, ownerScope);
        }
        if (body.durationMinutes !== undefined) {
          const mins = Number(body.durationMinutes);
          if (!Number.isInteger(mins) || mins < 1 || mins > 10080) {
            return sendJson(res, 400, { error: 'Duration must be 1–10080 minutes.' });
          }
          row = await setShortenerDuration(pool, id, mins, ownerScope);
        }
        if (!row) return sendJson(res, 404, { error: 'Shortener provider not found.' });
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        const removed = await removeShortenerProvider(pool, id, ownerScope);
        if (!removed) return sendJson(res, 404, { error: 'Shortener provider not found.' });
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── Channels (Storage + Force-Sub) ──────────────────────────────────
    if (method === 'GET' && pathname === '/api/panel/channels') {
      const [storage, forceSub, forceSubEnabled] = await Promise.all([
        listStorageChannels(pool, ownerScope),
        listForceSubChannels(pool, ownerScope),
        getForceSubGlobal(pool, ownerScope),
      ]);
      return sendJson(res, 200, {
        forceSubEnabled,
        storageChannels: storage.map((c) => ({
          id: c.id,
          chatId: String(c.telegram_chat_id),
          title: c.title || c.username || String(c.telegram_chat_id),
          username: c.username,
          isEnabled: Boolean(c.is_enabled),
          isPrimary: c.role === 'primary' || Boolean(c.is_primary),
          lastTestStatus: c.last_test_status,
        })),
        forceSubChannels: forceSub.map((c) => ({
          id: c.id,
          chatId: String(c.telegram_chat_id),
          title: c.title || c.username || String(c.telegram_chat_id),
          joinUrl: c.join_url,
          isEnabled: Boolean(c.is_enabled),
        })),
      });
    }

    if (method === 'POST' && pathname === '/api/panel/channels/force-sub-global') {
      const body = await readJsonBody(req);
      const enabled = Boolean(body.enabled);
      await setForceSubGlobal(pool, enabled, auth.userId, ownerScope);
      return sendJson(res, 200, { ok: true, forceSubEnabled: enabled });
    }

    const channelMatch = pathname.match(/^\/api\/panel\/channels\/(storage|force_sub)\/(-?\d+)$/);
    if (channelMatch) {
      const type = channelMatch[1];
      const targetId = Number(channelMatch[2]);
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (type === 'storage') {
          if (body.isPrimary === true) {
            const row = await setPrimaryStorageChannel(pool, targetId, ownerScope);
            if (!row) return sendJson(res, 404, { error: 'Storage channel not found.' });
            return sendJson(res, 200, { ok: true });
          }
          if (typeof body.isEnabled === 'boolean') {
            const row = await setStorageEnabled(pool, targetId, body.isEnabled, ownerScope);
            if (!row) return sendJson(res, 404, { error: 'Storage channel not found.' });
            return sendJson(res, 200, { ok: true });
          }
        } else if (type === 'force_sub' && typeof body.isEnabled === 'boolean') {
          const row = await setForceSubEnabled(pool, targetId, body.isEnabled, ownerScope);
          if (!row) return sendJson(res, 404, { error: 'Force-sub channel not found.' });
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 400, { error: 'Unsupported channel update.' });
      }
      if (method === 'DELETE') {
        const removed = type === 'storage'
          ? await removeStorageChannel(pool, targetId, ownerScope)
          : await removeForceSubChannel(pool, targetId, ownerScope);
        if (!removed) return sendJson(res, 404, { error: 'Channel not found.' });
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── Creator Premium Plans ───────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/panel/plans') {
      const scope = auth.isOwner ? null : auth.userId;
      const [plans, botUsername] = await Promise.all([
        listPremiumPlans(pool, scope),
        getShareableBotUsername(pool, scope),
      ]);
      return sendJson(res, 200, {
        scope: auth.isOwner ? 'platform' : 'creator',
        checkoutLink: !auth.isOwner && botUsername ? `https://t.me/${botUsername}?start=cprem_${auth.userId}` : null,
        plans: plans.map((p) => ({
          id: p.id,
          name: p.name,
          priceMinor: Number(p.price_minor),
          currency: p.currency,
          durationDays: Number(p.duration_days),
          isEnabled: Boolean(p.is_enabled),
          createdAt: p.created_at,
        })),
      });
    }

    if (method === 'POST' && pathname === '/api/panel/plans') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name || name.length > 60) return sendJson(res, 400, { error: 'Plan name must be 1–60 characters.' });
      const durationDays = Number(body.durationDays);
      if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
        return sendJson(res, 400, { error: 'Duration must be 1–3650 days.' });
      }
      const currency = auth.isOwner ? parseCurrencyCode(body.currency || 'INR') : 'INR';
      const priceMinor = parseMinorAmount(body.price, { allowZero: auth.isOwner });
      if (!auth.isOwner && priceMinor < 100) {
        return sendJson(res, 400, { error: 'Creator plan price must be at least 1.00 INR.' });
      }
      const planScope = auth.isOwner ? null : auth.userId;
      const saved = await upsertPremiumPlan(
        pool,
        { name, priceMinor, currency, durationDays, enabled: true },
        auth.userId,
        planScope,
      );
      return sendJson(res, 201, { ok: true, plan: saved });
    }

    const planMatch = pathname.match(/^\/api\/panel\/plans\/(\d+)$/);
    if (planMatch) {
      const id = Number(planMatch[1]);
      const planScope = auth.isOwner ? null : auth.userId;
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (typeof body.isEnabled !== 'boolean') {
          return sendJson(res, 400, { error: 'isEnabled boolean required.' });
        }
        const updated = await setPremiumPlanEnabled(pool, id, body.isEnabled, planScope);
        if (!updated) return sendJson(res, 404, { error: 'Plan not found.' });
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        const removed = await removePremiumPlan(pool, id, planScope);
        if (!removed) return sendJson(res, 404, { error: 'Plan not found.' });
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── Creator Wallet & Withdrawals ────────────────────────────────────
    if (method === 'GET' && pathname === '/api/panel/wallet') {
      const summary = await getCreatorWalletSummary(pool, auth.userId);
      const inr = summary.inrWallet || {};
      return sendJson(res, 200, {
        wallet: {
          availableMinor: Number(inr.available_minor ?? 0),
          lockedMinor: Number(inr.locked_minor ?? 0),
          totalEarnedMinor: Number(inr.total_earned_minor ?? 0),
          totalWithdrawnMinor: Number(inr.total_withdrawn_minor ?? 0),
          upiId: summary.settings?.payout_upi_id ?? null,
        },
        minWithdrawalMinor: MIN_WITHDRAWAL_INR_MINOR,
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
      return sendJson(res, 200, { ok: true, upiId: saved.payout_upi_id });
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
      return sendJson(res, 201, {
        ok: true,
        withdrawal: result.withdrawal,
        availableAfterMinor: result.availableAfterMinor,
        lockedAfterMinor: result.lockedAfterMinor,
      });
    }

    // ── Owner-Only Routes (/api/panel/owner/*) ──────────────────────────
    if (pathname.startsWith('/api/panel/owner/')) {
      if (!auth.isOwner) {
        return sendJson(res, 403, { error: 'Restricted to the platform owner.' });
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
        return sendJson(res, 200, {
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
          return sendJson(res, 400, { error: 'Minutes must be 0 (off) or 1–10080.' });
        }
        await setAutoDeleteMinutes(pool, minutes, auth.userId);
        return sendJson(res, 200, { ok: true, autoDeleteMinutes: minutes });
      }

      const retryMatch = pathname.match(/^\/api\/panel\/owner\/jobs\/(\d+)\/retry$/);
      if (method === 'POST' && retryMatch) {
        const jobId = Number(retryMatch[1]);
        const retried = await retryFailedDeliveryJob(pool, jobId);
        if (!retried) return sendJson(res, 404, { error: 'Failed job not found or not eligible for retry.' });
        return sendJson(res, 200, { ok: true, jobId: retried.id });
      }

      if (method === 'GET' && pathname === '/api/panel/owner/withdrawals') {
        const statusParam = parsedUrl.searchParams.get('status') || 'pending';
        const allowed = ['pending', 'paid', 'rejected', 'all'];
        const status = allowed.includes(statusParam) ? statusParam : 'pending';
        const data = await listWithdrawalRequests(pool, { status, limit: 50, offset: 0 });
        return sendJson(res, 200, {
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
          return sendJson(res, 200, { ok: true, withdrawal: result.request });
        }
        const result = await rejectWithdrawalRefund(pool, requestId, auth.userId, {
          adminNote: body.adminNote ? String(body.adminNote).trim().slice(0, 200) : null,
        });
        if (state.notifyTelegram && result?.request) {
          void notifyWithdrawalOutcome(state.notifyTelegram, result.request, 'rejected', logger).catch(() => {});
        }
        return sendJson(res, 200, { ok: true, withdrawal: result.request });
      }

      if (method === 'GET' && pathname === '/api/panel/owner/payments') {
        const q = (parsedUrl.searchParams.get('q') || '').trim();
        const status = (parsedUrl.searchParams.get('status') || 'all').trim();
        if (q) {
          const result = await searchPaymentTransactions(pool, q, 25);
          return sendJson(res, 200, { total: result.total, rows: result.rows });
        }
        const result = await listPaymentTransactions(pool, { limit: 25, offset: 0, status });
        return sendJson(res, 200, { total: result.total, rows: result.rows });
      }

      const payReconcileMatch = pathname.match(/^\/api\/panel\/owner\/payments\/(\d+)\/reconcile$/);
      if (method === 'POST' && payReconcileMatch) {
        const txId = Number(payReconcileMatch[1]);
        const result = await applyVerifiedPayment(pool, txId, { adminIds });
        return sendJson(res, 200, { ok: true, result });
      }

      const gwToggleMatch = pathname.match(/^\/api\/panel\/owner\/gateways\/(fampay|telegram_stars)\/toggle$/);
      if (method === 'POST' && gwToggleMatch) {
        const gw = gwToggleMatch[1];
        const body = await readJsonBody(req);
        const enable = Boolean(body.enabled);
        if (!enable) {
          const row = await disablePaymentMethod(pool, gw, auth.userId);
          return sendJson(res, 200, { ok: true, method: gw, isEnabled: Boolean(row?.is_enabled) });
        }
        if (gw === 'fampay') {
          await enableFamPay(pool, config, auth.userId);
          return sendJson(res, 200, { ok: true, method: gw, isEnabled: true });
        }
        await enableTelegramStars(pool, auth.userId);
        return sendJson(res, 200, { ok: true, method: gw, isEnabled: true });
      }

      if (method === 'POST' && pathname === '/api/panel/owner/premium/grant') {
        const body = await readJsonBody(req);
        const userId = parseTelegramUserId(body.userId);
        const planId = parsePositiveInt(body.planId, 'Plan ID');
        const days = body.days !== undefined && String(body.days).trim() !== '' ? Number(body.days) : null;
        if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
          return sendJson(res, 400, { error: 'Override days must be 1–3650.' });
        }
        const result = await grantPremiumMembership(pool, userId, planId, days, auth.userId);
        return sendJson(res, 200, { ok: true, result });
      }

      if (method === 'POST' && pathname === '/api/panel/owner/premium/revoke') {
        const body = await readJsonBody(req);
        const userId = parseTelegramUserId(body.userId);
        const revokedCount = await revokePremiumMembership(pool, userId, auth.userId);
        return sendJson(res, 200, { ok: true, revokedCount });
      }
    }

    return sendJson(res, 404, { error: 'API route not found.' });
  } catch (error) {
    const statusCode = error.statusCode || 400;
    if (statusCode >= 500) {
      logger?.error?.({ pathname, error: error.message }, 'Web panel API error');
    }
    return sendJson(res, statusCode, { error: error.message || 'Operation failed.' });
  }
}
