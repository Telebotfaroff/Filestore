import {
  getClientIp, isRateLimited, recordAuthFailure, clearAuthFailures,
  sendJson, readJsonBody, extractBearerToken,
} from './http-utils.js';
import { getOwnerLinkAnalytics } from './link-analytics-repository.js';
import { listPanelUsers, listPanelPremiumMembers } from './user-management-repository.js';
import {
  listAllDeliveryBotsForOwner,
  getDeliveryBotDetailsForOwner,
  updateDeliveryBotForOwner,
} from './owner-bots-repository.js';
import { cached, cacheDeletePrefix } from '../utils/cache.js';
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
  disableUnusedFilesForOwner,
  disableFileByIdOrCode,
} from '../storage/file-cleanup.js';
import {
  listPaidFileLinks,
  setPaidFileLinkEnabled,
  updatePaidFileLinkPrice,
  deletePaidFileLink,
} from '../paid-files/repository.js';
import {
  listPaidBatchLinks,
  setPaidBatchLinkEnabled,
  updatePaidBatchLink,
  deletePaidBatchLink,
} from '../paid-files/batch-repository.js';
import {
  listShortenerProviders,
  getShortenerProviderById,
  addShortenerProvider,
  updateShortenerName,
  updateShortenerCredentials,
  decryptShortenerApiKey,
  markShortenerTest,
  setShortenerEnabled,
  setShortenerPriority,
  setShortenerDuration,
  removeShortenerProvider,
  normalizeShortenerUrls,
  deriveUniqueShortenerName,
} from '../access/shortener-repository.js';
import { shortenUrlWithProvider } from '../access/checkpoint-engine.js';
import { parseStorageIdentifier } from '../storage/identifier.js';
import {
  validateStorageChannel,
  validateForceSubChannel,
} from '../bot/telegram-utils.js';
import {
  listStorageChannels,
  getStorageChannelForOwner,
  saveStorageChannel,
  updateStorageTest,
  setStorageEnabled,
  setPrimaryStorageChannel,
  removeStorageChannel,
} from '../storage/repository.js';
import {
  listForceSubChannels,
  getForceSubGlobal,
  saveForceSubChannel,
  setForceSubEnabled,
  removeForceSubChannel,
  setForceSubGlobal,
} from '../access/force-sub-repository.js';
import {
  listPremiumPlans,
  getPremiumPlanById,
  upsertPremiumPlan,
  editPremiumPlan,
  setPremiumPlanEnabled,
  removePremiumPlan,
  grantPremiumMembership,
  revokePremiumMembership,
} from '../premium/repository.js';
import { handleBroadcastRoutes } from './routes/broadcast-routes.js';
import { handleWalletRoutes } from './routes/wallet-routes.js';
import { handleOwnerPaymentRoutes } from './routes/payment-routes.js';
import { handlePlanRoutes } from './routes/plan-routes.js';
import { handleCreatorRoutes } from './routes/creator-routes.js';
import { handleShortenerRoutes } from './routes/shortener-routes.js';
import { handleChannelRoutes } from './routes/channel-routes.js';
import { handleFileRoutes } from './routes/file-routes.js';
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
  getPlatformFeeSettings,
  setPlatformFeeSettings,
  getOwnerPlatformFeeSummary,
} from '../wallet/fee-repository.js';
import {
  getUserReferralSummary,
  listOwnerReferrals,
  setReferralSettings,
} from '../wallet/referral-repository.js';
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
import {
  enableFamPay,
  loadFamPayConfig,
  createFamPayCheckout,
  verifyFamPaySession,
  generateUpiQrDataUrl,
} from '../payments/fampay.js';
import {
  getBotSlotSettings,
  setBotSlotSettings,
  getCreatorBotSlotQuota,
  unlockSlotWithWallet,
} from '../delivery/slot-repository.js';
import {
  getDeliveryBotStartConfig,
  saveDeliveryBotStartConfig,
  serializeStartConfig,
} from '../delivery/start-message-repository.js';
import {
  enableTelegramStars,
  loadStarsConfig,
  getTelegramStarsPrice,
  setTelegramStarsPrice,
} from '../payments/telegram-stars.js';
import { applyVerifiedPayment } from '../payments/fulfillment-repository.js';
import {
  parsePositiveInt,
  parseTelegramUserId,
  parseMinorAmount,
  parseCurrencyCode,
} from '../utils/validation.js';

