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
import { handleLinkRoutes } from './routes/link-routes.js';
// Paid batch delivery uses the ?start=pbatch_${r.public_code} deep-link prefix in link-routes.js.
import { handleDeliveryBotRoutes } from './routes/delivery-bot-routes.js';
import { handleOwnerSettingsRoutes } from './routes/owner-settings-routes.js';
import { handleOwnerBotRoutes } from './routes/owner-bot-routes.js';
import { handleOwnerDashboardRoutes } from './routes/owner-dashboard-routes.js';
import { handleOwnerWithdrawalRoutes } from './routes/owner-withdrawal-routes.js';
import { handleOwnerPremiumRoutes } from './routes/owner-premium-routes.js';
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

        // Link management routes are handled by the dedicated module.
    if (await handleLinkRoutes({ req, res, method, pathname, ownerScope, pool, sendJson, readJsonBody, listShareLinks, listPaidFileLinks, listPaidBatchLinks, getShareableBotUsername, getPlatformFeeSettings, buildShareableUrl, renameShareLink, setShareLinkEnabled, deleteShareLink, updatePaidFileLinkPrice, setPaidFileLinkEnabled, updatePaidBatchLink, setPaidBatchLinkEnabled, deletePaidFileLink, deletePaidBatchLink, parseCurrencyCode })) return;

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

    // Delivery-bot API routes are handled by the dedicated module.
    if (await handleDeliveryBotRoutes({ req, res, method, pathname, auth, ownerScope, pool, state, config, sendJson, readJsonBody, MAX_START_IMAGE_BODY_BYTES, parsePositiveInt, serializeOwnerBotRow, listStorageChannels, getShareableBotUsername, getCreatorBotSlotQuota, getCreatorWalletSummary, loadFamPayConfig, loadStarsConfig, unlockSlotWithWallet, getBotSlotSettings, createFamPayCheckout, generateUpiQrDataUrl, verifyFamPaySession, getDeliveryBotStartConfig, saveDeliveryBotStartConfig, serializeStartConfig })) return;

// Creator and owner broadcast routes are handled by their dedicated module.
    if (await handleBroadcastRoutes({ req, res, method, pathname, auth, pool, state, parsedUrl, sendJson, readJsonBody })) return;

        // Creator dashboard directory endpoints are handled by their dedicated module.
    if (await handleCreatorRoutes({ res, method, pathname, auth, pool, parsedUrl, sendJson, listPanelUsers, listPanelPremiumMembers })) return;

// ── Owner-Only Routes (/api/panel/owner/*) ──────────────────────────
    if (pathname.startsWith('/api/panel/owner/')) {
      if (!auth.isOwner) {
        return sendJson(res, 403, { error: 'Restricted to the platform owner.' });
      }

      // Owner settings are routed through the dedicated settings module.
      if (await handleOwnerSettingsRoutes({ req, res, method, pathname, auth, pool, sendJson, readJsonBody, getBotSlotSettings, setBotSlotSettings, listOwnerReferrals, setReferralSettings, getOwnerPlatformFeeSummary, setPlatformFeeSettings, parseMinorAmount })) return;

      // Owner delivery-bot management is handled by the dedicated route module.
      if (await handleOwnerBotRoutes({ req, res, method, pathname, auth, pool, state, parsedUrl, sendJson, readJsonBody, serializeOwnerBotRow, listAllDeliveryBotsForOwner, getBotSlotSettings, getDeliveryBotDetailsForOwner, updateDeliveryBotForOwner, saveDeliveryBotStartConfig, serializeStartConfig, cacheDeletePrefix })) return;

      // Owner analytics and dashboard endpoints are handled by the dedicated module.
      if (await handleOwnerDashboardRoutes({ req, res, method, pathname, auth, pool, parsedUrl, sendJson, readJsonBody, getOwnerLinkAnalytics, getAdminDashboardStats, getOperationalHealth, getPaymentReconciliationStats, getPaymentAnalytics, getRecentDeliveryJobs, getAutoDeleteMinutes, listFailedScheduledDeletions, listPaymentMethods, normalizeOwnerStats, setAutoDeleteMinutes, retryFailedDeliveryJob })) return;

      // Owner withdrawal administration is handled by the dedicated module.
      if (await handleOwnerWithdrawalRoutes({ req, res, method, pathname, auth, pool, state, sendJson, readJsonBody, listWithdrawalRequests, approveWithdrawalPaid, rejectWithdrawalRefund, notifyWithdrawalOutcome, logger })) return;

      if (await handleOwnerPaymentRoutes({ req, res, method, pathname, auth, pool, config, parsedUrl, sendJson, readJsonBody, searchPaymentTransactions, listPaymentTransactions, listPaymentMethods, applyVerifiedPayment, adminIds, disablePaymentMethod, enableFamPay, enableTelegramStars })) return;

      // Owner premium membership routes are handled by the dedicated module.
      if (await handleOwnerPremiumRoutes({ res, method, pathname, auth, pool, sendJson, readJsonBody, parseTelegramUserId, parsePositiveInt, grantPremiumMembership, revokePremiumMembership })) return;
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