const MAX_START_IMAGE_BODY_BYTES = 4 * 1024 * 1024;
async function getGlobalCheckpointEnabled(pool) {
  return cached('panel:checkpoint-enabled', 15_000, async () => {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'checkpoint_enabled' LIMIT 1",
    );
    return rows[0]?.value === true || rows[0]?.value === 'true';
  });
}

async function setGlobalCheckpointEnabled(pool, enabled, actorId) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ('checkpoint_enabled', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [enabled ? 'true' : 'false', actorId],
  );
  cacheDeletePrefix('panel:checkpoint-enabled');
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

function serializeOwnerBotRow(b) {
  const isPlatform = b.owner_telegram_id === null || b.owner_telegram_id === undefined;
  return {
    id: Number(b.id),
    telegramBotId: String(b.telegram_bot_id),
    username: b.username,
    role: b.role,
    priority: Number(b.priority ?? 0),
    isEnabled: Boolean(b.is_enabled),
    runtimeStatus: b.runtime_status,
    lastHealthAt: b.last_health_at,
    lastError: b.last_error ?? null,
    createdBy: b.created_by == null ? null : String(b.created_by),
    ownerId: isPlatform ? null : String(b.owner_telegram_id),
    isPlatform,
    ownerUsername: b.owner_username ?? null,
    ownerFirstName: b.owner_first_name ?? null,
    ownerLastName: b.owner_last_name ?? null,
    totalUsers: Number(b.total_users ?? 0),
    activeUsers7d: Number(b.active_users_7d ?? 0),
    totalInteractions: Number(b.total_interactions ?? 0),
    lastUserSeenAt: b.last_user_seen_at ?? null,
    jobsTotal: Number(b.jobs_total ?? 0),
    jobsCompleted: Number(b.jobs_completed ?? 0),
    jobsFailed: Number(b.jobs_failed ?? 0),
    jobsPending: Number(b.jobs_pending ?? 0),
    storageChannelsCount: Number(b.storage_channels_count ?? 0),
    hasCustomStartMessage: Boolean(b.start_message || b.start_image_url || b.has_start_image_upload),
    startMessage: b.start_message ?? null,
    hasStartImage: Boolean(b.start_image_url || b.has_start_image_upload),
    startImageType: b.has_start_image_upload ? 'upload' : (b.start_image_url ? 'url' : null),
    startUpdatedAt: b.start_updated_at ?? null,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

export async function handlePanelApiRequest(req, res, state, logger) {
  res.__acceptEncoding = String(req.headers['accept-encoding'] || '');
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
      const auth = await verifyAccessToken(pool, token, adminIds, { bypassCache: true });
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
      return sendJson(res, 200, {
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

    // ── Links (Free Share Links + Paid File Links + Paid Batch Links) ───
    if (method === 'GET' && pathname === '/api/panel/links') {
      const [shareRes, paidFiles, paidBatches, botUsername, platformFees] = await Promise.all([
        listShareLinks(pool, { limit: 100, offset: 0, ownerId: ownerScope }),
        listPaidFileLinks(pool, 100, ownerScope),
        listPaidBatchLinks(pool, 100, ownerScope),
        getShareableBotUsername(pool, ownerScope),
        getPlatformFeeSettings(pool).catch(() => null),
      ]);

      return sendJson(res, 200, {
        deliveryBotUsername: botUsername ?? null,
        platformFees,
        shareLinks: shareRes.rows.map((r) => ({
          id: r.id,
          kind: 'share',
          code: r.link_code,
          linkType: r.link_type,
          title: r.title || r.primary_file_name || r.link_code,
          itemCount: Number(r.item_count ?? 1),
          views: Number(r.view_count ?? 0),
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
          views: Number(r.view_count ?? 0),
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
          views: Number(r.view_count ?? 0),
          priceMinor: Number(r.price_minor ?? 0),
          currency: r.currency || 'INR',
          isEnabled: Boolean(r.is_enabled),
          expiresAt: r.expires_at,
          createdAt: r.created_at,
          url: botUsername ? `https://t.me/${botUsername}?start=pbatch_${r.public_code}` : null,
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
        } else if (kind === 'paid_file') {
          if (body.priceMinor !== undefined) {
            const price = Number(body.priceMinor);
            if (!Number.isSafeInteger(price) || price < 1) {
              return sendJson(res, 400, { error: 'Price must be a positive integer in minor currency units.' });
            }
            const currency = body.currency ? parseCurrencyCode(body.currency) : null;
            updated = await updatePaidFileLinkPrice(pool, id, price, currency, ownerScope);
          }
          if (typeof body.isEnabled === 'boolean') {
            updated = await setPaidFileLinkEnabled(pool, id, body.isEnabled, ownerScope);
          }
        } else if (kind === 'paid_batch') {
          if (body.title !== undefined || body.priceMinor !== undefined) {
            const title = typeof body.title === 'string' ? body.title.trim() : '';
            const price = Number(body.priceMinor);
            if (!title) {
              return sendJson(res, 400, { error: 'Batch title is required when editing a paid batch link.' });
            }
            if (!Number.isSafeInteger(price) || price < 1) {
              return sendJson(res, 400, { error: 'Price must be a positive integer in minor currency units.' });
            }
            const currency = body.currency ? parseCurrencyCode(body.currency) : null;
            updated = await updatePaidBatchLink(pool, id, title, price, currency, ownerScope);
          }
          if (typeof body.isEnabled === 'boolean') {
            updated = await setPaidBatchLinkEnabled(pool, id, body.isEnabled, ownerScope);
          }
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

        // File management routes are handled by the dedicated module.
    if (await handleFileRoutes({ res, method, pathname, ownerScope, pool, sendJson, disableUnusedFilesForOwner, disableFileByIdOrCode })) return;

// Shortener API routes are handled by the dedicated module.
    if (await handleShortenerRoutes({ req, res, method, pathname, auth, ownerScope, pool, config, sendJson, readJsonBody, listShortenerProviders, getGlobalCheckpointEnabled, getCreatorSettings, normalizeShortenerUrls, deriveUniqueShortenerName, addShortenerProvider, setGlobalCheckpointEnabled, setCreatorCheckpointEnabled, getShortenerProviderById, decryptShortenerApiKey, shortenUrlWithProvider, markShortenerTest, updateShortenerName, updateShortenerCredentials, setShortenerEnabled, setShortenerPriority, setShortenerDuration, removeShortenerProvider })) return;

    // Channel API routes are handled by the dedicated module.
    if (await handleChannelRoutes({ req, res, method, pathname, auth, ownerScope, pool, state, sendJson, readJsonBody, parseStorageIdentifier, validateStorageChannel, validateForceSubChannel, listStorageChannels, getStorageChannelForOwner, saveStorageChannel, updateStorageTest, setStorageEnabled, setPrimaryStorageChannel, removeStorageChannel, listForceSubChannels, getForceSubGlobal, saveForceSubChannel, setForceSubEnabled, removeForceSubChannel, setForceSubGlobal, cacheDeletePrefix })) return;

// Premium plan endpoints are handled by the dedicated route module.
    if (await handlePlanRoutes({ req, res, method, pathname, auth, pool, parsedUrl, sendJson, readJsonBody, listPremiumPlans, getShareableBotUsername, loadStarsConfig, getPlatformFeeSettings, getTelegramStarsPrice, parseCurrencyCode, parseMinorAmount, upsertPremiumPlan, setTelegramStarsPrice, getPremiumPlanById, editPremiumPlan, setPremiumPlanEnabled, removePremiumPlan })) return;

// Creator wallet endpoints are handled by their dedicated route module.
    if (await handleWalletRoutes({ req, res, method, pathname, auth, pool, state, sendJson, readJsonBody, getCreatorWalletSummary, getUserReferralSummary, getPlatformFeeSettings, MIN_WITHDRAWAL_INR_MINOR, setCreatorPayoutUpi, parseMinorAmount, requestWithdrawal, notifyAdminsWithdrawalRequest, adminIds, logger })) return;

// ── Delivery Bots (Creator / Actor-Scoped Management) ───────────────
    if (method === 'GET' && pathname === '/api/panel/bots') {
      const scopeWhere = ownerScope === null ? 'd.owner_telegram_id IS NULL' : 'd.owner_telegram_id = $1';
      const scopeParams = ownerScope === null ? [] : [Number(ownerScope)];
      const [botRes, storageChannels, sharedBotUsername, slots, walletSummary, fpCfg, starsCfg] = await Promise.all([
        pool.query(
          `SELECT d.id, d.telegram_bot_id, d.username, d.role, d.priority, d.is_enabled, d.runtime_status,
                  d.last_health_at, d.last_error, d.owner_telegram_id,
                  d.start_message, d.start_image_url, (d.start_image_data IS NOT NULL) AS has_start_image_upload,
                  d.start_image_mime, d.start_updated_at, d.created_at, d.updated_at,
                  COALESCE(u.total_users, 0)::int AS total_users,
                  COALESCE(u.active_users_7d, 0)::int AS active_users_7d,
                  COALESCE(u.total_interactions, 0)::int AS total_interactions
           FROM delivery_bots d
           LEFT JOIN (
             SELECT delivery_bot_id,
                    COUNT(*)::int AS total_users,
                    COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days')::int AS active_users_7d,
                    COALESCE(SUM(interaction_count), 0)::int AS total_interactions
             FROM delivery_bot_user_activity
             GROUP BY delivery_bot_id
           ) u ON u.delivery_bot_id = d.id
           WHERE ${scopeWhere}
           ORDER BY d.priority ASC, d.id ASC`,
          scopeParams,
        ).catch(async () => {
          const fallback = state.deliveryManager?.list ? await state.deliveryManager.list(ownerScope) : [];
          return { rows: fallback };
        }),
        listStorageChannels(pool, ownerScope),
        getShareableBotUsername(pool, null).catch(() => null),
        getCreatorBotSlotQuota(pool, ownerScope, auth.isOwner),
        getCreatorWalletSummary(pool, auth.userId).catch(() => ({ inrWallet: { available_minor: 0 } })),
        loadFamPayConfig(pool, config.tokenEncryptionKey).catch(() => ({ isEnabled: false, isConfigured: false })),
        loadStarsConfig(pool).catch(() => ({ isEnabled: false })),
      ]);
      const rows = (botRes.rows || []).map(serializeOwnerBotRow);
      const hasOwnStorage = storageChannels.some((c) => c.is_enabled);
      return sendJson(res, 200, {
        mainBotUsername: state.botUsername ?? null,
        sharedBotUsername: sharedBotUsername ?? null,
        hasOwnStorage,
        requiresStorageWarning: !auth.isOwner && rows.length > 0 && !hasOwnStorage,
        slots,
        walletAvailableMinor: Number(walletSummary?.inrWallet?.available_minor ?? 0),
        paymentMethods: {
          fampayEnabled: Boolean(fpCfg?.isEnabled && fpCfg?.isConfigured),
          starsEnabled: Boolean(starsCfg?.isEnabled && slots?.starsPrice),
        },
        bots: rows,
      });
    }

    if (method === 'POST' && pathname === '/api/panel/bots/slots/checkout') {
      if (auth.isOwner) {
        return sendJson(res, 400, { error: 'Platform owners already have unlimited delivery bot slots.' });
      }
      const body = await readJsonBody(req);
      const payMethod = String(body.method || 'fampay').trim().toLowerCase();
      if (payMethod === 'wallet') {
        const result = await unlockSlotWithWallet(pool, auth.userId);
        const slots = await getCreatorBotSlotQuota(pool, ownerScope, false);
        return sendJson(res, 200, { ok: true, paid: true, method: 'wallet', result, slots });
      }
      if (payMethod !== 'fampay') {
        return sendJson(res, 400, { error: 'Unsupported payment method. Use UPI (FamPay) or Wallet balance.' });
      }
      const slotSettings = await getBotSlotSettings(pool);
      const checkout = await createFamPayCheckout(pool, config, {
        userId: auth.userId,
        purpose: 'bot_slot',
        target: {},
        baseAmountMinor: slotSettings.priceMinor,
        currency: slotSettings.currency || 'INR',
        label: 'Extra Bot Slot',
      });
      const qrDataUrl = await generateUpiQrDataUrl(checkout.upiUri);
      return sendJson(res, 200, {
        ok: true,
        method: 'fampay',
        sessionId: Number(checkout.session.id),
        amountMinor: checkout.amountMinor,
        amountDisplay: checkout.amountDisplay,
        baseAmountMinor: slotSettings.priceMinor,
        upiId: checkout.upiId,
        txnRef: checkout.txnRef,
        upiUri: checkout.upiUri,
        qrDataUrl,
        expiresAt: checkout.session.expires_at,
      });
    }

    const slotCheckoutMatch = pathname.match(/^\/api\/panel\/bots\/slots\/checkout\/(\d+)\/(status|verify)$/);
    if (slotCheckoutMatch && (method === 'GET' || method === 'POST')) {
      const sessionId = Number(slotCheckoutMatch[1]);
      const action = slotCheckoutMatch[2];
      const sessRes = await pool.query(
        'SELECT id, user_telegram_id, purpose, status, expires_at FROM payment_sessions WHERE id = $1 LIMIT 1',
        [sessionId],
      );
      const sess = sessRes.rows[0];
      if (!sess || String(sess.user_telegram_id) !== String(auth.userId) || sess.purpose !== 'bot_slot') {
        return sendJson(res, 404, { error: 'Checkout session not found.' });
      }
      if (sess.status === 'applied') {
        const slots = await getCreatorBotSlotQuota(pool, ownerScope, auth.isOwner);
        return sendJson(res, 200, { status: 'applied', paid: true, slots });
      }
      if (sess.status === 'expired' || sess.status === 'failed') {
        return sendJson(res, 200, { status: sess.status, paid: false });
      }
      const body = method === 'POST' ? await readJsonBody(req) : {};
      const submittedUtr = action === 'verify' && body.utr ? String(body.utr).trim() : null;
      const result = await verifyFamPaySession(pool, config, sessionId, { userId: auth.userId, submittedUtr });
      const paid = result.status === 'verified' || result.status === 'applied';
      const slots = paid ? await getCreatorBotSlotQuota(pool, ownerScope, auth.isOwner) : null;
      return sendJson(res, 200, {
        status: paid ? 'applied' : result.status,
        paid,
        utr: result.utr ?? null,
        slots,
      });
    }

    if (method === 'POST' && pathname === '/api/panel/bots') {
      if (!state.deliveryManager?.addToken) {
        return sendJson(res, 503, { error: 'Delivery bot runtime manager is not active right now.' });
      }
      const body = await readJsonBody(req);
      const rawToken = String(body.token || '').trim();
      if (!rawToken || !/^\d{5,16}:[A-Za-z0-9_-]{20,}$/.test(rawToken)) {
        return sendJson(res, 400, { error: 'Please paste a valid @BotFather token (e.g. 123456789:ABCdef...).' });
      }
      const saved = await state.deliveryManager.addToken(rawToken, auth.userId, ownerScope);
      const [storageChannels, slots] = await Promise.all([
        listStorageChannels(pool, ownerScope),
        getCreatorBotSlotQuota(pool, ownerScope, auth.isOwner),
      ]);
      const hasOwnStorage = storageChannels.some((c) => c.is_enabled);
      return sendJson(res, 201, {
        ok: true,
        hasOwnStorage,
        requiresStorageChannel: !auth.isOwner && !hasOwnStorage,
        warning: !auth.isOwner && !hasOwnStorage
          ? 'Delivery bot connected! You MUST add your own Storage Channel and make both the Main Bot and your Delivery Bot administrators in it, otherwise delivery will not work.'
          : null,
        slots,
        bot: {
          id: Number(saved.id),
          telegramBotId: String(saved.telegram_bot_id),
          username: saved.username,
          role: saved.role,
          priority: Number(saved.priority ?? 10),
          isEnabled: Boolean(saved.is_enabled),
          runtimeStatus: saved.runtime_status,
        },
      });
    }

    const actorBotReplaceMatch = pathname.match(/^\/api\/panel\/bots\/(\d+)\/replace$/);
    if (method === 'POST' && actorBotReplaceMatch) {
      const botId = Number(actorBotReplaceMatch[1]);
      if (!state.deliveryManager?.replaceToken) {
        return sendJson(res, 503, { error: 'Delivery bot replacement is not available right now.' });
      }
      const body = await readJsonBody(req);
      const rawToken = String(body.token || '').trim();
      if (!rawToken || !/^\d{5,16}:[A-Za-z0-9_-]{20,}$/.test(rawToken)) {
        return sendJson(res, 400, { error: 'Please paste a valid @BotFather token (e.g. 123456789:ABCdef...).' });
      }
      const replaced = await state.deliveryManager.replaceToken(botId, rawToken, auth.userId, ownerScope);
      const storageChannels = await listStorageChannels(pool, ownerScope);
      const hasOwnStorage = storageChannels.some((c) => c.is_enabled);
      const checks = replaced.checks || [];
      const failedChecks = checks.filter((c) => c.status !== 'ok' && c.status !== 'force_sub_admin_ok');
      let warning = null;
      if (!auth.isOwner && !hasOwnStorage) {
        warning = `Bot updated to @${replaced.bot.username}. Add your own Storage Channel and make both bots administrators so deliveries work.`;
      } else if (failedChecks.length > 0) {
        warning = `Bot updated to @${replaced.bot.username}, and all your links remain active. Make sure @${replaced.bot.username} is added as Administrator in ${failedChecks.length} channel(s).`;
      }
      return sendJson(res, 200, {
        ok: true,
        hasOwnStorage,
        requiresStorageChannel: !auth.isOwner && !hasOwnStorage,
        warning,
        checks,
        bot: {
          id: Number(replaced.bot.id),
          telegramBotId: String(replaced.bot.telegram_bot_id),
          username: replaced.bot.username,
          role: replaced.bot.role,
          priority: Number(replaced.bot.priority ?? 10),
          isEnabled: Boolean(replaced.bot.is_enabled),
          runtimeStatus: replaced.bot.runtime_status,
        },
      });
    }

    const actorBotTestMatch = pathname.match(/^\/api\/panel\/bots\/(\d+)\/test$/);
    if (method === 'POST' && actorBotTestMatch) {
      const botId = Number(actorBotTestMatch[1]);
      if (!state.deliveryManager?.test) {
        return sendJson(res, 503, { error: 'Delivery bot runtime manager is not active.' });
      }
      const result = await state.deliveryManager.test(botId, ownerScope);
      return sendJson(res, 200, {
        ok: true,
        bot: { id: result.bot.id, username: result.bot.username, firstName: result.bot.first_name },
        checks: result.checks || [],
      });
    }

    const actorBotStartMatch = pathname.match(/^\/api\/panel\/bots\/(\d+)\/start-message$/);
    if (actorBotStartMatch) {
      const botId = Number(actorBotStartMatch[1]);
      if (method === 'GET') {
        const record = await getDeliveryBotStartConfig(pool, botId, ownerScope);
        if (!record) return sendJson(res, 404, { error: 'Delivery bot not found.' });
        return sendJson(res, 200, serializeStartConfig(record));
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJsonBody(req, MAX_START_IMAGE_BODY_BYTES);
        const saved = await saveDeliveryBotStartConfig(pool, botId, ownerScope, body);
        if (!saved) return sendJson(res, 404, { error: 'Delivery bot not found.' });
        return sendJson(res, 200, { ok: true, ...serializeStartConfig(saved) });
      }
      if (method === 'DELETE') {
        const cleared = await saveDeliveryBotStartConfig(pool, botId, ownerScope, { clear: true });
        if (!cleared) return sendJson(res, 404, { error: 'Delivery bot not found.' });
        return sendJson(res, 200, { ok: true, ...serializeStartConfig(cleared) });
      }
    }

    const actorBotMatch = pathname.match(/^\/api\/panel\/bots\/(\d+)$/);
    if (actorBotMatch) {
      const botId = Number(actorBotMatch[1]);
      const scopeWhere = ownerScope === null ? 'owner_telegram_id IS NULL' : 'owner_telegram_id = $2';
      const scopeParams = ownerScope === null ? [botId] : [botId, Number(ownerScope)];
      const existingBotRes = await pool.query(
        `SELECT id, owner_telegram_id FROM delivery_bots WHERE id = $1 AND ${scopeWhere} LIMIT 1`,
        scopeParams,
      );
      if (!existingBotRes.rowCount) {
        return sendJson(res, 404, { error: 'Delivery bot not found.' });
      }

      if (method === 'PATCH') {
        if (!state.deliveryManager) {
          return sendJson(res, 503, { error: 'Delivery bot runtime manager is not active.' });
        }
        const body = await readJsonBody(req);
        if (body.priority !== undefined) {
          const prio = Number(body.priority);
          if (!Number.isInteger(prio) || prio < 0 || prio > 100000) {
            return sendJson(res, 400, { error: 'Priority must be an integer between 0 and 100000.' });
          }
          await state.deliveryManager.setPriority(botId, prio, ownerScope);
        }
        if (typeof body.isEnabled === 'boolean') {
          await state.deliveryManager.setEnabled(botId, body.isEnabled, ownerScope);
        }
        if (body.action === 'pause') await state.deliveryManager.pause(botId, ownerScope);
        else if (body.action === 'resume') await state.deliveryManager.resume(botId, ownerScope);
        else if (body.action === 'restart') await state.deliveryManager.restart(botId, ownerScope);
        else if (body.action === 'set_primary') await state.deliveryManager.promotePrimary(botId, ownerScope);
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        if (!state.deliveryManager?.remove) {
          return sendJson(res, 503, { error: 'Delivery bot runtime manager is not active.' });
        }
        const removed = await state.deliveryManager.remove(botId, ownerScope);
        if (!removed) return sendJson(res, 404, { error: 'Delivery bot not found.' });
        return sendJson(res, 200, { ok: true });
      }
    }

    // Creator and owner broadcast routes are handled by their dedicated module.
    if (await handleBroadcastRoutes({ req, res, method, pathname, auth, pool, state, parsedUrl, sendJson, readJsonBody })) return;

        // Creator dashboard directory endpoints are handled by their dedicated module.
    if (await handleCreatorRoutes({ res, method, pathname, auth, pool, parsedUrl, sendJson, listPanelUsers, listPanelPremiumMembers })) return;

// ── Owner-Only Routes (/api/panel/owner/*) ──────────────────────────
    if (pathname.startsWith('/api/panel/owner/')) {
      if (!auth.isOwner) {
        return sendJson(res, 403, { error: 'Restricted to the platform owner.' });
      }

      if (method === 'GET' && pathname === '/api/panel/owner/bot-slot-settings') {
        const settings = await getBotSlotSettings(pool);
        return sendJson(res, 200, { settings });
      }

      if (method === 'POST' && pathname === '/api/panel/owner/bot-slot-settings') {
        const body = await readJsonBody(req);
        const priceMinor = body.priceMinor !== undefined && body.priceMinor !== null && body.priceMinor !== ''
          ? Number(body.priceMinor)
          : parseMinorAmount(body.price, { allowZero: false });
        const starsPrice = body.starsPrice === undefined
          ? undefined
          : (body.starsPrice === null || String(body.starsPrice).trim() === '' || Number(body.starsPrice) === 0
              ? null
              : Number(body.starsPrice));
        const settings = await setBotSlotSettings(pool, { priceMinor, starsPrice }, auth.userId);
        return sendJson(res, 200, { ok: true, settings });
      }

      if (method === 'GET' && pathname === '/api/panel/owner/referrals') {
        const data = await listOwnerReferrals(pool, 50);
        return sendJson(res, 200, data);
      }

      if (method === 'POST' && pathname === '/api/panel/owner/referral-settings') {
        const body = await readJsonBody(req);
        const enabled = body.enabled === undefined
          ? undefined
          : (typeof body.enabled === 'string' ? body.enabled === 'true' : Boolean(body.enabled));
        const rewardMinor = body.rewardMinor !== undefined && body.rewardMinor !== null && body.rewardMinor !== ''
          ? Number(body.rewardMinor)
          : parseMinorAmount(body.reward ?? body.price, { allowZero: true });
        const settings = await setReferralSettings(pool, { enabled, rewardMinor }, auth.userId);
        return sendJson(res, 200, { ok: true, settings });
      }

      if (method === 'GET' && pathname === '/api/panel/owner/fees') {
        const data = await getOwnerPlatformFeeSummary(pool, 30);
        return sendJson(res, 200, data);
      }

      if (method === 'POST' && pathname === '/api/panel/owner/fee-settings') {
        const body = await readJsonBody(req);
        const enabled = body.enabled === undefined
          ? undefined
          : (typeof body.enabled === 'string' ? body.enabled === 'true' : Boolean(body.enabled));
        const settings = await setPlatformFeeSettings(
          pool,
          {
            enabled,
            paidLinkFeeBps: body.paidLinkFeeBps,
            premiumFeeBps: body.premiumFeeBps,
            paidLinkFeePercent: body.paidLinkFeePercent,
            premiumFeePercent: body.premiumFeePercent,
          },
          auth.userId,
        );
        return sendJson(res, 200, { ok: true, settings });
      }

      if (method === 'GET' && pathname === '/api/panel/owner/bots') {
        const q = parsedUrl.searchParams.get('q') || '';
        const scope = parsedUrl.searchParams.get('scope') || 'all';
        const status = parsedUrl.searchParams.get('status') || 'all';
        const [data, botSlotSettings] = await Promise.all([
          listAllDeliveryBotsForOwner(pool, { q, scope, status }),
          getBotSlotSettings(pool),
        ]);
        const rows = data.rows.map(serializeOwnerBotRow);
        return sendJson(res, 200, {
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
          return sendJson(res, 503, { error: 'Delivery bot runtime manager is not active.' });
        }
        const result = await state.deliveryManager.test(botId);
        return sendJson(res, 200, {
          ok: true,
          bot: { id: result.bot.id, username: result.bot.username, firstName: result.bot.first_name },
          checks: result.checks,
        });
      }

      const ownerBotStartMatch = pathname.match(/^\/api\/panel\/owner\/bots\/(\d+)\/start-message$/);
      if (method === 'DELETE' && ownerBotStartMatch) {
        const botId = Number(ownerBotStartMatch[1]);
        const cleared = await saveDeliveryBotStartConfig(pool, botId, undefined, { clear: true });
        if (!cleared) return sendJson(res, 404, { error: 'Delivery bot not found.' });
        return sendJson(res, 200, { ok: true, ...serializeStartConfig(cleared) });
      }

      const ownerBotMatch = pathname.match(/^\/api\/panel\/owner\/bots\/(\d+)$/);
      if (ownerBotMatch) {
        const botId = Number(ownerBotMatch[1]);
        if (method === 'GET') {
          const details = await getDeliveryBotDetailsForOwner(pool, botId);
          if (!details) return sendJson(res, 404, { error: 'Delivery bot not found.' });
          return sendJson(res, 200, {
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
          if (!updated) return sendJson(res, 404, { error: 'Delivery bot not found.' });
          return sendJson(res, 200, { ok: true, bot: serializeOwnerBotRow(updated.bot) });
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
          if (!removed) return sendJson(res, 404, { error: 'Delivery bot not found.' });
          return sendJson(res, 200, { ok: true });
        }
      }

      if (method === 'GET' && pathname === '/api/panel/owner/link-analytics') {
        const rows = await getOwnerLinkAnalytics(pool, 100);
        return sendJson(res, 200, { total: rows.length, rows: rows.map((r) => ({
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

      if (await handleOwnerPaymentRoutes({ req, res, method, pathname, auth, pool, config, parsedUrl, sendJson, readJsonBody, searchPaymentTransactions, listPaymentTransactions, listPaymentMethods, applyVerifiedPayment, adminIds, disablePaymentMethod, enableFamPay, enableTelegramStars })) return;

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
    return sendJson(res, statusCode, {
      error: error.message || 'Operation failed.',
      ...(error.code ? { code: error.code } : {}),
    });
  }
}
