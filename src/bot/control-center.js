import { isAdmin } from './admin-guard.js';
import { registerOwnerBotActions } from './controllers/owner-bot-controller.js';
import { registerDeliveryJobActions } from './controllers/delivery-job-controller.js';
import { registerForceSubActions } from './controllers/force-sub-controller.js';
import { registerShortenerActions } from './controllers/shortener-controller.js';
import { registerPremiumPlanActions } from './controllers/premium-plan-controller.js';
import { registerPaymentMethodActions } from './controllers/payment-method-controller.js';
import { registerCreatorPlanActions } from './controllers/creator-plan-controller.js';
import { registerGatewayActions } from './controllers/gateway-controller.js';
import { registerPaidLinkActions } from './controllers/paid-link-controller.js';
import { registerAutoDeleteActions } from './controllers/auto-delete-controller.js';
import { registerOwnerBroadcastActions } from './controllers/owner-broadcast-controller.js';
import {
  createCreatorBroadcast,
  getCreatorBroadcast,
  listCreatorBroadcasts,
  listOwnerCreatedBroadcasts,
  retryCreatorBroadcast,
  setCreatorBroadcastStatus,
} from '../broadcast/repository.js';
import { getAdminDashboardStats, formatAdminDashboard, getPaymentReconciliationStats, searchPaymentTransactions } from '../admin/dashboard-repository.js';
import { getOperationalHealth, formatOperationalHealth } from '../admin/operational-health.js';
import { formatPaymentReconciliation } from '../admin/dashboard-commands.js';
import { parseStorageIdentifier } from '../storage/identifier.js';
import {
  listStorageChannels,
  saveStorageChannel,
  updateStorageTest,
  setStorageEnabled,
  setPrimaryStorageChannel,
  removeStorageChannel,
} from '../storage/repository.js';
import { searchIndexedFiles, getIndexedFile, formatFileSize } from '../storage/file-query.js';
import { countUnusedFilesForOwner, disableFileByIdOrCode, disableUnusedFilesForOwner } from '../storage/file-cleanup.js';
import { getRecentDeliveryJobs, retryFailedDeliveryJob } from '../delivery/repository.js';
import {
  listAllDeliveryBotsForOwner,
  getDeliveryBotDetailsForOwner,
  updateDeliveryBotForOwner,
} from '../web/owner-bots-repository.js';
import { getAutoDeleteMinutes, setAutoDeleteMinutes, listFailedScheduledDeletions } from '../delivery/auto-delete-repository.js';
import {
  listForceSubChannels,
  getForceSubGlobal,
  saveForceSubChannel,
  setForceSubEnabled,
  removeForceSubChannel,
  setForceSubGlobal,
} from '../access/force-sub-repository.js';
import {
  listShortenerProviders,
  getShortenerProviderById,
  addShortenerProvider,
  parseShortenerInput,
  normalizeShortenerUrls,
  deriveUniqueShortenerName,
  decryptShortenerApiKey,
  updateShortenerName,
  updateShortenerCredentials,
  setShortenerDuration,
  setShortenerPriority,
  markShortenerTest,
  setShortenerEnabled,
  removeShortenerProvider,
} from '../access/shortener-repository.js';
import { shortenUrlWithProvider } from '../access/checkpoint-engine.js';
import {
  listPremiumPlans,
  getPremiumPlanById,
  upsertPremiumPlan,
  setPremiumPlanEnabled,
  removePremiumPlan,
  grantPremiumMembership,
  revokePremiumMembership,
  getPremiumStatus,
} from '../premium/repository.js';
import {
  listPaymentMethods,
  listPaymentRecoveryFailures,
  listExpiredPaymentSessions,
  disablePaymentMethod,
  markPaymentMethodTest,
} from '../payments/repository.js';
import {
  loadFamPayConfig,
  saveFamPayConfig,
  enableFamPay,
  testFamPayImapConnection,
  maskEmail,
  createFamPayCheckout,
  verifyFamPaySession,
  cancelFamPaySession,
} from '../payments/fampay.js';
import {
  loadStarsConfig,
  setTelegramStarsPrice,
  enableTelegramStars,
  testTelegramStars,
  getTelegramStarsPrice,
  sendStarsInvoice,
} from '../payments/telegram-stars.js';
import {
  getBotSlotSettings,
  getCreatorBotSlotQuota,
  unlockSlotWithWallet,
} from '../delivery/slot-repository.js';
import {
  listPaidFileLinks,
  disablePaidFileLink,
  setPaidFileLinkEnabled,
  deletePaidFileLink,
  listPendingPaidFilePurchases,
  confirmPaidFilePurchase,
  getPaidFileLink,
  getPaidFileLinkByIdOrCode,
} from '../paid-files/repository.js';
import {
  listPaidBatchLinks,
  disablePaidBatchLink,
  setPaidBatchLinkEnabled,
  deletePaidBatchLink,
  listPendingBatchPurchases,
  confirmPaidBatchPurchase,
  getPaidBatch,
  getPaidBatchByIdOrCode,
} from '../paid-files/batch-repository.js';
import { getShareableBotUsername, buildShareableUrl } from '../storage/share-links-repository.js';
import {
  getCreatorSettings,
  getCreatorWalletSummary,
  setCreatorCheckpointEnabled,
} from '../wallet/repository.js';
import {
  getUserReferralSummary,
  claimReferralOnStart,
} from '../wallet/referral-repository.js';

import { registerShareLinksUi } from './share-links-ui.js';
import { registerPaidLinksUi } from './paid-links-ui.js';
import { registerWalletUi } from './wallet-ui.js';
import { registerWebTokenUi } from './web-token-ui.js';
import {
  escapeHtml,
  renderView,
  safeAnswer,
  validateStorageChannel,
  validateForceSubChannel,
} from './telegram-utils.js';
import {
  parsePositiveInt,
  parseTelegramUserId,
  parseMinorAmount,
  parseCurrencyCode,
  formatMoney,
} from '../utils/validation.js';

const PROMPT_TTL_MS = 5 * 60 * 1000;
const FILES_PAGE_SIZE = 5;
const OWNER_ONLY_PROMPTS = new Set([
  'plan_add',
  'plan_stars_single',
  'stars_plan',
  'stars_paid',
  'stars_batch',
  'premium_grant',
  'premium_status',
  'premium_revoke',
  'payment_search',
  'fampay_all',
  'fampay_gmail',
  'fampay_upi',
  'auto_delete',
  'owner_broadcast',
  'owner_bot_prio',
]);

export const GUIDE_SECTIONS = {
  main: {
    title: 'Command Guide',
    body: [
      '━━━━━━━━━━━━━━━━━━',
      '📚 Choose a category below to view slash-command templates for bulk or scripted operations.',
      '✨ Most day-to-day actions are available directly via the Control Center buttons.',
      '🛡 All platform owner-only commands are consolidated under /admin (run /admin help for the full owner menu).',
      '',
      '📤 Media Indexing: Send or forward any video, document, photo, audio, or animation directly to this chat.',
      '🔗 Shareable Links: Use /link for 1 media file or /Batch for up to 20 media files, and /links to view, edit, or rename.',
      '✖ Cancel Prompt: /cancel exits any active guided input prompt.',
    ].join('\n'),
  },
  storage: {
    title: 'Storage & Files Commands',
    body: [
      '━━━━━━━━━━━━━━━━━━',
      '🔗 /link [code] — Generate shareable link for 1 media file',
      '📦 /Batch [title] — Interactive batch link builder (up to 20 items)',
      '📋 /links — View, edit, rename & delete share links',
      '🗑 /link_delete <code_or_id> — Delete a share link',
      '✅ /done — Finish active /Batch collection',
      '🗄 /storage — List storage channels',
      '➕ /storage_add <channel_id|@username> — Add & test channel',
      '🧪 /storage_test <channel_id> — Test channel permissions',
      '⚡ /storage_enable <channel_id> · /storage_disable <channel_id>',
      '⭐ /storage_primary <channel_id> — Set primary channel',
      '🗑 /storage_remove <channel_id> — Remove or disable channel',
      '📁 /files — Latest indexed files',
      '🔎 /find <query> — Search files by name or code',
      '📄 /fileinfo <code> — View full file metadata',
    ].join('\n'),
  },
  delivery: {
    title: 'Delivery & Auto-Delete Commands',
    body: [
      '━━━━━━━━━━━━━━━━━━',
      '🤖 /delivery_bots — List managed delivery bots',
      '➕ /delivery_bot_add <token> — Register & launch delivery bot',
      '⏯ /delivery_bot_pause <id> · /delivery_bot_resume <id>',
      '🔄 /delivery_bot_restart <id> · ⭐ /delivery_bot_primary <id>',
      '🔢 /delivery_bot_priority <id> <1-100000> · 🧪 /delivery_bot_test <id>',
      '🗑 /delivery_bot_remove <id>',
      '📦 /admin delivery_jobs — Recent jobs · ↻ /admin delivery_retry <job_id>',
      '⏱ /admin auto_delete [minutes] · /admin auto_delete_off · /admin auto_delete_failed',
    ].join('\n'),
  },
  access: {
    title: 'Force-Sub & Shortener Commands',
    body: [
      '━━━━━━━━━━━━━━━━━━',
      '🔒 /force_sub — List force-sub channels',
      '➕ /force_sub_add <channel_id|@username> <https_join_url>',
      '🧪 /force_sub_test <id> · ✅ /force_sub_enable <id> · ⏸ /force_sub_disable <id>',
      '🗑 /force_sub_remove <id> · 🌐 /force_sub_global_on · /force_sub_global_off',
      '⚡ /shorteners — List providers',
      '➕ /shortener_add base_url|api_key (or name|base_url|api_key|mins|prio)',
      '🔑 /shortener_key <id> <api_key> · 🧪 /shortener_test <id>',
      '✅ /shortener_enable <id> · ⏸ /shortener_disable <id> · 🗑 /shortener_remove <id>',
      '⏱ /shortener_duration <id> <mins> · 🔢 /shortener_priority <id> <prio>',
      '🔐 /checkpoint_global_on · /checkpoint_global_off',
    ].join('\n'),
  },
  payments: {
    title: 'Premium & Payment Commands (Owner /admin)',
    body: [
      '━━━━━━━━━━━━━━━━━━',
      '💎 /admin plans — List platform Premium plans',
      '➕ /admin plan_add name|price|currency|days',
      '✏ /admin plan_edit id|name|price|currency|days|true|false · 🗑 /admin plan_remove <id>',
      '🎁 /admin premium_grant <user_id> <plan_id> [days] · 🚫 /admin premium_revoke <user_id> · 🔍 /admin premium_status <user_id>',
      '⚙ /admin payment_methods · ✅ /admin payment_enable <telegram_stars|fampay> · ⏸ /admin payment_disable <method>',
      '💳 /admin fampay_set gmail|app_password|upi_id|[merchant] · 🧪 /admin payment_test <method>',
      '⭐ /admin stars_set <premium|paid_file|paid_batch> <id_or_code> <stars>',
      '🔧 /admin payment_set method|secret|public_json',
      '📊 /admin payments · /admin payment_recent · /admin payment_analytics · 🔎 /admin payment_search <term>',
      '🧾 /admin payment_detail <id> · ↻ /admin payment_reconcile <id> · /admin payment_apply <id>',
      '⚠️ /admin payment_recovery_pending · ⏳ /admin payment_sessions_expired',
    ].join('\n'),
  },
  paid: {
    title: 'Paid & Batch Link Commands',
    body: [
      '━━━━━━━━━━━━━━━━━━',
      '💎 /plink — Interactive Paid Link creator (Single or Batch media)',
      '🏷 /paid_links · 📥 /admin paid_requests',
      '⏸ /paid_link_disable <code> · 🗑 /paid_link_delete <code_or_id>',
      '✅ /admin paid_confirm <code> <user_id>',
      '📚 /batch_links · 📥 /admin batch_requests',
      '⏸ /batch_link_disable <code> · 🗑 /batch_link_delete <code_or_id>',
      '✅ /admin batch_confirm <code> <user_id>',
      '💸 /admin withdrawals · /admin withdraw_approve <id> [utr] · /admin withdraw_reject <id> [note]',
    ].join('\n'),
  },
};

export const CREATOR_GUIDE_SECTIONS = {
  overview: {
    label: '📘 Start',
    title: '📘 FileStore Link Creator Guide',
    body: [
      'This Telegram bot is focused on <b>creating file links</b> fast — while all workspace settings live in your <b>Web Control Panel</b>.',
      '',
      '<b>🚀 How It Works</b>',
      '<blockquote><b>1. Set Up on Website (/token)</b> — Open the Web Control Panel to connect your Storage Channel, Delivery Bot, Force-Sub, URL Shorteners, Premium Plans, Broadcasts, and Payout UPI ID.\n' +
        '<b>2. Upload Media Here</b> — Send or forward any video, file, photo, or audio directly to this chat.\n' +
        '<b>3. Create Links in Telegram</b> — Generate free single links (/link), batches up to 20 files (/Batch), or monetized paid links (/plink).\n' +
        '<b>4. Manage Everything Online</b> — Track opens, edit prices/shorteners, and withdraw INR earnings on the Web Control Panel.</blockquote>',
      '',
      '<b>⚡ Link &amp; Panel Commands</b>',
      '• /link — Share link for 1 media file',
      '• /Batch — Share link for up to 20 media files',
      '• /plink — Create paid link (Single or Batch)',
      '• /links — View, rename, edit, or delete links',
      '• /token — Get or regenerate your Web Control Panel token',
      '• /guide — Open this interactive guide anytime',
      '• /cancel — Exit any active link step',
      '',
      '<i>Tap any topic button below for step-by-step details.</i>',
    ].join('\n'),
  },
  links: {
    label: '🔗 Free Links',
    title: '🔗 Free Share Links & Batch Guide',
    body: [
      'Share single files or full collections with clean Telegram deep links.',
      '',
      '<b>1️⃣ Single Media Link (/link)</b>',
      '<blockquote>• Run /link (or tap <b>Single Link</b> in the menu).\n' +
        '• Send/forward 1 video, photo, document, or audio.\n' +
        '• Get an instant shareable link ready to post anywhere.</blockquote>',
      '',
      '<b>2️⃣ Batch Link — Up to 20 Files (/Batch)</b>',
      '<blockquote>• Run /Batch (optionally add a title like <code>/Batch Movie Pack</code>).\n' +
        '• Send up to <b>20 media files</b> one by one or as an album.\n' +
        '• Tap <b>✅ Finish &amp; Generate</b> or send /done when finished.</blockquote>',
      '',
      '<b>3️⃣ Manage, Edit &amp; Delete (/links)</b>',
      '<blockquote>• Open /links or the Web Control Panel to see every generated link.\n' +
        '• Copy URLs, <b>rename</b> titles, add/remove batch files, pause/resume, or <b>delete</b> links.\n' +
        '• Quick search: /files, /find &lt;keyword&gt;, /fileinfo &lt;code&gt;.</blockquote>',
    ].join('\n'),
  },
  paid: {
    label: '💎 Paid & Plans',
    title: '💎 Paid Links (/plink) & Web Premium Plans',
    body: [
      'Create paid links directly in Telegram with /plink, and configure your VIP Premium membership plans from the Web Control Panel (/token).',
      '',
      '<b>✨ 1. Paid Links in Telegram (/plink)</b>',
      '<blockquote><b>Step 1:</b> Run /plink and choose <b>Single Media</b> or <b>Batch (2–20 files)</b>.\n' +
        '<b>Step 2:</b> Send your media (for Batch, tap <b>Done</b> and enter a bundle title).\n' +
        '<b>Step 3:</b> Set your price in one message:\n' +
        '  • UPI only: <code>99 INR</code>\n' +
        '  • UPI + Stars: <code>99 INR | 50 stars</code>\n' +
        '  • Stars only: <code>50 stars</code>\n' +
        '  • Optional expiry: <code>99 INR | 7d</code></blockquote>',
      '',
      '<b>👑 2. Your Premium Plans (Configured on Website)</b>',
      '<blockquote>• Open the <b>Web Control Panel (/token → My Premium Plans)</b> to create, edit, or set Telegram Stars prices on your VIP tiers.\n' +
        '• Buyers who purchase your plan skip <b>your</b> URL shortener checkpoints automatically.\n' +
        '• Payments credit directly to your Creator Wallet balance.</blockquote>',
      '',
      '<b>ℹ Important Note</b>',
      '• Premium memberships bypass free URL-shortener checkpoints only and never unlock paid links (/plink).',
    ].join('\n'),
  },
  setup: {
    label: '🌐 Web Setup',
    title: '🌐 Website Setup: Storage & Delivery Bot',
    body: [
      'All creator setup is handled in the <b>Web Control Panel (/token)</b> so this bot stays fast and clean for creating file links.',
      '',
      '<b>🗄 Add Storage Channel on Website</b>',
      '<blockquote><b>1.</b> Create a private Telegram channel and add <b>this Main Bot</b> as Administrator (with <b>Post Messages</b> permission).\n' +
        '<b>2.</b> Also add your Delivery Bot (if using your own) as Administrator.\n' +
        '<b>3.</b> Open <b>Web Control Panel → Channels → Add Storage Channel</b>, enter <code>-100...</code> or <code>@username</code>, and verify access live.</blockquote>',
      '',
      '<b>🤖 Connect Custom Delivery Bot on Website</b>',
      '<blockquote><b>1.</b> Create a bot in @BotFather and copy its token.\n' +
        '<b>2.</b> <b>Required:</b> Add your own Storage Channel and make both bots Administrators — <b>otherwise delivery will not work!</b>\n' +
        '<b>3.</b> Open <b>Web Control Panel → Setup &amp; Delivery Bots → Connect Delivery Bot</b> and paste the token.</blockquote>',
      '<b>🌐 Opening the Panel</b>',
      '<blockquote>Tap <b>Web Control Panel</b> in the menu (or send /token) to open your dashboard.</blockquote>',
    ].join('\n'),
  },
  short: {
    label: '⚡ Shorteners',
    title: '⚡ Shorteners, Force-Sub & Broadcasts on Website',
    body: [
      'Configure your monetization, channel gates, and subscriber broadcasts from the <b>Web Control Panel</b>.',
      '',
      '<b>🔗 URL Shorteners (Web Panel → Shorteners)</b>',
      '<blockquote>• Add one or multiple shortener providers with Base URL, API key, unlock duration, and priority.\n' +
        '• Edit credentials, run <b>Test API</b> live, and toggle Checkpoints ON/OFF in one click.</blockquote>',
      '',
      '<b>🔒 Force-Sub Channels (Web Panel → Channels)</b>',
      '<blockquote>• Add channels where the bot is Administrator, test permissions, and toggle Force-Sub ON/OFF globally.</blockquote>',
      '',
      '<b>📢 Broadcasts (Web Panel → Broadcasts)</b>',
      '<blockquote>• Send text announcements with optional HTTPS action buttons to all users of your Delivery Bot.</blockquote>',
    ].join('\n'),
  },
  earn: {
    label: '💰 Wallet & UPI',
    title: '💰 Wallet & Payouts on Web Control Panel',
    body: [
      'Track all earnings from your paid links and Creator Premium plans, and withdraw INR directly to your UPI ID from the <b>Web Control Panel → Wallet &amp; Payouts</b>.',
      '',
      '<b>💸 Web Payout Flow</b>',
      '<blockquote><b>1.</b> Open <b>Web Control Panel → Wallet &amp; Payouts</b>.\n' +
        '<b>2.</b> Save your UPI ID (e.g. <code>yourname@fam</code> or <code>name@okaxis</code>).\n' +
        '<b>3.</b> Request a withdrawal anytime your balance reaches <b>₹1.00 INR</b>.\n' +
        '<b>4.</b> You receive an instant Telegram notification as soon as the transfer is marked <b>Paid</b> with UTR reference.</blockquote>',
    ].join('\n'),
  },
};

const PROMPT_CONFIGS = {
  owner_broadcast: { back: 'cc:owner_broadcast:bot', prompt: '📢 Send text or attach a photo/video/document/GIF. Optional URL buttons: add lines like Button: Open Channel | https://t.me/example.' },
  creator_broadcast: {
    back: 'cc:broadcast',
    prompt: '📢 Send text or attach a photo/video/document/GIF. Optional URL buttons: add lines like Button: Open Channel | https://t.me/example.',
  },
  storage_add: {
    back: 'cc:storage',
    prompt: '🗄 Send the Telegram channel ID (e.g. -1001234567890), @username, t.me link — OR forward any post from your channel.\n\n⚠️ Make sure this Main Bot is added as an Administrator (with Post Messages permission) in that channel first.',
  },
  find: {
    back: 'cc:files:0',
    prompt: '🔎 Send a filename keyword or file code to search your indexed files:',
  },
  delivery_bot_add: {
    back: 'cc:bots',
    prompt: '🤖 Send the @BotFather token for the Delivery Bot.\n🔒 Your message will be deleted immediately for security.',
  },
  bot_replace: {
    back: 'cc:bots',
    prompt: '🔄 Send the new @BotFather token to replace this Delivery Bot.\n🔒 Your message will be deleted immediately, and all existing links stay active.',
  },
  force_sub_add: {
    back: 'cc:fsub',
    prompt: '🔒 Send the channel identifier and HTTPS join link separated by a space:\n<channel_id or @username> <https://t.me/...>',
  },
  plan_add: {
    back: 'cc:plans',
    prompt: '💎 Send the Premium plan details separated by pipes:\nname|price|currency|duration_days|stars_price(optional)\n\n📌 Examples:\nMonthly|99|INR|30\nMonthly|99|INR|30|50',
  },
  cplan_add: {
    back: 'cc:cplans',
    prompt: [
      '👑 Create Your Premium Membership Plan',
      '━━━━━━━━━━━━━━━━━━',
      '',
      'Send plan details separated by pipes:',
      'name|price_inr|duration_days|stars_price(optional)',
      '',
      '📌 Examples:',
      'VIP Monthly|99|30',
      'VIP Monthly|99|30|50',
      'Weekly Pass|29|7',
      '',
      '💡 Payments are collected via platform Owner UPI / Stars checkout and credited automatically to your /me wallet!',
    ].join('\n'),
  },
  stars_plan: {
    back: 'cc:stars_cfg',
    prompt: '⭐ Send the Plan ID and Telegram Stars price separated by a pipe:\nPLAN_ID|STARS\n\n📌 Example: 1|50\n(Use 1|0 to remove the Stars price)',
  },
  stars_paid: {
    back: 'cc:stars_cfg',
    prompt: '⭐ Send the Paid File Link ID (or public code) and Stars price separated by a pipe:\nLINK_ID_OR_CODE|STARS\n\n📌 Example: 1|25\n(Use 1|0 to remove the Stars price)',
  },
  stars_batch: {
    back: 'cc:stars_cfg',
    prompt: '⭐ Send the Batch Link ID (or public code) and Stars price separated by a pipe:\nBATCH_ID_OR_CODE|STARS\n\n📌 Example: 1|100\n(Use 1|0 to remove the Stars price)',
  },
  premium_grant: {
    back: 'cc:plans',
    prompt: '🎁 Send the user ID, plan ID, and optional override days:\n<user_id> <plan_id> [days]',
  },
  premium_status: {
    back: 'cc:plans',
    prompt: '🔍 Send the numeric Telegram user ID to inspect Premium membership:',
  },
  premium_revoke: {
    back: 'cc:plans',
    prompt: '🚫 Send the numeric Telegram user ID to revoke active Premium membership:',
  },
  payment_search: {
    back: 'cc:payments',
    prompt: '🔎 Send a transaction ID, Telegram user ID, UTR, or external reference to search payments:',
  },
  fampay_all: {
    back: 'cc:fampay_cfg',
    prompt: '💳 Send your Gmail + App Password + FamPay UPI ID separated by pipes:\ngmail_email|gmail_app_password|upi_id|merchant_name(optional)\n\n📌 Example:\nyourname@gmail.com|abcd efgh ijkl mnop|yourname@fam|FileStore\n\n🔒 Your message will be deleted immediately for security.',
  },
  fampay_gmail: {
    back: 'cc:fampay_cfg',
    prompt: '📧 Send your Gmail address and 16-char Google App Password separated by a pipe:\ngmail_email|gmail_app_password\n\n📌 Example: yourname@gmail.com|abcd efgh ijkl mnop\n\n🔒 Your message will be deleted immediately for security.',
  },
  fampay_upi: {
    back: 'cc:fampay_cfg',
    prompt: '📲 Send your FamPay UPI ID (and optional display name):\nupi_id|merchant_name(optional)\n\n📌 Example: yourname@fam|FileStore',
  },
  auto_delete: {
    back: 'cc:autodel',
    prompt: '⏱ Send auto-delete delay in minutes (1–10080), or 0 to turn auto-delete OFF:',
  },
  shortener_add: {
    back: 'cc:short',
    prompt: [
      '➕ Add URL Shortener · Step 1 of 3',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '🌐 Send the Base URL of your shortener:',
      '📌 Example: https://shrinkme.io',
      '',
      '💡 (Or paste base_url|api_key for quick setup)',
    ].join('\n'),
  },
  shortener_wiz_key: {
    back: 'cc:short',
    prompt: '🔑 Send the API Key for this shortener provider.\n🔒 Your message will be deleted immediately for security.',
  },
  shortener_wiz_dur: {
    back: 'cc:short',
    prompt: '⏱ Send checkpoint unlock duration in minutes (1–10080, e.g. 1440 for 24h):',
  },
  shortener_name: {
    back: 'cc:short',
    prompt: '🏷 Send the new display name for this shortener (1–80 characters):',
  },
  shortener_url: {
    back: 'cc:short',
    prompt: '🌐 Send the new Base URL (e.g. https://shrinkme.io).\nThis will also update the default /api endpoint:',
  },
  shortener_ep: {
    back: 'cc:short',
    prompt: '🔌 Send the full HTTPS API endpoint URL (e.g. https://shrinkme.io/api):',
  },
  shortener_key: {
    back: 'cc:short',
    prompt: '🔑 Send the new API key for this shortener provider.\n🔒 Your message will be deleted immediately for security.',
  },
  shortener_dur: {
    back: 'cc:short',
    prompt: '⏱ Send checkpoint unlock duration in minutes (1–10080, e.g. 1440 for 24h):',
  },
  shortener_prio: {
    back: 'cc:short',
    prompt: '🔢 Send priority number (1–100000, lower number runs first):',
  },
  owner_bot_prio: {
    back: 'cc:all_bots:0',
    prompt: '🔢 Send new priority number for this delivery bot (0–100000, lower runs first):',
  },
};

export function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Dashboard', callback_data: 'cc:dash' },
        { text: '🩺 Health', callback_data: 'cc:health' },
      ],
      [
        { text: '🔗 Single Link (/link)', callback_data: 'cc:cmd_link' },
        { text: '📦 Batch Link (/Batch)', callback_data: 'cc:cmd_batch' },
      ],
      [
        { text: '🗄 Storage Channels', callback_data: 'cc:storage' },
        { text: '🤖 Delivery Bots', callback_data: 'cc:bots' },
      ],
      [
        { text: '📦 Delivery Jobs', callback_data: 'cc:jobs' },
        { text: '⏱ Auto-Delete', callback_data: 'cc:autodel' },
      ],
      [
        { text: '🔒 Force-Sub', callback_data: 'cc:fsub' },
        { text: '🔗 Shorteners', callback_data: 'cc:short' },
      ],
      [
        { text: '💎 Premium Plans', callback_data: 'cc:plans' },
        { text: '💳 Payments', callback_data: 'cc:payments' },
      ],
      [
        { text: '💎 Paid Link (/plink)', callback_data: 'cc:plink' },
        { text: '💸 Withdrawals', callback_data: 'cc:wdq:pending:0' },
      ],
      [
        { text: '💰 Balance (/me)', callback_data: 'cc:me' },
        { text: '📖 Command Guide', callback_data: 'cc:guide:main' },
      ],
      [
        { text: '🛡 /admin Commands', callback_data: 'cc:admin_cmds:home' },
        { text: '🌐 Web Panel Token', callback_data: 'cc:webtok' },
      ],
      [
        { text: '👑 Broadcast for Creator', callback_data: 'cc:owner_broadcast' },
        { text: '🌐 All Delivery Bots', callback_data: 'cc:all_bots:0' },
      ],
      [
        { text: '↻ Refresh Overview', callback_data: 'cc:home' },
      ],
    ],
  };
}

export function buildPublicMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔗 Single Link', callback_data: 'cc:cmd_link' },
        { text: '📦 Batch Link', callback_data: 'cc:cmd_batch' },
      ],
      [
        { text: '💎 Paid Link', callback_data: 'cc:plink' },
        { text: '📋 My Links', callback_data: 'cc:links:0' },
      ],
      [
        { text: '🤖 My Delivery Bot', callback_data: 'cc:bots' },
        { text: '🎁 Refer & Earn', callback_data: 'cc:referral' },
      ],
      [
        { text: '🌐 Web Control Panel', callback_data: 'cc:webtok' },
      ],
      [
        { text: '📘 Link Guide', callback_data: 'cc:uguide:overview' },
        { text: '↻ Refresh', callback_data: 'cc:home' },
      ],
    ],
  };
}

export function registerControlCenter(bot, config, logger, pool, options = {}) {
  const deliveryManager = config.deliveryManager;
  const pendingPrompts = new Map();
  const broadcastDrafts = new Map();
  const shortenerDrafts = new Map();

  function isOwnerAdmin(ctx) {
    return !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
  }

  function getOwnerScope(ctx) {
    return isOwnerAdmin(ctx) ? null : Number(ctx.from?.id);
  }

  function denyAdminOnly(ctx) {
    return safeAnswer(ctx, 'Restricted to platform owner/admin.', true);
  }

  function setBroadcastDraft(userId, draft) {
    broadcastDrafts.set(String(userId), { ...draft, expiresAt: Date.now() + 15 * 60 * 1000 });
  }

  function getBroadcastDraft(userId) {
    const key = String(userId);
    const entry = broadcastDrafts.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      broadcastDrafts.delete(key);
      return null;
    }
    return entry;
  }

  function clearBroadcastDraft(userId) {
    broadcastDrafts.delete(String(userId));
  }

  function pickCreatorBroadcastBot(bots = []) {
    const active = bots.filter((b) => b.is_enabled && b.runtime_status === 'running');
    return active.find((b) => b.role === 'primary') ?? active[0] ?? null;
  }

  function setShortenerDraft(userId, draft) {
    shortenerDrafts.set(String(userId), { ...draft, expiresAt: Date.now() + PROMPT_TTL_MS });
  }

  function getShortenerDraft(userId) {
    const key = String(userId);
    const entry = shortenerDrafts.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      shortenerDrafts.delete(key);
      return null;
    }
    return entry;
  }

  function clearShortenerDraft(userId) {
    shortenerDrafts.delete(String(userId));
  }

  function setPrompt(userId, action, options = {}) {
    const cfg = PROMPT_CONFIGS[action];
    const back = options.back ?? cfg?.back;
    if (!cfg && !back) throw new Error('Unknown prompt action');
    pendingPrompts.set(String(userId), {
      action,
      back,
      meta: options.meta ?? null,
      expiresAt: Date.now() + PROMPT_TTL_MS,
    });
    return cfg;
  }

  function getActivePrompt(userId) {
    const key = String(userId);
    const entry = pendingPrompts.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      pendingPrompts.delete(key);
      return null;
    }
    return entry;
  }

  function clearPrompt(userId) {
    pendingPrompts.delete(String(userId));
    options.onClearAdminPrompt?.(userId);
  }

  let shareLinksUi;
  let walletUi;
  const paidLinksUi = registerPaidLinksUi(bot, logger, pool, {
    config,
    clearOtherSessions(userId) {
      clearPrompt(userId);
      shareLinksUi?.clearSession(userId);
      walletUi?.clearSession(userId);
    },
  });
  shareLinksUi = registerShareLinksUi(bot, logger, pool, {
    config,
    clearPrompt(userId) {
      clearPrompt(userId);
      paidLinksUi.clearSession(userId);
      walletUi?.clearSession(userId);
    },
  });
  walletUi = registerWalletUi(bot, config, logger, pool, {
    adminBot: options.adminBot,
    clearOtherSessions(userId) {
      clearPrompt(userId);
      clearShortenerDraft(userId);
      shareLinksUi.clearSession(userId);
      paidLinksUi.clearSession(userId);
    },
  });
  registerWebTokenUi(bot, config, logger, pool, {
    clearOtherSessions(userId) {
      clearPrompt(userId);
      clearShortenerDraft(userId);
      shareLinksUi.clearSession(userId);
      paidLinksUi.clearSession(userId);
      walletUi.clearSession(userId);
    },
  });

  async function showHome(ctx, edit = false) {
    if (!isOwnerAdmin(ctx)) {
      const creatorId = Number(ctx.from.id);
      const displayName = escapeHtml(ctx.from?.first_name || ctx.from?.username || 'Creator');
      let lines = [
        '✨ <b>FileStore Creator Hub</b>',
        '━━━━━━━━━━━━━━━━━━',
        `👋 Welcome, <b>${displayName}</b>!`,
        '',
      ];
      try {
        const [wallet, ownStorage, ownBots, shorteners, ownPlans, fileCountRes, linkCountRes, sharedStorage, sharedBotUsername] = await Promise.all([
          getCreatorWalletSummary(pool, creatorId),
          listStorageChannels(pool, creatorId),
          deliveryManager.list(creatorId),
          listShortenerProviders(pool, creatorId),
          listPremiumPlans(pool, creatorId).catch(() => []),
          pool.query("SELECT COUNT(*)::int AS total FROM files WHERE status = 'active' AND uploaded_by = $1", [creatorId]),
          pool.query(
            `SELECT (
               (SELECT COUNT(*)::int FROM share_links WHERE created_by = $1) +
               (SELECT COUNT(*)::int FROM paid_file_links WHERE created_by = $1) +
               (SELECT COUNT(*)::int FROM paid_batch_links WHERE created_by = $1)
             ) AS total`,
            [creatorId],
          ).catch(() => ({ rows: [{ total: 0 }] })),
          listStorageChannels(pool, null).catch(() => []),
          getShareableBotUsername(pool, null).catch(() => null),
        ]);
        const activeOwnStorage = ownStorage.filter((c) => c.is_enabled).length;
        const activeOwnBot = ownBots.find((b) => b.is_enabled);
        const enabledShorts = shorteners.filter((s) => s.is_enabled).length;
        const activePlans = ownPlans.filter((p) => p.is_enabled).length;
        const storageStatus = activeOwnStorage
          ? `✅ ${activeOwnStorage} Custom`
          : sharedStorage.some((c) => c.is_enabled)
            ? '☁️ Shared (Auto)'
            : '⚠️ Set up in Web Panel';
        const botStatus = activeOwnBot
          ? `✅ @${escapeHtml(activeOwnBot.username)}`
          : sharedBotUsername
            ? `☁️ @${escapeHtml(sharedBotUsername)} (Shared)`
            : '⚠️ Not connected';
        const chkBadge = wallet.settings.checkpoint_enabled ? '🟢 ON' : '⚪ OFF';
        const fsubBadge = wallet.settings.force_sub_enabled ? '🟢 ON' : '⚪ OFF';
        const availableText = escapeHtml(formatMoney(wallet.inrWallet.available_minor, 'INR'));
        const lockedText = escapeHtml(formatMoney(wallet.inrWallet.locked_minor, 'INR'));
        const earnedText = escapeHtml(formatMoney(wallet.inrWallet.total_earned_minor, 'INR'));
        const xtrLine = wallet.xtrWallet && Number(wallet.xtrWallet.total_earned_minor) > 0
          ? `\n⭐ <b>Stars Earned:</b> <code>${Number(wallet.xtrWallet.total_earned_minor)} XTR</code>`
          : '';
        const upiStatus = wallet.settings.payout_upi_id
          ? `<code>${escapeHtml(wallet.settings.payout_upi_id)}</code>`
          : '<i>Not set</i>';

        lines = [
          '✨ <b>FileStore Creator Hub</b>',
          '━━━━━━━━━━━━━━━━━━',
          `👋 Welcome, <b>${displayName}</b>!`,
          '<i>Create file links here · Manage settings on the Web Panel.</i>',
          '',
          '📊 <b>Workspace Overview</b>',
          `<blockquote>📁 <b>Files:</b> <code>${fileCountRes.rows[0]?.total ?? 0}</code>  |  🔗 <b>Links:</b> <code>${linkCountRes.rows[0]?.total ?? 0}</code>\n` +
            `🗄 <b>Storage:</b> ${storageStatus}\n` +
            `🤖 <b>Delivery Bot:</b> ${botStatus}\n` +
            `⚡ <b>Shorteners:</b> <code>${enabledShorts}</code> active (${chkBadge})\n` +
            `🔒 <b>Force-Sub:</b> ${fsubBadge}  |  👑 <b>Plans:</b> <code>${activePlans}</code></blockquote>`,
          '',
          '💰 <b>Creator Wallet</b>',
          `<blockquote>💵 <b>Available:</b> <code>${availableText}</code>\n` +
            `⏳ <b>Locked:</b> <code>${lockedText}</code>\n` +
            `📈 <b>Total Earned:</b> <code>${earnedText}</code>${xtrLine}\n` +
            `📲 <b>Payout UPI:</b> ${upiStatus}</blockquote>`,
          '',
          '⚡ <b>Create File Links</b>',
          '<blockquote>• Send or forward media here to upload\n' +
            '• /link — Single file link\n' +
            '• /Batch — Bundle up to 20 files\n' +
            '• /plink — Monetized paid link\n' +
            '• /links — Manage &amp; edit links</blockquote>',
          '',
          '🌐 <b>Bot &amp; Web Setup</b>',
          '<i>Tap <b>🤖 My Delivery Bot</b> to connect your own bot, or <b>🌐 Web Control Panel</b> (/token) for channels, shorteners, plans &amp; payouts.</i>',
        ];
      } catch (error) {
        logger.warn({ creatorId, error: error.message }, 'Creator hub summary fallback');
        lines.push(
          '<i>Send media here or choose an option below to create links or open the Web Control Panel.</i>',
        );
      }
      return renderView(ctx, lines.join('\n'), buildPublicMenuKeyboard(), edit, true, { parse_mode: 'HTML' });
    }

    let summaryLines = [];
    try {
      const [stats, health, autoDeleteMin] = await Promise.all([
        getAdminDashboardStats(pool),
        getOperationalHealth(pool),
        getAutoDeleteMinutes(pool),
      ]);
      const revenue = Object.entries(stats.revenue_by_currency ?? {})
        .map(([currency, minor]) => formatMoney(minor, currency))
        .join(' · ') || 'none';
      const alerts = health.warnings.length ? `⚠️ ${health.warnings.length} alert(s)` : '🟢 All systems nominal';
      summaryLines = [
        '🎛 <b>FileStore Control Center</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `<blockquote>📁 <b>Files: ${stats.files_active} active</b> · 🗄 <b>Storage:</b> ${stats.storage_channels_active} · 🤖 <b>Bots:</b> ${stats.delivery_bots_active}\n` +
          `📬 <b>Queue:</b> ${stats.jobs_pending} pending · ${stats.jobs_processing} active · ${stats.jobs_failed} failed\n` +
          `👥 <b>Users:</b> ${stats.users_total} · 💎 <b>Premium:</b> ${stats.premium_active}\n` +
          `💰 <b>Revenue:</b> <code>${escapeHtml(revenue)}</code>\n` +
          `⏱ <b>Auto-Delete:</b> ${autoDeleteMin ? autoDeleteMin + 'm' : 'OFF'} · 🩺 <b>Health:</b> ${alerts}</blockquote>`,
        '',
        '🚀 <i>Send media directly here to index, or choose a management panel below:</i>',
      ];
    } catch (error) {
      logger.warn({ error: error.message }, 'Control Center overview stats fallback');
      summaryLines = [
        '🎛 <b>FileStore Control Center</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        '🚀 <i>Send supported media here to store and index it, or choose a management panel below:</i>',
      ];
    }
    return renderView(ctx, summaryLines.join('\n'), buildMainMenuKeyboard(), edit, true, { parse_mode: 'HTML' });
  }

  async function showDashboard(ctx, edit = false) {
    const stats = await getAdminDashboardStats(pool);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🩺 Health', callback_data: 'cc:health' },
          { text: '📦 Jobs', callback_data: 'cc:jobs' },
          { text: '💳 Payments', callback_data: 'cc:payments' },
        ],
        [
          { text: '↻ Refresh', callback_data: 'cc:dash' },
          { text: '← Main Menu', callback_data: 'cc:home' },
        ],
      ],
    };
    return renderView(ctx, formatAdminDashboard(stats), keyboard, edit);
  }

  async function showHealth(ctx, edit = false) {
    const health = await getOperationalHealth(pool);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📦 Delivery Jobs', callback_data: 'cc:jobs' },
          { text: '⚠ Payment Recovery', callback_data: 'cc:pay_rec' },
        ],
        [
          { text: '⏱ Failed Deletions', callback_data: 'cc:autodel_failed' },
          { text: '📊 Dashboard', callback_data: 'cc:dash' },
        ],
        [
          { text: '↻ Refresh', callback_data: 'cc:health' },
          { text: '← Main Menu', callback_data: 'cc:home' },
        ],
      ],
    };
    return renderView(ctx, formatOperationalHealth(health), keyboard, edit);
  }

  async function showStorage(ctx, edit = false) {
    const ownerId = getOwnerScope(ctx);
    const rows = await listStorageChannels(pool, ownerId);
    let fallbackNote = '';
    if (!rows.length && ownerId !== null) {
      const platformChannels = await listStorageChannels(pool, null).catch(() => []);
      if (platformChannels.some((c) => c.is_enabled)) {
        fallbackNote = '\n\n☁️ Using the shared platform storage channel by default. Add your own Telegram channel below if you prefer dedicated storage.';
      }
    }
    const lines = rows.length
      ? rows.map((row) => {
          const badge = row.role === 'primary' ? '⭐ PRIMARY' : '🔹 Backup';
          const state = row.is_enabled ? '🟢 ON' : '⚪ OFF';
          return `#${row.id} · ${badge} · ${state}\n📢 ${row.title ?? 'Untitled channel'} (${row.telegram_chat_id})\n🧪 Test: ${row.last_test_status} · 🔢 Priority: ${row.priority}`;
        })
      : [`📭 No storage channels configured yet. Add one to store your uploaded files.${fallbackNote}`];
    const keyboard = rows.slice(0, 8).map((row) => [
      {
        text: `${row.role === 'primary' ? '⭐ ' : ''}${row.is_enabled ? '🟢' : '⚪'} ${(row.title ?? String(row.telegram_chat_id)).slice(0, 28)}`,
        callback_data: `cc:stg:${row.id}`,
      },
    ]);
    keyboard.push([{ text: '➕ Add Storage Channel', callback_data: 'cc:prompt:storage_add' }]);
    keyboard.push([
      { text: '↻ Refresh', callback_data: 'cc:storage' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, '🗄 Storage Channels\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function findOwnedStorageRow(id, ownerId) {
    if (ownerId === null) {
      const res = await pool.query('SELECT * FROM storage_channels WHERE id = $1 AND owner_telegram_id IS NULL LIMIT 1', [id]);
      return res.rows[0] ?? null;
    }
    const res = await pool.query('SELECT * FROM storage_channels WHERE id = $1 AND owner_telegram_id = $2 LIMIT 1', [id, Number(ownerId)]);
    return res.rows[0] ?? null;
  }

  async function showStorageDetail(ctx, id, edit = true, confirmDelete = false) {
    const ch = await findOwnedStorageRow(id, getOwnerScope(ctx));
    if (!ch) return showStorage(ctx, edit);
    const text = [
      `🗄 Storage Channel #${ch.id}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `📢 Title: ${ch.title ?? 'Untitled'}`,
      `🆔 Chat ID: ${ch.telegram_chat_id}`,
      `🔗 Username: ${ch.username ? '@' + ch.username : '—'}`,
      `🏷 Role: ${ch.role === 'primary' ? '⭐ PRIMARY' : ch.role.toUpperCase()}`,
      `📌 Status: ${ch.is_enabled ? '🟢 Enabled' : '⏸ Disabled'}`,
      `🔢 Priority: ${ch.priority}`,
      `🧪 Last test: ${ch.last_test_status}${ch.last_test_error ? ' (' + String(ch.last_test_error).slice(0, 120) + ')' : ''}`,
    ].join('\n');

    const rows = [
      [
        { text: '🧪 Test Permissions', callback_data: `cc:stg_test:${ch.id}` },
        ch.is_enabled
          ? { text: '⏸ Disable', callback_data: `cc:stg_dis:${ch.id}` }
          : { text: '✅ Enable', callback_data: `cc:stg_en:${ch.id}` },
      ],
    ];
    const secondRow = [];
    if (ch.role !== 'primary') secondRow.push({ text: '⭐ Set Primary', callback_data: `cc:stg_pri:${ch.id}` });
    if (confirmDelete) {
      secondRow.push({ text: '⚠ Confirm Remove', callback_data: `cc:stg_rm_ok:${ch.id}` });
      secondRow.push({ text: 'Cancel', callback_data: `cc:stg:${ch.id}` });
    } else {
      secondRow.push({ text: '🗑 Remove', callback_data: `cc:stg_rm:${ch.id}` });
    }
    rows.push(secondRow);
    rows.push([
      { text: '← Storage List', callback_data: 'cc:storage' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, text, { inline_keyboard: rows }, edit);
  }

  async function showFiles(ctx, page = 0, edit = false) {
    const safePage = Math.max(0, Number(page) || 0);
    const ownerId = getOwnerScope(ctx);
    const totalRes = ownerId === null
      ? await pool.query("SELECT COUNT(*)::int AS total FROM files WHERE status = 'active'")
      : await pool.query("SELECT COUNT(*)::int AS total FROM files WHERE status = 'active' AND uploaded_by = $1", [ownerId]);
    const total = Number(totalRes.rows[0]?.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / FILES_PAGE_SIZE));
    const activePage = Math.min(safePage, pages - 1);
    const { rows } = ownerId === null
      ? await pool.query(
          `SELECT file_code, file_name, file_type, file_size, created_at
           FROM files WHERE status = 'active'
           ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
          [FILES_PAGE_SIZE, activePage * FILES_PAGE_SIZE],
        )
      : await pool.query(
          `SELECT file_code, file_name, file_type, file_size, created_at
           FROM files WHERE status = 'active' AND uploaded_by = $3
           ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
          [FILES_PAGE_SIZE, activePage * FILES_PAGE_SIZE, ownerId],
        );
    const unusedFilesCount = await countUnusedFilesForOwner(pool, ownerId).catch(() => 0);
    const text = [
      `📁 Indexed Files · Page ${activePage + 1} / ${pages} (${total} total)`,
      '━━━━━━━━━━━━━━━━━━',
      ...(unusedFilesCount > 0 ? [`<i>🧹 ${unusedFilesCount} file(s) are not attached to any active link.</i>`] : []),
      '',
      rows.length
        ? rows.map((f, i) => `${activePage * FILES_PAGE_SIZE + i + 1}. 📄 ${String(f.file_name).slice(0, 120)}\n🏷 Code: ${f.file_code} · 📦 ${f.file_type} · ${formatFileSize(f.file_size)}`).join('\n\n')
        : '📭 No files indexed yet. Send any supported media file to this bot to index it!',
    ].join('\n');
    const keyboard = rows.map((f) => [
      { text: `📄 ${f.file_code} · ${String(f.file_name).slice(0, 26)}`, callback_data: `cc:file:${f.file_code}` },
    ]);
    const utilRow = [{ text: '🔎 Search Files', callback_data: 'cc:prompt:find' }];
    if (unusedFilesCount > 0) {
      utilRow.push({ text: `🧹 Clean Unused (${unusedFilesCount})`, callback_data: 'cc:files_clean' });
    }
    keyboard.push(utilRow);
    const nav = [];
    if (activePage > 0) nav.push({ text: '← Prev', callback_data: `cc:files:${activePage - 1}` });
    nav.push({ text: '↻ Refresh', callback_data: `cc:files:${activePage}` });
    if (activePage < pages - 1) nav.push({ text: 'Next →', callback_data: `cc:files:${activePage + 1}` });
    keyboard.push(nav);
    keyboard.push([{ text: '← Main Menu', callback_data: 'cc:home' }]);
    return renderView(ctx, text, { inline_keyboard: keyboard }, edit, true, { parse_mode: 'HTML' });
  }

  async function showFileDetail(ctx, code, edit = true, confirmDelete = false) {
    const file = await getIndexedFile(pool, code, getOwnerScope(ctx));
    if (!file) return showFiles(ctx, 0, edit);
    const text = [
      '📄 File Details',
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 Code: ${file.file_code}`,
      `📄 Name: ${file.file_name}`,
      `🎬 Type: ${file.file_type}`,
      `📦 Size: ${formatFileSize(file.file_size)}`,
      `🔧 MIME: ${file.mime_type ?? 'unknown'}`,
      `🗄 Storage: ${file.storage_title ?? file.storage_chat_id ?? 'unknown'}`,
      `🆔 Storage msg ID: ${file.telegram_message_id ?? 'unknown'}`,
      '',
      `⚡ User get command: /get ${file.file_code}`,
      ...(confirmDelete ? ['', '⚠️ Are you sure you want to remove this file?'] : []),
    ].join('\n');
    const deleteRow = confirmDelete
      ? [
          { text: '⚠ Confirm Delete File', callback_data: `cc:fdel_ok:${file.file_code}` },
          { text: 'Cancel', callback_data: `cc:file:${file.file_code}` },
        ]
      : [{ text: '🗑 Delete File', callback_data: `cc:fdel:${file.file_code}` }];
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔗 Generate Share Link', callback_data: `cc:mklink:${file.file_code}` },
          { text: '✏ Rename File', callback_data: `cc:frename:${file.file_code}` },
        ],
        deleteRow,
        [
          { text: '← Files List', callback_data: 'cc:files:0' },
          { text: '← Main Menu', callback_data: 'cc:home' },
        ],
      ],
    };
    return renderView(ctx, text, keyboard, edit);
  }

  async function getCreatorSlotsSnapshot(ownerId, isOwner, existingBots = []) {
    const raw = await getCreatorBotSlotQuota(pool, ownerId, isOwner);
    if (raw.isUnlimited) return raw;
    const usedSlots = Math.max(Number(raw.usedSlots ?? 0), existingBots.length);
    const totalAllowed = Math.max(1, Number(raw.totalAllowed ?? 1));
    const remainingSlots = Math.max(0, totalAllowed - usedSlots);
    return {
      ...raw,
      usedSlots,
      totalAllowed,
      remainingSlots,
    };
  }

  async function showBots(ctx, edit = false) {
    const ownerId = getOwnerScope(ctx);
    const isOwner = isOwnerAdmin(ctx);
    const [rows, storageRows, slots] = await Promise.all([
      deliveryManager.list(ownerId),
      ownerId !== null ? listStorageChannels(pool, ownerId).catch(() => []) : Promise.resolve([]),
      getCreatorSlotsSnapshot(ownerId, isOwner),
    ]);
    const effectiveSlots = slots.isUnlimited
      ? slots
      : {
          ...slots,
          usedSlots: Math.max(slots.usedSlots, rows.length),
          remainingSlots: Math.max(0, slots.totalAllowed - Math.max(slots.usedSlots, rows.length)),
        };
    const hasOwnStorage = ownerId === null || storageRows.some((c) => c.is_enabled);
    let fallbackNote = '';
    if (!rows.length && ownerId !== null) {
      const sharedUsername = await getShareableBotUsername(pool, null).catch(() => null);
      if (sharedUsername) {
        fallbackNote = `\n\n☁️ Currently using shared platform Delivery Bot @${sharedUsername}. Adding your own Delivery Bot gives you a branded clone!`;
      }
    }
    const slotLine = effectiveSlots.isUnlimited
      ? '🎟 Bot Slots: Unlimited (Platform Owner)'
      : `🎟 Bot Slots: ${effectiveSlots.usedSlots}/${effectiveSlots.totalAllowed} used (${effectiveSlots.remainingSlots} available · ${effectiveSlots.freeSlots} free${effectiveSlots.extraSlots > 0 ? ` + ${effectiveSlots.extraSlots} unlocked` : ''})`;
    const storageRequirementNote = ownerId !== null && !hasOwnStorage
      ? '\n\n⚠️ IMPORTANT REQUIREMENT:\nIf you add your own Delivery Bot, you MUST also add your own Storage Channel (and make both the Main Bot and your Delivery Bot Administrators in it) — otherwise your Delivery Bot will NOT work!'
      : '';
    const lines = [slotLine];
    if (rows.length) {
      lines.push(
        rows.map((row) => `#${row.id} · 🤖 @${row.username} (${row.role === 'primary' ? '⭐ PRIMARY' : row.role.toUpperCase()})\n⚡ Runtime: ${row.runtime_status === 'running' ? '🟢 running' : '🟡 ' + row.runtime_status} · Enabled: ${row.is_enabled ? '✅' : '⏸'} · Priority: ${row.priority}${row.last_error ? '\n⚠️ Error: ' + String(row.last_error).slice(0, 120) : ''}`).join('\n\n'),
      );
    } else {
      lines.push(`🤖 No custom Delivery Bots registered yet. Add one with the button below.${fallbackNote}`);
    }
    if (!effectiveSlots.isUnlimited && effectiveSlots.remainingSlots === 0) {
      lines.push(
        `🔒 Slot limit reached (${effectiveSlots.usedSlots}/${effectiveSlots.totalAllowed}). Unlock +1 slot or tap a bot below to Change Bot without losing any links.`,
      );
    }
    if (storageRequirementNote) lines.push(storageRequirementNote.trim());
    const keyboard = rows.slice(0, 8).map((row) => [
      {
        text: `${row.role === 'primary' ? '⭐ ' : ''}${row.runtime_status === 'running' ? '🟢' : '🟡'} @${row.username} (#${row.id})`,
        callback_data: `cc:bot:${row.id}`,
      },
    ]);
    if (effectiveSlots.isUnlimited || effectiveSlots.remainingSlots > 0) {
      keyboard.push([{ text: '➕ Add Delivery Bot', callback_data: 'cc:prompt:delivery_bot_add' }]);
    } else {
      const slotPriceLabel = formatMoney(effectiveSlots.priceMinor, effectiveSlots.currency || 'INR');
      keyboard.push([{ text: `🔓 Unlock +1 Slot (${slotPriceLabel})`, callback_data: 'cc:slot_unlock' }]);
      if (rows.length === 1) {
        keyboard.push([{ text: `🔄 Change @${String(rows[0].username).slice(0, 22)}`, callback_data: `cc:bot_replace:${rows[0].id}` }]);
      }
    }
    if (isOwner) {
      keyboard.push([{ text: '🌐 All Delivery Bots (Owner)', callback_data: 'cc:all_bots:0' }]);
    }
    if (ownerId !== null && !hasOwnStorage) {
      keyboard.push([{ text: '🗄 Add Storage Channel (Required)', callback_data: 'cc:prompt:storage_add' }]);
    }
    keyboard.push([
      { text: '↻ Refresh', callback_data: 'cc:bots' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, '🤖 Delivery Bots\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showCloneBotScreen(ctx, edit = false) {
    if (isOwnerAdmin(ctx)) {
      const bots = await deliveryManager.list(null).catch(() => []);
      const lines = [
        '🤖 <b>Create Your Own Delivery Bot</b> · <i>Owner Mode</i>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `<blockquote>🎟 <b>Bot Slots:</b> Unlimited (Platform Owner)\n🤖 <b>Connected Platform Bots:</b> <code>${bots.length}</code></blockquote>`,
        '',
        '👇 Tap <b>➕ Add Delivery Bot</b> to register another bot, or manage existing bots below.',
      ];
      const keyboard = [
        [{ text: '➕ Add Delivery Bot', callback_data: 'cc:prompt:delivery_bot_add' }],
        [
          { text: '🤖 My Delivery Bots', callback_data: 'cc:bots' },
          { text: '🌐 All Bots', callback_data: 'cc:all_bots:0' },
        ],
        [{ text: '🎛 Main Menu', callback_data: 'cc:home' }],
      ];
      return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, { parse_mode: 'HTML' });
    }

    const creatorId = Number(ctx.from.id);
    const [bots, storageRows, rawSlots] = await Promise.all([
      deliveryManager.list(creatorId),
      listStorageChannels(pool, creatorId).catch(() => []),
      getCreatorBotSlotQuota(pool, creatorId, false),
    ]);
    const usedSlots = Math.max(Number(rawSlots.usedSlots ?? 0), bots.length);
    const totalAllowed = Math.max(1, Number(rawSlots.totalAllowed ?? 1));
    const remainingSlots = Math.max(0, totalAllowed - usedSlots);
    const hasOwnStorage = storageRows.some((c) => c.is_enabled);
    const priceLabel = formatMoney(rawSlots.priceMinor, rawSlots.currency || 'INR');
    const starsSuffix = rawSlots.starsPrice ? ` · ${Number(rawSlots.starsPrice)}★` : '';

    const botSummary = bots.length
      ? bots
          .slice(0, 5)
          .map((b) => `• ${b.role === 'primary' ? '⭐ ' : ''}@${escapeHtml(b.username)} — ${b.runtime_status === 'running' ? '🟢 running' : `🟡 ${escapeHtml(b.runtime_status)}`}`)
          .join('\n')
      : '<i>No custom Delivery Bot connected yet.</i>';

    const lines = [
      '🤖 <b>Create Your Own Delivery Bot</b>',
      '━━━━━━━━━━━━━━━━━━',
      '<i>Launch your own branded clone bot powered by FileStore!</i>',
      '',
      '<blockquote>🎟 <b>Your Bot Slots:</b> <code>' + `${usedSlots} / ${totalAllowed}` + '</code> used (<code>' + remainingSlots + '</code> available)\n'
      + `🆓 <b>Allowance:</b> ${rawSlots.freeSlots} free bot${rawSlots.extraSlots > 0 ? ` + ${rawSlots.extraSlots} unlocked` : ''}\n`
      + `🗄 <b>Storage Channel:</b> ${hasOwnStorage ? '✅ Connected' : '⚠️ Not added yet'}</blockquote>`,
      '',
      '🤖 <b>Connected Bots</b>',
      `<blockquote>${botSummary}</blockquote>`,
    ];

    const keyboard = [];
    if (remainingSlots > 0) {
      lines.push(
        '',
        '⚡ <b>Quick 3-Step Setup</b>',
        '<blockquote><b>1.</b> Create a bot in <code>@BotFather</code> &amp; copy its token\n'
        + '<b>2.</b> Add your Storage Channel &amp; make both bots Admins\n'
        + '<b>3.</b> Tap <b>➕ Add My Delivery Bot</b> below &amp; paste your token</blockquote>',
      );
      if (!hasOwnStorage) {
        lines.push('', '⚠️ <i>You must add your own Storage Channel — otherwise your Delivery Bot will not deliver files.</i>');
      }
      keyboard.push([{ text: '➕ Add My Delivery Bot', callback_data: 'cc:prompt:delivery_bot_add' }]);
      if (!hasOwnStorage) {
        keyboard.push([{ text: '🗄 Add Storage Channel', callback_data: 'cc:prompt:storage_add' }]);
      }
    } else {
      lines.push(
        '',
        '🔒 <b>Slot Limit Reached</b>',
        `<blockquote>You have used all <code>${usedSlots}/${totalAllowed}</code> Delivery Bot slots.\n\n`
        + `• <b>Unlock +1 Slot</b> (${escapeHtml(priceLabel)}${starsSuffix}) to add another bot\n`
        + '• Or <b>Change Bot</b> to replace an old/deleted bot — all existing links keep working!</blockquote>',
      );
      keyboard.push([{ text: `🔓 Unlock +1 Slot (${priceLabel})`, callback_data: 'cc:slot_unlock' }]);
      if (bots.length === 1) {
        keyboard.push([{ text: `🔄 Change @${String(bots[0].username).slice(0, 22)}`, callback_data: `cc:bot_replace:${bots[0].id}` }]);
      }
    }

    if (bots.length > 0) {
      keyboard.push([{ text: '🤖 Manage My Bots', callback_data: 'cc:bots' }]);
    }
    keyboard.push([
      { text: '🌐 Web Control Panel', callback_data: 'cc:webtok' },
      { text: '🎛 Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, { parse_mode: 'HTML' });
  }

  async function showSlotUnlockScreen(ctx, edit = true, { limitReached = false } = {}) {
    if (isOwnerAdmin(ctx)) {
      await safeAnswer(ctx, 'Platform owners already have unlimited delivery bot slots.', true);
      return showBots(ctx, edit);
    }
    const creatorId = Number(ctx.from.id);
    const [bots, rawSlots, wallet, fpCfg, starsCfg] = await Promise.all([
      deliveryManager.list(creatorId),
      getCreatorBotSlotQuota(pool, creatorId, false),
      getCreatorWalletSummary(pool, creatorId).catch(() => ({ inrWallet: { available_minor: 0 } })),
      loadFamPayConfig(pool, config.tokenEncryptionKey).catch(() => ({ isEnabled: false, isConfigured: false })),
      loadStarsConfig(pool).catch(() => ({ isEnabled: false })),
    ]);
    const usedSlots = Math.max(Number(rawSlots.usedSlots ?? 0), bots.length);
    const totalAllowed = Math.max(1, Number(rawSlots.totalAllowed ?? 1));
    const remainingSlots = Math.max(0, totalAllowed - usedSlots);
    const priceLabel = formatMoney(rawSlots.priceMinor, rawSlots.currency || 'INR');
    const walletAvail = Number(wallet?.inrWallet?.available_minor ?? 0);
    const walletLabel = formatMoney(walletAvail, 'INR');
    const canWallet = walletAvail >= Number(rawSlots.priceMinor || 0);
    const fampayReady = Boolean(fpCfg?.isEnabled && fpCfg?.isConfigured);
    const starsReady = Boolean(starsCfg?.isEnabled && rawSlots.starsPrice);

    const lines = [
      limitReached ? '🔒 <b>Delivery Bot Slot Limit Reached</b>' : '🔓 <b>Unlock +1 Delivery Bot Slot</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      `<blockquote>🎟 <b>Current Slots:</b> <code>${usedSlots} / ${totalAllowed}</code> used (<code>${remainingSlots}</code> free)\n`
      + `➕ <b>After Unlock:</b> <code>${totalAllowed} → ${totalAllowed + 1}</code> bot slots\n`
      + `💳 <b>Slot Price:</b> <code>${escapeHtml(priceLabel)}</code>${rawSlots.starsPrice ? ` · <code>${Number(rawSlots.starsPrice)}★</code>` : ''}\n`
      + `💰 <b>Wallet Balance:</b> <code>${escapeHtml(walletLabel)}</code></blockquote>`,
    ];

    if (bots.length) {
      lines.push(
        '',
        '💡 <i>Need to replace a deleted or old bot without buying a slot? Tap Change Bot to swap its token while keeping all your links active.</i>',
      );
    }

    const keyboard = [];
    if (remainingSlots > 0 && !limitReached) {
      keyboard.push([{ text: '➕ Add Delivery Bot (Slot Available)', callback_data: 'cc:prompt:delivery_bot_add' }]);
    }
    if (canWallet) {
      keyboard.push([{ text: `💰 Pay ${priceLabel} from Wallet`, callback_data: 'cc:slot_pay_wallet' }]);
    }
    if (fampayReady) {
      keyboard.push([{ text: `📲 Pay ${priceLabel} via UPI QR`, callback_data: 'cc:slot_pay_upi' }]);
    }
    if (starsReady) {
      keyboard.push([{ text: `⭐ Pay ${Number(rawSlots.starsPrice)} Stars`, callback_data: 'cc:slot_pay_stars' }]);
    }
    if (!canWallet && !fampayReady && !starsReady) {
      lines.push('', `⚠️ <i>No payment gateway is active right now and your wallet balance is below ${escapeHtml(priceLabel)}.</i>`);
    }
    if (bots.length === 1) {
      keyboard.push([{ text: `🔄 Change @${String(bots[0].username).slice(0, 22)}`, callback_data: `cc:bot_replace:${bots[0].id}` }]);
    } else if (bots.length > 1) {
      keyboard.push([{ text: '🤖 Manage / Change Existing Bot', callback_data: 'cc:bots' }]);
    }
    keyboard.push([
      { text: '🌐 Open Web Panel', callback_data: 'cc:webtok' },
      { text: '← My Bots', callback_data: 'cc:bots' },
    ]);
    keyboard.push([{ text: '🎛 Main Menu', callback_data: 'cc:home' }]);

    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, { parse_mode: 'HTML' });
  }

  async function findOwnedBotRow(id, ownerId) {
    if (ownerId === null) {
      const res = await pool.query(
        'SELECT id, telegram_bot_id, username, role, priority, is_enabled, runtime_status, last_health_at, last_error FROM delivery_bots WHERE id = $1 AND owner_telegram_id IS NULL LIMIT 1',
        [id],
      );
      return res.rows[0] ?? null;
    }
    const res = await pool.query(
      'SELECT id, telegram_bot_id, username, role, priority, is_enabled, runtime_status, last_health_at, last_error FROM delivery_bots WHERE id = $1 AND owner_telegram_id = $2 LIMIT 1',
      [id, Number(ownerId)],
    );
    return res.rows[0] ?? null;
  }

  async function showBotDetail(ctx, id, edit = true, confirmDelete = false) {
    const botRow = await findOwnedBotRow(id, getOwnerScope(ctx));
    if (!botRow) return showBots(ctx, edit);
    const text = [
      `🤖 Delivery Bot #${botRow.id}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 Username: @${botRow.username}`,
      `🆔 Telegram ID: ${botRow.telegram_bot_id}`,
      `⭐ Role: ${botRow.role.toUpperCase()}`,
      `⚡ Runtime: ${botRow.runtime_status === 'running' ? '🟢 running' : '🟡 ' + botRow.runtime_status}`,
      `📌 Enabled: ${botRow.is_enabled ? '✅ Yes' : '⏸ No'}`,
      `🔢 Priority: ${botRow.priority}`,
      `🩺 Last health: ${botRow.last_health_at ? new Date(botRow.last_health_at).toISOString() : '—'}`,
      `⚠️ Last error: ${botRow.last_error ? String(botRow.last_error).slice(0, 200) : 'none'}`,
    ].join('\n');

    const rows = [
      [
        { text: '🧪 Test Access', callback_data: `cc:bot_test:${botRow.id}` },
        botRow.runtime_status === 'paused'
          ? { text: '▶ Resume', callback_data: `cc:bot_res:${botRow.id}` }
          : { text: '⏸ Pause', callback_data: `cc:bot_pause:${botRow.id}` },
      ],
      [
        { text: '🔄 Restart', callback_data: `cc:bot_rst:${botRow.id}` },
        { text: '🔄 Change Bot Token', callback_data: `cc:bot_replace:${botRow.id}` },
      ],
    ];
    if (botRow.role !== 'primary') {
      rows.push([{ text: '⭐ Set Primary', callback_data: `cc:bot_pri:${botRow.id}` }]);
    }
    if (confirmDelete) {
      rows.push([
        { text: '⚠ Confirm Remove', callback_data: `cc:bot_rm_ok:${botRow.id}` },
        { text: 'Cancel', callback_data: `cc:bot:${botRow.id}` },
      ]);
    } else {
      rows.push([{ text: '🗑 Remove Bot', callback_data: `cc:bot_rm:${botRow.id}` }]);
    }
    rows.push([
      { text: '← Bots List', callback_data: 'cc:bots' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, text, { inline_keyboard: rows }, edit);
  }

  async function showAllBotsForOwner(ctx, page = 0, edit = true) {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const { rows, uniqueBotUsers } = await listAllDeliveryBotsForOwner(pool, { q: '', scope: 'all', status: 'all' });
    const PAGE_SIZE = 6;
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const runningCount = rows.filter((b) => b.is_enabled && b.runtime_status === 'running').length;
    const platformCount = rows.filter((b) => b.owner_telegram_id === null || b.owner_telegram_id === undefined).length;
    const creatorCount = rows.length - platformCount;

    const header = [
      '🌐 <b>All Delivery Bots (Owner)</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '<blockquote>📊 <b>Fleet Overview</b>\n' +
        `🤖 <b>Bots:</b> <code>${rows.length}</code> total  ·  🟢 <code>${runningCount}</code> running\n` +
        `👑 <b>Platform:</b> <code>${platformCount}</code>  ·  👤 <b>Creator:</b> <code>${creatorCount}</code>\n` +
        `👥 <b>Unique Bot Users:</b> <code>${uniqueBotUsers}</code></blockquote>`,
    ];

    const bodyLines = slice.length
      ? slice.map((b) => {
          const isPlatform = b.owner_telegram_id === null || b.owner_telegram_id === undefined;
          const scopeLabel = isPlatform
            ? '👑 <b>Owner:</b> Platform'
            : `👤 <b>Owner:</b> Creator <code>${escapeHtml(b.owner_telegram_id)}</code>${b.owner_username ? ` (@${escapeHtml(b.owner_username)})` : ''}`;
          const statusLabel = !b.is_enabled
            ? '⏸ Disabled'
            : b.runtime_status === 'running'
              ? '🟢 Running'
              : `🟡 ${escapeHtml(b.runtime_status)}`;
          const roleBadge = String(b.role).toUpperCase() === 'PRIMARY'
            ? '⭐ <b>PRIMARY</b>'
            : `🔁 <b>${escapeHtml(String(b.role).toUpperCase())}</b>`;
          return [
            `🤖 <b>#${b.id} · @${escapeHtml(b.username)}</b>`,
            `<blockquote>${scopeLabel}\n` +
              `${roleBadge}  ·  ${statusLabel}  ·  🔢 <b>Prio:</b> <code>${Number(b.priority || 0)}</code>\n` +
              `👥 <b>Total Users: ${Number(b.total_users || 0)}</b> <i>(${Number(b.active_users_7d || 0)} 7d · ${Number(b.total_interactions || 0)} hits)</i>  ·  🗄 <b>Storage:</b> <code>${Number(b.storage_channels_count || 0)}</code></blockquote>`,
          ].join('\n');
        })
      : ['📭 <i>No delivery bots registered on the platform yet.</i>'];

    const keyboard = slice.map((b) => [
      {
        text: `${b.is_enabled && b.runtime_status === 'running' ? '🟢' : !b.is_enabled ? '⏸' : '🟡'} #${b.id} @${String(b.username).slice(0, 18)} · 👥 ${Number(b.total_users || 0)}`,
        callback_data: `cc:all_bot:${b.id}`,
      },
    ]);

    if (totalPages > 1) {
      const navRow = [];
      if (safePage > 0) navRow.push({ text: '◀ Prev', callback_data: `cc:all_bots:${safePage - 1}` });
      navRow.push({ text: `Page ${safePage + 1}/${totalPages}`, callback_data: `cc:all_bots:${safePage}` });
      if (safePage < totalPages - 1) navRow.push({ text: 'Next ▶', callback_data: `cc:all_bots:${safePage + 1}` });
      keyboard.push(navRow);
    }

    keyboard.push([
      { text: '↻ Refresh', callback_data: `cc:all_bots:${safePage}` },
      { text: '← My Bots', callback_data: 'cc:bots' },
    ]);
    keyboard.push([{ text: '← Main Menu', callback_data: 'cc:home' }]);

    const footer = slice.length ? ['', '👇 <i>Tap a bot below to inspect details, users, or edit settings.</i>'] : [];
    const messageText = [...header, '', bodyLines.join('\n\n'), ...footer].join('\n');
    return renderView(ctx, messageText, { inline_keyboard: keyboard }, edit, true, { parse_mode: 'HTML' });
  }

  async function showOwnerBotDetail(ctx, id, edit = true, confirmDelete = false) {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const details = await getDeliveryBotDetailsForOwner(pool, id);
    if (!details) return showAllBotsForOwner(ctx, 0, edit);
    const { bot: b, recentUsers, storageChannels, forceSubChannels } = details;
    const isPlatform = b.owner_telegram_id === null || b.owner_telegram_id === undefined;
    const ownerLabel = isPlatform
      ? '👑 Platform Default'
      : `👤 Creator <code>${escapeHtml(b.owner_telegram_id)}</code>${b.owner_username ? ` (@${escapeHtml(b.owner_username)})` : b.owner_first_name ? ` (${escapeHtml(b.owner_first_name)})` : ''}`;
    const runtimeLabel = !b.is_enabled
      ? '⏸ Disabled'
      : b.runtime_status === 'running'
        ? '🟢 Running'
        : `🟡 ${escapeHtml(b.runtime_status)}`;
    const roleBadge = String(b.role).toUpperCase() === 'PRIMARY'
      ? '⭐ <b>PRIMARY</b>'
      : `🔁 <b>${escapeHtml(String(b.role).toUpperCase())}</b>`;
    const healthAt = b.last_health_at ? `${new Date(b.last_health_at).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—';
    const lastErr = b.last_error ? escapeHtml(String(b.last_error).slice(0, 180)) : '';

    const lines = [
      `🤖 <b>Delivery Bot #${b.id} (Owner View)</b>`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      '<blockquote>🪪 <b>Identity &amp; Runtime</b>\n' +
        `🏷 <b>Username:</b> @${escapeHtml(b.username)}\n` +
        `🆔 <b>Bot ID:</b> <code>${escapeHtml(b.telegram_bot_id)}</code>\n` +
        `👤 <b>Owner:</b> ${ownerLabel}\n` +
        `${roleBadge}  ·  🔢 <b>Priority:</b> <code>${Number(b.priority || 0)}</code>\n` +
        `📌 <b>Enabled:</b> ${b.is_enabled ? '✅ Yes' : '⏸ No'}  ·  ⚡ ${runtimeLabel}</blockquote>`,
      '',
      '<blockquote>📊 <b>Audience &amp; Delivery</b>\n' +
        `👥 <b>Total Users: ${Number(b.total_users || 0)}</b> <i>(7d: ${Number(b.active_users_7d || 0)} · Hits: ${Number(b.total_interactions || 0)})</i>\n` +
        `📦 <b>Jobs:</b> <code>${Number(b.jobs_total || 0)}</code> total <i>(${Number(b.jobs_completed || 0)} ok · ${Number(b.jobs_failed || 0)} failed · ${Number(b.jobs_pending || 0)} pending)</i>\n` +
        `🗄 <b>Storage Channels:</b> <code>${storageChannels.length}</code>  ·  🔒 <b>Force-Sub:</b> <code>${forceSubChannels.length}</code></blockquote>`,
      '',
      '<blockquote>🩺 <b>Health &amp; Diagnostics</b>\n' +
        `🕒 <b>Last Check:</b> <code>${escapeHtml(healthAt)}</code>\n` +
        `⚠️ <b>Last Error:</b> ${lastErr ? `<code>${lastErr}</code>` : '<i>None</i>'}</blockquote>`,
    ];

    if (recentUsers.length) {
      const userLines = recentUsers.slice(0, 5).map((u) => {
        const uname = u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name || 'User');
        return `• ${uname} (<code>${escapeHtml(u.telegram_user_id)}</code>) — <b>${Number(u.interaction_count || 0)}</b> hits`;
      });
      lines.push('');
      lines.push(`<blockquote>🕒 <b>Recent Users</b>\n${userLines.join('\n')}</blockquote>`);
    }

    const rows = [
      [
        { text: '🧪 Test Access', callback_data: `cc:all_bot_test:${b.id}` },
        b.runtime_status === 'paused' || !b.is_enabled
          ? { text: '▶ Resume', callback_data: `cc:all_bot_res:${b.id}` }
          : { text: '⏸ Pause', callback_data: `cc:all_bot_pause:${b.id}` },
      ],
      [
        { text: '🔄 Restart', callback_data: `cc:all_bot_rst:${b.id}` },
        b.is_enabled
          ? { text: '⏸ Disable', callback_data: `cc:all_bot_dis:${b.id}` }
          : { text: '✅ Enable', callback_data: `cc:all_bot_en:${b.id}` },
      ],
      [
        { text: '🔢 Edit Priority', callback_data: `cc:all_bot_prio:${b.id}` },
        ...(b.role !== 'primary' && b.is_enabled ? [{ text: '⭐ Set Primary', callback_data: `cc:all_bot_pri:${b.id}` }] : []),
      ],
    ];
    if (confirmDelete) {
      rows.push([
        { text: '⚠ Confirm Remove', callback_data: `cc:all_bot_rm_ok:${b.id}` },
        { text: 'Cancel', callback_data: `cc:all_bot:${b.id}` },
      ]);
    } else {
      rows.push([{ text: '🗑 Remove Bot', callback_data: `cc:all_bot_rm:${b.id}` }]);
    }
    rows.push([
      { text: '← All Delivery Bots', callback_data: 'cc:all_bots:0' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, lines.join('\n'), { inline_keyboard: rows }, edit, true, { parse_mode: 'HTML' });
  }

  async function showJobs(ctx, edit = false) {
    const jobs = await getRecentDeliveryJobs(pool, 8);
    const jobIcon = (st) => (st === 'completed' ? '✅' : st === 'failed' ? '❌' : st === 'processing' ? '⚡' : '⏳');
    const lines = jobs.length
      ? jobs.map((job) => `${jobIcon(job.status)} #${job.id} · ${String(job.status).toUpperCase()} · ${job.job_type}\n👤 User: ${job.requester_telegram_id} · 📦 ${job.delivered_count}/${job.item_count} delivered (${job.failed_count} failed, ${job.uncertain_count} uncertain)${job.last_error ? '\n⚠️ Error: ' + String(job.last_error).slice(0, 120) : ''}`)
      : ['📭 No delivery jobs recorded yet.'];
    const keyboard = jobs
      .filter((job) => job.status === 'failed')
      .slice(0, 5)
      .map((job) => [{ text: `↻ Retry Failed Job #${job.id}`, callback_data: `cc:job_retry:${job.id}` }]);
    keyboard.push([
      { text: '↻ Refresh', callback_data: 'cc:jobs' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, '📦 Recent Delivery Jobs\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showForceSub(ctx, edit = false) {
    const ownerId = getOwnerScope(ctx);
    const [globalEnabled, channels] = await Promise.all([
      getForceSubGlobal(pool, ownerId),
      listForceSubChannels(pool, ownerId),
    ]);
    const lines = [
      `🔒 Force-Subscription · ${ownerId === null ? 'Global' : 'My Setting'}: ${globalEnabled ? '🟢 ON' : '⚪ OFF'}\n━━━━━━━━━━━━━━━━━━`,
      ...(channels.length
        ? channels.map((c) => `#${c.id} · ${c.is_enabled ? '🟢 ON' : '⚪ OFF'} · 📢 ${c.title ?? c.telegram_chat_id}\n🆔 ID: ${c.telegram_chat_id} · 🧪 Test: ${c.last_test_status}\n🔗 Join: ${c.join_url}`)
        : ['📭 No force-subscription channels configured yet.']),
    ];
    const keyboard = [
      [
        globalEnabled
          ? { text: ownerId === null ? '🌐 Global OFF' : '🛑 Force-Sub OFF', callback_data: 'cc:fsub_g:0' }
          : { text: ownerId === null ? '🌐 Global ON' : '✅ Force-Sub ON', callback_data: 'cc:fsub_g:1' },
        { text: '➕ Add Channel', callback_data: 'cc:prompt:force_sub_add' },
      ],
      ...channels.slice(0, 8).map((c) => [
        { text: `${c.is_enabled ? '🟢' : '⚪'} ${(c.title ?? String(c.telegram_chat_id)).slice(0, 28)}`, callback_data: `cc:fsub_ch:${c.id}` },
      ]),
      [
        { text: '↻ Refresh', callback_data: 'cc:fsub' },
        { text: '← Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function findOwnedForceSubRow(id, ownerId) {
    if (ownerId === null) {
      const res = await pool.query('SELECT * FROM force_sub_channels WHERE id = $1 AND owner_telegram_id IS NULL LIMIT 1', [id]);
      return res.rows[0] ?? null;
    }
    const res = await pool.query('SELECT * FROM force_sub_channels WHERE id = $1 AND owner_telegram_id = $2 LIMIT 1', [id, Number(ownerId)]);
    return res.rows[0] ?? null;
  }

  async function showForceSubDetail(ctx, id, edit = true, confirmDelete = false) {
    const ch = await findOwnedForceSubRow(id, getOwnerScope(ctx));
    if (!ch) return showForceSub(ctx, edit);
    const text = [
      `🔒 Force-Sub Channel #${ch.id}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `📢 Title: ${ch.title ?? 'Untitled'}`,
      `🆔 Chat ID: ${ch.telegram_chat_id}`,
      `🔗 Join URL: ${ch.join_url}`,
      `📌 Status: ${ch.is_enabled ? '🟢 Enabled' : '⏸ Disabled'}`,
      `🧪 Last test: ${ch.last_test_status}`,
    ].join('\n');
    const rows = [
      [
        { text: '🧪 Test Admin', callback_data: `cc:fsub_test:${ch.id}` },
        ch.is_enabled
          ? { text: '⏸ Disable', callback_data: `cc:fsub_dis:${ch.id}` }
          : { text: '✅ Enable', callback_data: `cc:fsub_en:${ch.id}` },
      ],
      confirmDelete
        ? [
            { text: '⚠ Confirm Remove', callback_data: `cc:fsub_rm_ok:${ch.id}` },
            { text: 'Cancel', callback_data: `cc:fsub_ch:${ch.id}` },
          ]
        : [{ text: '🗑 Remove Channel', callback_data: `cc:fsub_rm:${ch.id}` }],
      [
        { text: '← Force-Sub', callback_data: 'cc:fsub' },
        { text: '← Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, text, { inline_keyboard: rows }, edit);
  }

  async function getCheckpointEnabledForScope(ownerId) {
    if (ownerId !== null && ownerId !== undefined) {
      const settings = await getCreatorSettings(pool, ownerId);
      return Boolean(settings.checkpoint_enabled);
    }
    const setting = await pool.query("SELECT value FROM app_settings WHERE key = 'checkpoint_enabled'");
    return setting.rowCount ? setting.rows[0].value === true : false;
  }

  async function showShorteners(ctx, edit = false) {
    const ownerId = getOwnerScope(ctx);
    const [checkpointEnabled, providers] = await Promise.all([
      getCheckpointEnabledForScope(ownerId),
      listShortenerProviders(pool, ownerId),
    ]);
    const enabledCount = providers.filter((p) => p.is_enabled).length;
    const lines = [
      `🔗 URL Shorteners & Checkpoints · Enforcement: ${checkpointEnabled ? 'ON' : 'OFF'}\n━━━━━━━━━━━━━━━━━━\n⚡ Active providers: ${enabledCount}/${providers.length} (multiple enabled shorteners rotate automatically by priority)`,
      ...(providers.length
        ? providers.map(
            (p) =>
              `#${p.id} 🌐 ${p.name} · ${p.is_enabled ? '🟢 ENABLED' : '⚪ DISABLED'}\n🔗 Base: ${p.base_url} · 🔑 Key: ${p.has_api_key ? '🔒 Saved' : '⚠️ Missing'}\n🔢 Priority: ${p.priority} · ⏱ Duration: ${p.checkpoint_minutes}m · 🧪 Test: ${p.last_test_status}`,
          )
        : ['📭 No URL shortener providers configured yet.\n💡 Tap "➕ Add Shortener" below to start interactive setup.']),
    ];
    const keyboard = [
      [
        { text: '➕ Add Shortener', callback_data: 'cc:short_new' },
        checkpointEnabled
          ? { text: '🛑 Checkpoints OFF', callback_data: 'cc:chk_g:0' }
          : { text: '✅ Checkpoints ON', callback_data: 'cc:chk_g:1' },
      ],
      ...providers.slice(0, 10).map((p) => [
        {
          text: `${p.is_enabled ? '🟢' : '⚪'} #${p.id} ${String(p.name).slice(0, 16)} · ${p.checkpoint_minutes}m`,
          callback_data: `cc:short_p:${p.id}`,
        },
        { text: '✏ Edit', callback_data: `cc:short_edit:${p.id}` },
        { text: '🗑', callback_data: `cc:short_rm:${p.id}` },
      ]),
      [
        { text: '📖 Guide', callback_data: 'cc:guide:access' },
        { text: '↻ Refresh', callback_data: 'cc:short' },
        { text: '← Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showShortenerDetail(ctx, id, edit = true, confirmDelete = false) {
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return showShorteners(ctx, edit);
    const text = [
      `🔗 Shortener Provider #${p.id}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 Name: ${p.name}`,
      `📌 Status: ${p.is_enabled ? '🟢 Enabled' : '⚪ Disabled'}`,
      `🌐 Base URL: ${p.base_url}`,
      `🔌 API Endpoint: ${p.api_endpoint}`,
      `🔑 API Key: ${p.api_key_ciphertext ? '🔒 Saved (encrypted)' : '⚠️ Not set'}`,
      `⏱ Checkpoint: ${p.checkpoint_minutes} min · 🔢 Priority: ${p.priority}`,
      `🧪 Mode: ${p.verification_mode} · Last test: ${p.last_test_status}`,
      ...(p.last_test_error ? [`⚠️ Last error: ${p.last_test_error}`] : []),
      ...(confirmDelete ? ['', '⚠️ Confirm deletion? This removes the provider immediately.'] : []),
    ].join('\n');
    const rows = confirmDelete
      ? [
          [
            { text: '⚠ Yes, Delete Provider', callback_data: `cc:short_rm_ok:${p.id}` },
            { text: '✖ Cancel', callback_data: `cc:short_p:${p.id}` },
          ],
          [
            { text: '← Shorteners', callback_data: 'cc:short' },
            { text: '← Main Menu', callback_data: 'cc:home' },
          ],
        ]
      : [
          [
            { text: '🧪 Test API', callback_data: `cc:short_test:${p.id}` },
            p.is_enabled
              ? { text: '⏸ Disable', callback_data: `cc:short_dis:${p.id}` }
              : { text: '✅ Enable', callback_data: `cc:short_en:${p.id}` },
          ],
          [
            { text: '✏ Edit Shortener', callback_data: `cc:short_edit:${p.id}` },
            { text: '🗑 Delete', callback_data: `cc:short_rm:${p.id}` },
          ],
          [
            { text: '← Shorteners', callback_data: 'cc:short' },
            { text: '← Main Menu', callback_data: 'cc:home' },
          ],
        ];
    return renderView(ctx, text, { inline_keyboard: rows }, edit);
  }

  async function showShortenerEdit(ctx, id, edit = true) {
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return showShorteners(ctx, edit);
    const text = [
      `✏️ Edit Shortener #${p.id}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 Name: ${p.name}`,
      `🌐 Base URL: ${p.base_url}`,
      `🔌 Endpoint: ${p.api_endpoint}`,
      `🔑 API Key: ${p.api_key_ciphertext ? '🔒 Saved' : '⚠️ Missing'}`,
      `⏱ Duration: ${p.checkpoint_minutes} min · 🔢 Priority: ${p.priority}`,
      '',
      '👇 Choose a field to edit:',
    ].join('\n');
    const rows = [
      [
        { text: '🏷 Edit Name', callback_data: `cc:short_name:${p.id}` },
        { text: '🌐 Edit Base URL', callback_data: `cc:short_url:${p.id}` },
      ],
      [
        { text: '🔌 Edit Endpoint', callback_data: `cc:short_ep:${p.id}` },
        { text: '🔑 Update API Key', callback_data: `cc:short_key:${p.id}` },
      ],
      [
        { text: `⏱ Duration (${p.checkpoint_minutes}m)`, callback_data: `cc:short_dur:${p.id}` },
        { text: `🔢 Priority (${p.priority})`, callback_data: `cc:short_prio:${p.id}` },
      ],
      [
        { text: '🧪 Test API', callback_data: `cc:short_test:${p.id}` },
        { text: '🗑 Delete', callback_data: `cc:short_rm:${p.id}` },
      ],
      [
        { text: '← Details', callback_data: `cc:short_p:${p.id}` },
        { text: '← Shorteners', callback_data: 'cc:short' },
      ],
    ];
    return renderView(ctx, text, { inline_keyboard: rows }, edit);
  }

  async function showPlans(ctx, edit = false) {
    const [plans, starsCfg] = await Promise.all([
      listPremiumPlans(pool),
      loadStarsConfig(pool).catch(() => ({ starsPrices: {} })),
    ]);
    const lines = plans.length
      ? plans.map((p) => {
          const stars = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'premium', { planId: p.id });
          return `#${p.id} · 💎 ${p.name} · ${p.is_enabled ? '🟢 ON' : '⚪ OFF'}\n💰 Price: ${formatMoney(p.price_minor, p.currency)}${stars ? ` · ${stars} ⭐` : ''} · ⏳ ${p.duration_days} days`;
        })
      : ['📭 No Premium plans configured yet.'];
    const keyboard = [
      ...plans.slice(0, 8).map((p) => {
        const stars = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'premium', { planId: p.id });
        return [{ text: `${p.is_enabled ? '🟢' : '⚪'} #${p.id} ${p.name} (${formatMoney(p.price_minor, p.currency)}${stars ? ` / ${stars}⭐` : ''})`, callback_data: `cc:plan:${p.id}` }];
      }),
      [
        { text: '➕ Add Plan', callback_data: 'cc:prompt:plan_add' },
        { text: '🎁 Grant Premium', callback_data: 'cc:prompt:premium_grant' },
      ],
      [
        { text: '🔍 User Status', callback_data: 'cc:prompt:premium_status' },
        { text: '🚫 Revoke User', callback_data: 'cc:prompt:premium_revoke' },
      ],
      [
        { text: '↻ Refresh', callback_data: 'cc:plans' },
        { text: '← Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, '💎 Premium Plans\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showPlanDetail(ctx, id, edit = true, confirmDelete = false) {
    const [res, starsCfg] = await Promise.all([
      pool.query('SELECT * FROM premium_plans WHERE id = $1 LIMIT 1', [id]),
      loadStarsConfig(pool).catch(() => ({ starsPrices: {} })),
    ]);
    const p = res.rows[0];
    if (!p) return showPlans(ctx, edit);
    const starsPrice = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'premium', { planId: p.id });
    const text = [
      `💎 Premium Plan #${p.id}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 Name: ${p.name}`,
      `💳 UPI / Fiat Price: ${formatMoney(p.price_minor, p.currency)}`,
      `⭐ Telegram Stars Price: ${starsPrice ? `${starsPrice} ⭐` : 'Not set'}`,
      `⏳ Duration: ${p.duration_days} day(s)`,
      `📌 Status: ${p.is_enabled ? '🟢 Enabled' : '⏸ Disabled'}`,
    ].join('\n');
    const rows = [
      [{ text: '⭐ Set Stars Price', callback_data: `cc:plan_stars:${p.id}` }],
      [
        p.is_enabled
          ? { text: '⏸ Disable', callback_data: `cc:plan_dis:${p.id}` }
          : { text: '✅ Enable', callback_data: `cc:plan_en:${p.id}` },
        ...(confirmDelete
          ? [{ text: '⚠ Confirm Delete', callback_data: `cc:plan_rm_ok:${p.id}` }, { text: 'Cancel', callback_data: `cc:plan:${p.id}` }]
          : [{ text: '🗑 Delete Plan', callback_data: `cc:plan_rm:${p.id}` }]),
      ],
      [
        { text: '← Plans', callback_data: 'cc:plans' },
        { text: '← Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, text, { inline_keyboard: rows }, edit);
  }

  async function showCreatorPlans(ctx, edit = false) {
    if (isOwnerAdmin(ctx)) {
      return showPlans(ctx, edit);
    }
    const creatorId = Number(ctx.from.id);
    const [plans, starsCfg, fpConfig, botUsername] = await Promise.all([
      listPremiumPlans(pool, creatorId),
      loadStarsConfig(pool).catch(() => ({ isEnabled: false, starsPrices: {} })),
      loadFamPayConfig(pool, config.tokenEncryptionKey).catch(() => ({ isEnabled: false, isConfigured: false })),
      getShareableBotUsername(pool, creatorId).catch(() => null),
    ]);
    const upiOn = fpConfig.isEnabled && fpConfig.isConfigured;
    const starsOn = Boolean(starsCfg.isEnabled);
    const storefrontUrl = botUsername ? buildShareableUrl(botUsername, `cprem_${creatorId}`) : null;

    const lines = [
      '👑 <b>My Premium Membership Plans</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '💡 <i>Sell your own ad-free Premium memberships! Buyers pay via platform Owner UPI / Stars checkout and earnings credit straight to your /me wallet.</i>',
      `💳 <b>Checkout Gateways:</b> UPI QR ${upiOn ? '🟢 ON' : '⚪ OFF'} · Telegram Stars ${starsOn ? '🟢 ON' : '⚪ OFF'}`,
      ...(storefrontUrl ? [`🔗 <b>All-Plans Share Link:</b>\n<code>${escapeHtml(storefrontUrl)}</code>`] : []),
      '',
    ];

    if (!plans.length) {
      lines.push('📭 <i>You have not created any Premium plans yet. Tap <b>➕ Create Plan</b> below to get started!</i>');
    } else {
      for (const p of plans) {
        const stars = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'premium', { planId: p.id });
        const planUrl = botUsername ? buildShareableUrl(botUsername, `prem_${p.id}`) : null;
        lines.push(
          `#${p.id} · 💎 <b>${escapeHtml(p.name)}</b> · ${p.is_enabled ? '🟢 ON' : '⚪ OFF'}\n` +
            `💰 ${escapeHtml(formatMoney(p.price_minor, p.currency))}${stars ? ` · ${stars} ⭐` : ''} · ⏳ ${p.duration_days} day(s)` +
            (planUrl ? `\n🔗 <code>${escapeHtml(planUrl)}</code>` : ''),
        );
      }
    }

    const keyboard = [
      ...plans.slice(0, 10).map((p) => {
        const stars = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'premium', { planId: p.id });
        return [{
          text: `${p.is_enabled ? '🟢' : '⚪'} #${p.id} ${p.name} (${formatMoney(p.price_minor, p.currency)}${stars ? ` / ${stars}⭐` : ''})`,
          callback_data: `cc:cplan:${p.id}`,
        }];
      }),
      [
        { text: '➕ Create Plan', callback_data: 'cc:prompt:cplan_add' },
        { text: '💰 Wallet', callback_data: 'cc:me' },
      ],
      [
        { text: '↻ Refresh', callback_data: 'cc:cplans' },
        { text: '← Creator Hub', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, { parse_mode: 'HTML' });
  }

  async function showCreatorPlanDetail(ctx, id, edit = true, confirmDelete = false) {
    if (isOwnerAdmin(ctx)) {
      return showPlanDetail(ctx, id, edit, confirmDelete);
    }
    const creatorId = Number(ctx.from.id);
    const [p, starsCfg, botUsername] = await Promise.all([
      getPremiumPlanById(pool, id, creatorId),
      loadStarsConfig(pool).catch(() => ({ isEnabled: false, starsPrices: {} })),
      getShareableBotUsername(pool, creatorId).catch(() => null),
    ]);
    if (!p) return showCreatorPlans(ctx, edit);
    const starsPrice = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'premium', { planId: p.id });
    const planUrl = botUsername ? buildShareableUrl(botUsername, `prem_${p.id}`) : null;
    const storefrontUrl = botUsername ? buildShareableUrl(botUsername, `cprem_${creatorId}`) : null;
    const text = [
      `👑 <b>My Premium Plan #${p.id}</b>`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 <b>Name:</b> ${escapeHtml(p.name)}`,
      `💳 <b>UPI Price:</b> <code>${escapeHtml(formatMoney(p.price_minor, p.currency))}</code>`,
      `⭐ <b>Telegram Stars Price:</b> ${starsPrice ? `<code>${starsPrice} ⭐</code>` : '<i>Not set</i>'}`,
      `⏳ <b>Duration:</b> ${p.duration_days} day(s)`,
      `📌 <b>Status:</b> ${p.is_enabled ? '🟢 Enabled' : '⏸ Disabled'}`,
      ...(planUrl ? ['', `🔗 <b>Direct Checkout Link:</b>\n<code>${escapeHtml(planUrl)}</code>`] : []),
      ...(storefrontUrl ? [`🏪 <b>All My Plans Link:</b>\n<code>${escapeHtml(storefrontUrl)}</code>`] : []),
      '',
      '💰 <i>Sales credit straight to your /me balance for UPI withdrawal.</i>',
    ].join('\n');
    const rows = [
      [{ text: '⭐ Set Stars Price', callback_data: `cc:cplan_stars:${p.id}` }],
      [
        p.is_enabled
          ? { text: '⏸ Disable', callback_data: `cc:cplan_dis:${p.id}` }
          : { text: '✅ Enable', callback_data: `cc:cplan_en:${p.id}` },
        ...(confirmDelete
          ? [{ text: '⚠ Confirm Delete', callback_data: `cc:cplan_rm_ok:${p.id}` }, { text: 'Cancel', callback_data: `cc:cplan:${p.id}` }]
          : [{ text: '🗑 Delete Plan', callback_data: `cc:cplan_rm:${p.id}` }]),
      ],
      [
        { text: '← My Plans', callback_data: 'cc:cplans' },
        { text: '← Creator Hub', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, text, { inline_keyboard: rows }, edit, true, { parse_mode: 'HTML' });
  }

  async function showPaymentsHub(ctx, edit = false) {
    const stats = await getPaymentReconciliationStats(pool);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🧾 Recent Transactions', callback_data: 'paymentrecent' },
          { text: '📊 Analytics (30d)', callback_data: 'paymentanalytics' },
        ],
        [
          { text: '🔎 Search Payments', callback_data: 'cc:prompt:payment_search' },
          { text: '⚙ Payment Gateways', callback_data: 'cc:pay_methods' },
        ],
        [
          { text: '💳 FamPay UPI', callback_data: 'cc:fampay_cfg' },
          { text: '⭐ Telegram Stars', callback_data: 'cc:stars_cfg' },
        ],
        [
          { text: '⚠ Recovery Queue', callback_data: 'cc:pay_rec' },
          { text: '⏳ Expired Sessions', callback_data: 'cc:pay_sessions' },
        ],
        [
          { text: '↻ Refresh', callback_data: 'cc:payments' },
          { text: '← Main Menu', callback_data: 'cc:home' },
        ],
      ],
    };
    return renderView(ctx, formatPaymentReconciliation(stats), keyboard, edit);
  }

  async function showPaymentMethods(ctx, edit = true) {
    const [fp, stars, rows] = await Promise.all([
      loadFamPayConfig(pool, config.tokenEncryptionKey),
      loadStarsConfig(pool),
      listPaymentMethods(pool),
    ]);
    const otherRows = rows.filter((r) => !['fampay', 'telegram_stars'].includes(r.method));
    const lines = [
      '⚙ Payment Gateways',
      '━━━━━━━━━━━━━━━━━━',
      '',
      `💳 FamPay UPI & Gmail: ${fp.isEnabled ? '🟢 ON' : '🔴 OFF'} · setup: ${fp.setupStatus} · test: ${fp.lastTestStatus}`,
      `   📲 UPI ID: ${fp.upiId ?? 'not set'} · 📧 Gmail: ${maskEmail(fp.gmailEmail)}`,
      '',
      `⭐ Telegram Stars (XTR): ${stars.isEnabled ? '🟢 ON' : '🔴 OFF'} · setup: ${stars.setupStatus} · test: ${stars.lastTestStatus}`,
      `   🏷 Configured prices: ${stars.counts.premium} plan(s), ${stars.counts.paid_file} file(s), ${stars.counts.paid_batch} batch(es)`,
    ];
    if (otherRows.length) {
      lines.push('', '🔹 Other gateways (not connected yet):');
      for (const r of otherRows) {
        lines.push(`• ${r.method} · planned`);
      }
    }
    const keyboard = [
      [
        { text: '💳 FamPay UPI & Gmail', callback_data: 'cc:fampay_cfg' },
        { text: '⭐ Telegram Stars Setup', callback_data: 'cc:stars_cfg' },
      ],
      [
        { text: '🧪 Test FamPay', callback_data: 'cc:pay_test:fampay' },
        fp.isEnabled
          ? { text: '⏸ Disable FamPay', callback_data: 'cc:pay_dis:fampay' }
          : { text: '✅ Enable FamPay', callback_data: 'cc:pay_en_fampay' },
      ],
      [
        { text: '🧪 Test Stars', callback_data: 'cc:pay_test:telegram_stars' },
        stars.isEnabled
          ? { text: '⏸ Disable Stars', callback_data: 'cc:pay_dis:telegram_stars' }
          : { text: '✅ Enable Stars', callback_data: 'cc:pay_en_stars' },
      ],
      [
        { text: '← Payments', callback_data: 'cc:payments' },
        { text: '← Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showFamPayConfig(ctx, edit = true) {
    const fp = await loadFamPayConfig(pool, config.tokenEncryptionKey);
    const text = [
      '💳 FamPay UPI & Gmail Verification',
      '━━━━━━━━━━━━━━━━━━',
      '',
      `📌 Status: ${fp.isEnabled ? '🟢 ENABLED' : '🔴 DISABLED'} · Setup: ${fp.setupStatus}`,
      `🧪 Last IMAP test: ${fp.lastTestStatus}${fp.lastTestError ? ' (' + fp.lastTestError.slice(0, 100) + ')' : ''}`,
      '',
      `📧 Gmail Address: ${maskEmail(fp.gmailEmail)}`,
      `🔑 Gmail App Password: ${fp.hasAppPassword ? '🔒 Saved (encrypted)' : '❌ Not set'}`,
      `📲 FamPay UPI ID: ${fp.upiId ?? '❌ Not set'}`,
      `🏪 Merchant Name: ${fp.merchantName}`,
      '',
      '⚡ How it works:',
      '1️⃣ Users pick a Premium plan, Paid file, or Batch and choose UPI QR.',
      '2️⃣ Bot generates a unique paise amount + UPI QR.',
      '3️⃣ Bot auto-verifies incoming FamPay payment emails via Gmail IMAP.',
    ].join('\n');
    const keyboard = {
      inline_keyboard: [
        [{ text: '⚡ Quick Setup (Gmail + App Pass + UPI)', callback_data: 'cc:prompt:fampay_all' }],
        [
          { text: '📧 Set Gmail & App Password', callback_data: 'cc:prompt:fampay_gmail' },
          { text: '📲 Set FamPay UPI ID', callback_data: 'cc:prompt:fampay_upi' },
        ],
        [
          { text: '🧪 Test Gmail IMAP', callback_data: 'cc:fampay_test' },
          fp.isEnabled
            ? { text: '⏸ Disable FamPay', callback_data: 'cc:fampay_dis' }
            : { text: '✅ Enable FamPay', callback_data: 'cc:pay_en_fampay' },
        ],
        [
          { text: '↻ Refresh', callback_data: 'cc:fampay_cfg' },
          { text: '← Payment Gateways', callback_data: 'cc:pay_methods' },
        ],
      ],
    };
    return renderView(ctx, text, keyboard, edit);
  }

  async function showStarsConfig(ctx, edit = true) {
    const [stars, plans, paidLinks, batchLinks] = await Promise.all([
      loadStarsConfig(pool),
      listPremiumPlans(pool).catch(() => []),
      listPaidFileLinks(pool, 20).catch(() => []),
      listPaidBatchLinks(pool, 20).catch(() => []),
    ]);
    const planMap = new Map(plans.map((p) => [String(p.id), p]));
    const paidMap = new Map(paidLinks.map((l) => [String(l.id), l]));
    const batchMap = new Map(batchLinks.map((b) => [String(b.id), b]));

    const priceLines = [];
    for (const [id, amt] of Object.entries(stars.starsPrices.premium ?? {})) {
      if (Number(amt) > 0) {
        const plan = planMap.get(String(id));
        priceLines.push(`• 💎 Plan #${id}${plan ? ` (${plan.name})` : ''}: ${amt} ⭐`);
      }
    }
    for (const [id, amt] of Object.entries(stars.starsPrices.paid_file ?? {})) {
      if (Number(amt) > 0) {
        const link = paidMap.get(String(id));
        priceLines.push(`• 🏷 Paid Link #${id}${link ? ` (${link.file_code})` : ''}: ${amt} ⭐`);
      }
    }
    for (const [id, amt] of Object.entries(stars.starsPrices.paid_batch ?? {})) {
      if (Number(amt) > 0) {
        const batch = batchMap.get(String(id));
        priceLines.push(`• 📚 Batch #${id}${batch ? ` (${batch.title})` : ''}: ${amt} ⭐`);
      }
    }

    const text = [
      '⭐ Telegram Stars (XTR) Configuration',
      '━━━━━━━━━━━━━━━━━━',
      '',
      `📌 Status: ${stars.isEnabled ? '🟢 ENABLED' : '🔴 DISABLED'} · Setup: ${stars.setupStatus}`,
      `🧪 Last test: ${stars.lastTestStatus}${stars.lastTestError ? ' (' + String(stars.lastTestError).slice(0, 100) + ')' : ''}`,
      '',
      '💰 Configured Stars Prices:',
      ...(priceLines.length ? priceLines : ['📭 No Stars prices configured yet. Set at least one below to enable Stars checkout.']),
    ].join('\n');

    const keyboard = {
      inline_keyboard: [
        [{ text: '⭐ Set Plan Stars Price', callback_data: 'cc:prompt:stars_plan' }],
        [
          { text: '🏷 Set Paid Link Stars', callback_data: 'cc:prompt:stars_paid' },
          { text: '📚 Set Batch Stars', callback_data: 'cc:prompt:stars_batch' },
        ],
        [
          { text: '🧪 Test Stars Config', callback_data: 'cc:stars_test' },
          stars.isEnabled
            ? { text: '⏸ Disable Stars', callback_data: 'cc:stars_dis' }
            : { text: '✅ Enable Stars', callback_data: 'cc:stars_en' },
        ],
        [
          { text: '↻ Refresh', callback_data: 'cc:stars_cfg' },
          { text: '← Payment Gateways', callback_data: 'cc:pay_methods' },
        ],
      ],
    };
    return renderView(ctx, text, keyboard, edit);
  }

  async function showPaymentRecovery(ctx, edit = true) {
    const rows = await listPaymentRecoveryFailures(pool, 10);
    const text = rows.length
      ? '⚠️ Verified Payments Awaiting Recovery\n━━━━━━━━━━━━━━━━━━\n\n' + rows.map((tx) => `🔁 #${tx.id} · ${tx.method} · ${tx.purpose}\n👤 User: ${tx.user_telegram_id ?? 'unknown'} · 💰 ${formatMoney(tx.amount_minor, tx.currency)}\n⚠️ Attempts: ${tx.recovery_attempts} · Error: ${tx.recovery_last_error ?? 'unknown'}`).join('\n\n')
      : '⚠️ Verified Payments Awaiting Recovery\n━━━━━━━━━━━━━━━━━━\n\n✨ No pending payment recovery failures.';
    const keyboard = [
      ...rows.slice(0, 6).map((tx) => [{ text: `↻ Reconcile #${tx.id}`, callback_data: `payreconcile:${tx.id}` }]),
      [
        { text: '↻ Refresh', callback_data: 'cc:pay_rec' },
        { text: '← Payments', callback_data: 'cc:payments' },
      ],
    ];
    return renderView(ctx, text, { inline_keyboard: keyboard }, edit);
  }

  async function showExpiredSessions(ctx, edit = true) {
    const rows = await listExpiredPaymentSessions(pool, 10);
    const text = rows.length
      ? '⏳ Expired Checkout Sessions (latest 10)\n━━━━━━━━━━━━━━━━━━\n\n' + rows.map((s) => `⌛ #${s.id} · ${s.method} · ${s.purpose}\n👤 User: ${s.user_telegram_id} · 💰 ${formatMoney(s.expected_amount_minor, s.currency)}\n🕒 Expired: ${new Date(s.expires_at).toISOString()}`).join('\n\n')
      : '⏳ Expired Checkout Sessions\n━━━━━━━━━━━━━━━━━━\n\n✨ No expired checkout sessions recorded.';
    const keyboard = {
      inline_keyboard: [[
        { text: '↻ Refresh', callback_data: 'cc:pay_sessions' },
        { text: '← Payments', callback_data: 'cc:payments' },
      ]],
    };
    return renderView(ctx, text, keyboard, edit);
  }

  async function showPaidLinks(ctx, edit = false) {
    const ownerId = getOwnerScope(ctx);
    const isOwner = isOwnerAdmin(ctx);
    const [rows, starsCfg] = await Promise.all([
      listPaidFileLinks(pool, 12, ownerId),
      loadStarsConfig(pool).catch(() => ({ starsPrices: {} })),
    ]);
    const lines = rows.length
      ? rows.map((row) => {
          const stars = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'paid_file', { paidLinkId: row.id });
          return `#${row.id} · ${row.is_enabled ? '🟢 ON' : '⏸ OFF'} · 🔑 ${row.public_code}\n📄 ${row.file_name} (${row.file_code})\n💰 ${formatMoney(row.price_minor, row.currency)}${stars ? ` · ${stars} ⭐` : ''} · 🛒 Requests: ${row.purchase_count}`;
        })
      : ['📭 No paid file links created yet. Use /plink to create one!'];
    const keyboard = [
      [
        { text: '➕ Create Paid Link', callback_data: 'cc:plink_single' },
        ...(isOwner ? [{ text: '⭐ Set Stars Price', callback_data: 'cc:prompt:stars_paid' }] : []),
      ],
      ...(isOwner ? [[{ text: '📥 Pending Requests', callback_data: 'cc:paid_reqs' }]] : []),
      ...rows.slice(0, 6).map((r) => [
        {
          text: `${r.is_enabled ? '🟢' : '⏸'} ${r.public_code.slice(0, 10)} · ${String(r.file_name).slice(0, 18)}`,
          callback_data: `cc:paid_view:${r.id}`,
        },
        { text: '🗑', callback_data: `cc:paid_del:${r.id}` },
      ]),
      [
        { text: '↻ Refresh', callback_data: 'cc:paid' },
        { text: '← Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, '🏷 Paid File Links\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showPaidLinkDetail(ctx, id, edit = true, confirmDelete = false) {
    const ownerId = getOwnerScope(ctx);
    const [row, starsCfg, botUsername] = await Promise.all([
      getPaidFileLinkByIdOrCode(pool, id, ownerId),
      loadStarsConfig(pool).catch(() => ({ starsPrices: {} })),
      getShareableBotUsername(pool, ownerId).catch(() => null),
    ]);
    if (!row) return showPaidLinks(ctx, edit);
    const stars = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'paid_file', { paidLinkId: row.id });
    const deepUrl = buildShareableUrl(botUsername, `paid_${row.public_code}`);
    const lines = [
      `🏷 Paid File Link #${row.id}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🔑 Code: ${row.public_code}`,
      `📌 Status: ${row.is_enabled ? '✅ Enabled' : '⏸ Disabled'}`,
      `📄 File: ${row.file_name} (${row.file_code})`,
      `💰 Price: ${row.currency === 'XTR' ? '' : formatMoney(row.price_minor, row.currency)}${stars ? `${row.currency === 'XTR' ? '' : ' / '}${stars} ⭐` : ''}`,
      `🛒 Requests: ${row.purchase_count ?? 0}`,
      `⏳ Expiry: ${row.expires_at ? new Date(row.expires_at).toISOString() : 'Never'}`,
      ...(deepUrl ? ['', `🌐 Link:\n${deepUrl}`] : ['', `⚡ User command: /paid ${row.public_code}`]),
      ...(confirmDelete ? ['', '⚠️ Confirm deletion? This permanently deletes the paid link and any purchase requests for it.'] : []),
    ];
    const keyboard = [];
    if (deepUrl) {
      keyboard.push([{ text: '🔗 Open Paid Link', url: deepUrl }]);
    }
    const actionRow = [
      row.is_enabled
        ? { text: '⏸ Disable', callback_data: `cc:paid_tog:${row.id}` }
        : { text: '✅ Enable', callback_data: `cc:paid_tog:${row.id}` },
    ];
    if (confirmDelete) {
      actionRow.push({ text: '⚠ Confirm Delete', callback_data: `cc:paid_del_ok:${row.id}` });
      actionRow.push({ text: 'Cancel', callback_data: `cc:paid_view:${row.id}` });
    } else {
      actionRow.push({ text: '🗑 Delete', callback_data: `cc:paid_del:${row.id}` });
    }
    keyboard.push(actionRow);
    keyboard.push([
      { text: '← Paid Links', callback_data: 'cc:paid' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showPaidRequests(ctx, edit = true) {
    const rows = await listPendingPaidFilePurchases(pool, 10);
    const lines = rows.length
      ? rows.map((r) => `🧾 Purchase #${r.purchase_id} · ${r.public_code}\n👤 User: ${r.user_telegram_id} · 📄 ${r.file_name} (${r.file_code})\n💰 Amount: ${formatMoney(r.paid_amount_minor, r.currency)}`)
      : ['✨ No pending paid file purchase requests.'];
    const keyboard = [
      ...rows.slice(0, 6).map((r) => [
        { text: `✅ Confirm #${r.purchase_id} · User ${r.user_telegram_id}`, callback_data: `cc:paid_ok:${r.purchase_id}` },
      ]),
      [
        { text: '↻ Refresh', callback_data: 'cc:paid_reqs' },
        { text: '← Paid Links', callback_data: 'cc:paid' },
      ],
    ];
    return renderView(ctx, '📥 Pending Paid File Requests\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showBatchLinks(ctx, edit = false) {
    const ownerId = getOwnerScope(ctx);
    const isOwner = isOwnerAdmin(ctx);
    const [rows, starsCfg] = await Promise.all([
      listPaidBatchLinks(pool, 12, ownerId),
      loadStarsConfig(pool).catch(() => ({ starsPrices: {} })),
    ]);
    const lines = rows.length
      ? rows.map((b) => {
          const stars = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'paid_batch', { batchLinkId: b.id });
          return `#${b.id} · ${b.is_enabled ? '🟢 ON' : '⏸ OFF'} · 🔑 ${b.public_code}\n📚 ${b.title} (${b.item_count} files)\n💰 ${formatMoney(b.price_minor, b.currency)}${stars ? ` · ${stars} ⭐` : ''} · 🛒 Purchases: ${b.purchase_count}`;
        })
      : ['📭 No paid batch links created yet. Use /plink to create one!'];
    const keyboard = [
      [
        { text: '➕ Create Batch Link', callback_data: 'cc:plink_batch' },
        ...(isOwner ? [{ text: '⭐ Set Stars Price', callback_data: 'cc:prompt:stars_batch' }] : []),
      ],
      ...(isOwner ? [[{ text: '📥 Pending Requests', callback_data: 'cc:batch_reqs' }]] : []),
      ...rows.slice(0, 6).map((b) => [
        {
          text: `${b.is_enabled ? '🟢' : '⏸'} ${b.public_code.slice(0, 10)} · ${String(b.title).slice(0, 18)}`,
          callback_data: `cc:batch_view:${b.id}`,
        },
        { text: '🗑', callback_data: `cc:batch_del:${b.id}` },
      ]),
      [
        { text: '↻ Refresh', callback_data: 'cc:batch' },
        { text: '← Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return renderView(ctx, '📚 Paid Batch Links\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showBatchLinkDetail(ctx, id, edit = true, confirmDelete = false) {
    const ownerId = getOwnerScope(ctx);
    const [b, starsCfg, botUsername] = await Promise.all([
      getPaidBatchByIdOrCode(pool, id, ownerId),
      loadStarsConfig(pool).catch(() => ({ starsPrices: {} })),
      getShareableBotUsername(pool, ownerId).catch(() => null),
    ]);
    if (!b) return showBatchLinks(ctx, edit);
    const stars = getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'paid_batch', { batchLinkId: b.id });
    const deepUrl = buildShareableUrl(botUsername, `pbatch_${b.public_code}`);
    const lines = [
      `📚 Paid Batch Link #${b.id}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 Title: ${b.title}`,
      `🔑 Code: ${b.public_code}`,
      `📌 Status: ${b.is_enabled ? '✅ Enabled' : '⏸ Disabled'}`,
      `📦 Files: ${b.item_count ?? 0}`,
      `💰 Price: ${b.currency === 'XTR' ? '' : formatMoney(b.price_minor, b.currency)}${stars ? `${b.currency === 'XTR' ? '' : ' / '}${stars} ⭐` : ''}`,
      `🛒 Purchases: ${b.purchase_count ?? 0}`,
      `⏳ Expiry: ${b.expires_at ? new Date(b.expires_at).toISOString() : 'Never'}`,
      ...(deepUrl ? ['', `🌐 Link:\n${deepUrl}`] : ['', `⚡ User command: /batch ${b.public_code}`]),
      ...(confirmDelete ? ['', '⚠️ Confirm deletion? This permanently deletes the paid batch link and its purchase requests.'] : []),
    ];
    const keyboard = [];
    if (deepUrl) {
      keyboard.push([{ text: '🔗 Open Paid Batch', url: deepUrl }]);
    }
    const actionRow = [
      b.is_enabled
        ? { text: '⏸ Disable', callback_data: `cc:batch_tog:${b.id}` }
        : { text: '✅ Enable', callback_data: `cc:batch_tog:${b.id}` },
    ];
    if (confirmDelete) {
      actionRow.push({ text: '⚠ Confirm Delete', callback_data: `cc:batch_del_ok:${b.id}` });
      actionRow.push({ text: 'Cancel', callback_data: `cc:batch_view:${b.id}` });
    } else {
      actionRow.push({ text: '🗑 Delete', callback_data: `cc:batch_del:${b.id}` });
    }
    keyboard.push(actionRow);
    keyboard.push([
      { text: '← Batch Links', callback_data: 'cc:batch' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showBatchRequests(ctx, edit = true) {
    const rows = await listPendingBatchPurchases(pool, 10);
    const lines = rows.length
      ? rows.map((p) => `🧾 Purchase #${p.purchase_id} · 📚 ${p.title}\n🔑 Code: ${p.public_code} · 👤 User: ${p.user_telegram_id}\n💰 Amount: ${formatMoney(p.paid_amount_minor, p.currency)}`)
      : ['✨ No pending batch purchase requests.'];
    const keyboard = [
      ...rows.slice(0, 6).map((p) => [
        { text: `✅ Confirm #${p.purchase_id} · User ${p.user_telegram_id}`, callback_data: `cc:batch_ok:${p.purchase_id}` },
      ]),
      [
        { text: '↻ Refresh', callback_data: 'cc:batch_reqs' },
        { text: '← Batch Links', callback_data: 'cc:batch' },
      ],
    ];
    return renderView(ctx, '📥 Pending Batch Requests\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
  }

  async function showAutoDelete(ctx, edit = false) {
    const minutes = await getAutoDeleteMinutes(pool);
    const text = [
      '⏱ Auto-Delete Timer',
      '━━━━━━━━━━━━━━━━━━',
      '',
      minutes
        ? `🟢 Status: ON — Delivered messages auto-delete after ${minutes} minute(s).`
        : '⚪ Status: OFF — Delivered messages remain in user chats.',
      '',
      '👇 Select a preset or enter a custom delay:',
    ].join('\n');
    const keyboard = {
      inline_keyboard: [
        [
          { text: '5 min', callback_data: 'cc:autodel_set:5' },
          { text: '15 min', callback_data: 'cc:autodel_set:15' },
          { text: '30 min', callback_data: 'cc:autodel_set:30' },
        ],
        [
          { text: '1 hour', callback_data: 'cc:autodel_set:60' },
          { text: '6 hours', callback_data: 'cc:autodel_set:360' },
          { text: '24 hours', callback_data: 'cc:autodel_set:1440' },
        ],
        [
          { text: '✏ Custom Minutes', callback_data: 'cc:prompt:auto_delete' },
          { text: '⛔ Turn OFF', callback_data: 'cc:autodel_set:0' },
        ],
        [{ text: '⚠ Failed Deletions', callback_data: 'cc:autodel_failed' }],
        [
          { text: '↻ Refresh', callback_data: 'cc:autodel' },
          { text: '← Main Menu', callback_data: 'cc:home' },
        ],
      ],
    };
    return renderView(ctx, text, keyboard, edit);
  }

  async function showAutoDeleteFailed(ctx, edit = true) {
    const rows = await listFailedScheduledDeletions(pool, 10);
    const text = rows.length
      ? '⚠️ Failed Auto-Delete Jobs (latest 10)\n━━━━━━━━━━━━━━━━━━\n\n' + rows.map((row) => `❌ #${row.id} · ${row.delivery_bot_identity} · chat ${row.chat_id} · msg ${row.message_id}\n🔁 Attempts: ${row.attempt_count} · ${String(row.last_error ?? 'unknown').slice(0, 120)}`).join('\n\n')
      : '⚠️ Failed Auto-Delete Jobs\n━━━━━━━━━━━━━━━━━━\n\n✨ No terminal auto-delete failures.';
    const keyboard = {
      inline_keyboard: [[
        { text: '↻ Refresh', callback_data: 'cc:autodel_failed' },
        { text: '← Auto-Delete', callback_data: 'cc:autodel' },
      ]],
    };
    return renderView(ctx, text, keyboard, edit);
  }

  async function showUserGuide(ctx, chapter = 'overview', edit = false) {
    const key = Object.prototype.hasOwnProperty.call(CREATOR_GUIDE_SECTIONS, chapter) ? chapter : 'overview';
    const sec = CREATOR_GUIDE_SECTIONS[key];
    const tab = (id) => ({
      text: (id === key ? '• ' : '') + CREATOR_GUIDE_SECTIONS[id].label,
      callback_data: `cc:uguide:${id}`,
    });

    const contextualRow = [];
    if (key === 'overview' || key === 'links') {
      contextualRow.push(
        { text: '🔗 Single Link', callback_data: 'cc:cmd_link' },
        { text: '📦 Batch Link', callback_data: 'cc:cmd_batch' },
      );
    } else if (key === 'paid') {
      contextualRow.push(
        { text: '💎 Paid Link', callback_data: 'cc:plink' },
        { text: '🌐 Web Control Panel', callback_data: 'cc:webtok' },
      );
    } else if (key === 'setup' || key === 'short' || key === 'earn') {
      contextualRow.push(
        { text: '🌐 Web Control Panel', callback_data: 'cc:webtok' },
      );
    }

    const keyboard = {
      inline_keyboard: [
        [tab('overview'), tab('links'), tab('paid')],
        [tab('setup'), tab('short'), tab('earn')],
        ...(contextualRow.length ? [contextualRow] : []),
        [{ text: '🎛 Back to Menu', callback_data: 'cc:home' }],
      ],
    };
    return renderView(ctx, `<b>${sec.title}</b>\n\n${sec.body}`, keyboard, edit, true, { parse_mode: 'HTML' });
  }

  async function showGuide(ctx, section = 'main', edit = false) {
    const isOwner = isOwnerAdmin(ctx);
    if (!isOwner) {
      const mapToChapter = {
        main: 'overview',
        storage: 'setup',
        delivery: 'setup',
        access: 'short',
        paid: 'paid',
        payments: 'earn',
      };
      return showUserGuide(ctx, mapToChapter[section] ?? 'overview', edit);
    }

    const sec = GUIDE_SECTIONS[section] ?? GUIDE_SECTIONS.main;
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🗄 Storage & Files', callback_data: 'cc:guide:storage' },
          { text: '🤖 Delivery', callback_data: 'cc:guide:delivery' },
        ],
        [
          { text: '🔒 Access & Shorteners', callback_data: 'cc:guide:access' },
          { text: '💳 Payments', callback_data: 'cc:guide:payments' },
        ],
        [
          { text: '🏷 Paid & Batch Links', callback_data: 'cc:guide:paid' },
          { text: '📘 User Guide', callback_data: 'cc:uguide:overview' },
        ],
        [
          { text: '🎛 Open Control Center', callback_data: 'cc:home' },
        ],
      ],
    };
    return renderView(ctx, `📖 ${sec.title}\n\n${sec.body}`, keyboard, edit);
  }

  async function showReferralScreen(ctx, edit = false) {
    const userId = Number(ctx.from.id);
    const mainUsername = ctx.botInfo?.username
      || bot.botInfo?.username
      || (typeof ctx.telegram?.getMe === 'function' ? (await ctx.telegram.getMe().catch(() => null))?.username : null)
      || (typeof config?.notifyTelegram?.getMe === 'function' ? (await config.notifyTelegram.getMe().catch(() => null))?.username : null);
    const [ref, wallet] = await Promise.all([
      getUserReferralSummary(pool, userId, mainUsername),
      getCreatorWalletSummary(pool, userId).catch(() => ({ inrWallet: { available_minor: 0 } })),
    ]);
    const rewardLabel = formatMoney(ref.settings.rewardMinor, ref.settings.currency || 'INR');
    const earnedLabel = formatMoney(ref.totalEarnedMinor, 'INR');
    const walletAvailLabel = formatMoney(wallet?.inrWallet?.available_minor ?? 0, 'INR');
    const statusBadge = ref.settings.enabled ? '🟢 Active' : '⚪ Paused by Owner';

    const lines = [
      '🎁 <b>Refer &amp; Earn Program</b>',
      '━━━━━━━━━━━━━━━━━━',
      '<i>Invite new users &amp; creators with your unique link to earn instant INR wallet rewards!</i>',
      '',
      `<blockquote>💸 <b>Reward / Referral:</b> <code>${escapeHtml(rewardLabel)}</code>  ·  ${statusBadge}\n`
      + `👥 <b>Total Referrals:</b> <code>${ref.totalReferrals}</code>\n`
      + `📈 <b>Referral Earnings:</b> <code>${escapeHtml(earnedLabel)}</code>\n`
      + `💵 <b>Wallet Balance:</b> <code>${escapeHtml(walletAvailLabel)}</code></blockquote>`,
      '',
      '🔗 <b>Your Unique Referral Link</b>',
      ref.shareUrl
        ? `<blockquote><code>${escapeHtml(ref.shareUrl)}</code>\n🪪 <b>Token:</b> <code>${escapeHtml(ref.token)}</code></blockquote>`
        : `<blockquote>🪪 <b>Unique Token:</b> <code>${escapeHtml(ref.token)}</code></blockquote>`,
    ];

    if (ref.recentReferrals.length) {
      lines.push(
        '',
        '🕒 <b>Recent Referrals</b>',
        '<blockquote>' + ref.recentReferrals.slice(0, 5).map((r) => {
          const who = r.username
            ? `@${escapeHtml(r.username)}`
            : escapeHtml(r.firstName || `User ${r.referredUserId}`);
          return `• ${who} — <b>+${escapeHtml(formatMoney(r.rewardMinor, r.currency))}</b>`;
        }).join('\n') + '</blockquote>',
      );
    }

    lines.push(
      '',
      '🛡 <i>Only genuine first-time users who join with your unique token count (1 reward per user, no self-referrals).</i>',
    );

    const shareBtnRow = ref.shareUrl
      ? [{
          text: '📤 Share Referral Link',
          url: `https://t.me/share/url?url=${encodeURIComponent(ref.shareUrl)}&text=${encodeURIComponent(`Join FileStore using my invite link! ${ref.shareUrl}`)}`,
        }]
      : [];

    const keyboard = [
      ...(shareBtnRow.length ? [shareBtnRow] : []),
      [
        { text: '💰 My Wallet', callback_data: 'cc:me' },
        { text: '↻ Refresh', callback_data: 'cc:referral' },
      ],
      [{ text: '← Main Menu', callback_data: 'cc:home' }],
    ];
    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, { parse_mode: 'HTML' });
  }

  // Entry commands
  bot.command('start', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    const startPayload = String(ctx.startPayload ?? (ctx.message?.text || '').split(/\s+/)[1] ?? '').trim();
    const refMatch = startPayload.match(/^ref_([A-Za-z0-9_-]{8,32})$/i);
    if (refMatch) {
      try {
        const claim = await claimReferralOnStart(pool, {
          referredUser: ctx.from,
          token: refMatch[1],
          isNewUser: ctx.state?.isNewTelegramUser ?? null,
        });
        if (claim?.credited) {
          const rewardText = formatMoney(claim.rewardMinor, claim.currency || 'INR');
          const invitedLabel = ctx.from?.username
            ? `@${escapeHtml(ctx.from.username)}`
            : escapeHtml(ctx.from?.first_name || `User ${ctx.from?.id}`);
          const notifier = config?.notifyTelegram ?? bot.telegram;
          if (typeof notifier?.sendMessage === 'function' && claim.rewardMinor > 0) {
            void notifier.sendMessage(
              claim.referrerId,
              [
                '🎉 <b>New Successful Referral!</b>',
                '━━━━━━━━━━━━━━━━━━',
                `👤 <b>Invited User:</b> ${invitedLabel}`,
                `💵 <b>Reward Credited:</b> <code>+${escapeHtml(rewardText)}</code>`,
                `💰 <b>New Wallet Balance:</b> <code>${escapeHtml(formatMoney(claim.balanceAfterMinor ?? 0, claim.currency || 'INR'))}</code>`,
              ].join('\n'),
              { parse_mode: 'HTML' },
            ).catch(() => {});
          }
          await ctx.reply(
            '🎁 <b>Welcome via Referral!</b>\nYour account is ready — tap <b>🎁 Refer &amp; Earn</b> below to invite others too.',
            { parse_mode: 'HTML' },
          ).catch(() => {});
        } else if (claim?.reason === 'self_referral') {
          await ctx.reply('ℹ️ You cannot claim a referral reward using your own referral link.').catch(() => {});
        }
      } catch (error) {
        logger?.warn?.({ userId: ctx.from?.id, error: error.message }, 'Referral claim failed on /start');
      }
      await showHome(ctx, false);
      return;
    }
    if (/^clone$/i.test(startPayload)) {
      await showCloneBotScreen(ctx, false);
      return;
    }
    if (/^botslot$/i.test(startPayload) && !isOwnerAdmin(ctx)) {
      try {
        const slotSettings = await getBotSlotSettings(pool);
        if (slotSettings.starsPrice) {
          await sendStarsInvoice(
            bot,
            pool,
            ctx,
            'bot_slot',
            {},
            'Extra Delivery Bot Slot',
            'Unlock +1 additional custom Delivery Bot slot in FileStore',
            config.mainBotToken,
          );
          return;
        }
      } catch (error) {
        await ctx.reply('❌ Telegram Stars slot checkout is unavailable right now: ' + error.message);
        return;
      }
      await showSlotUnlockScreen(ctx, false);
      return;
    }
    await showHome(ctx, false);
  });

  bot.command('menu', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showHome(ctx, false);
  });

  bot.command(['referral', 'refer'], async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showReferralScreen(ctx, false);
  });

  bot.action('cc:referral', async (ctx) => {
    await safeAnswer(ctx);
    await showReferralScreen(ctx, true);
  });

  bot.command('guide', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showUserGuide(ctx, 'overview', false);
  });

  bot.command(['my_plans', 'cplans'], async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showCreatorPlans(ctx, false);
  });

  bot.command('help', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await showGuide(ctx, 'main', false);
  });

  bot.command('cancel', async (ctx) => {
    const hadPrompt = Boolean(getActivePrompt(ctx.from.id)) || Boolean(getShortenerDraft(ctx.from.id)) || Boolean(shareLinksUi.getSession(ctx.from.id)) || Boolean(paidLinksUi.getSession(ctx.from.id)) || Boolean(walletUi.getSession(ctx.from.id)) || Boolean(options.hasActiveAdminPrompt?.(ctx.from.id));
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await ctx.reply(
      hadPrompt
        ? '🛑 Action Cancelled\n━━━━━━━━━━━━━━━━━━\nYour active input session has been cleared.'
        : 'ℹ️ Nothing to Cancel\n━━━━━━━━━━━━━━━━━━\nYou have no active input prompt right now.',
      { reply_markup: { inline_keyboard: [[{ text: '🎛 Main Menu', callback_data: 'cc:home' }]] } },
    );
  });

  // Top-level navigation callbacks
  bot.action('cc:home', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    await safeAnswer(ctx);
    await showHome(ctx, true);
  });

  bot.action('cc:dash', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showDashboard(ctx, true); });
  bot.action('cc:health', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showHealth(ctx, true); });
  bot.action('cc:storage', async (ctx) => { await safeAnswer(ctx); await showStorage(ctx, true); });
  bot.action(/^cc:files:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showFiles(ctx, Number(ctx.match[1]), true); });
  bot.action('cc:files_clean', async (ctx) => {
    const ownerId = getOwnerScope(ctx);
    const count = await countUnusedFilesForOwner(pool, ownerId).catch(() => 0);
    await safeAnswer(ctx);
    if (!count) return showFiles(ctx, 0, true);
    return renderView(
      ctx,
      `🧹 <b>Clean Unused Files</b>\n━━━━━━━━━━━━━━━━━━\n\nFound <b>${count}</b> file(s) not attached to any active free or paid link.\n\nConfirm cleanup to remove them from your workspace count?`,
      {
        inline_keyboard: [
          [
            { text: `⚠ Clean ${count} File(s)`, callback_data: 'cc:files_clean_ok' },
            { text: 'Cancel', callback_data: 'cc:files:0' },
          ],
        ],
      },
      true,
      true,
      { parse_mode: 'HTML' },
    );
  });
  bot.action('cc:files_clean_ok', async (ctx) => {
    const removed = await disableUnusedFilesForOwner(pool, getOwnerScope(ctx)).catch(() => 0);
    await safeAnswer(ctx, removed ? `Cleaned ${removed} unused file(s).` : 'No unused files found.');
    await showFiles(ctx, 0, true);
  });
  bot.action(/^cc:file:([A-Za-z0-9_-]{2,32})$/, async (ctx) => { await safeAnswer(ctx); await showFileDetail(ctx, ctx.match[1], true); });
  bot.action(/^cc:fdel:([A-Za-z0-9_-]{2,32})$/, async (ctx) => { await safeAnswer(ctx); await showFileDetail(ctx, ctx.match[1], true, true); });
  bot.action(/^cc:fdel_ok:([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
    try {
      const result = await disableFileByIdOrCode(pool, ctx.match[1], getOwnerScope(ctx));
      await safeAnswer(ctx, result.deleted ? 'File removed from workspace. 🗑' : 'File not found.', !result.deleted);
      await showFiles(ctx, 0, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });
  bot.action('cc:bots', async (ctx) => { await safeAnswer(ctx); await showBots(ctx, true); });
  bot.action('cc:jobs', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showJobs(ctx, true); });
  bot.action('cc:fsub', async (ctx) => { await safeAnswer(ctx); await showForceSub(ctx, true); });
  bot.action('cc:short', async (ctx) => { await safeAnswer(ctx); await showShorteners(ctx, true); });
  bot.action('cc:plans', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPlans(ctx, true); });
  bot.action('cc:cplans', async (ctx) => { await safeAnswer(ctx); await showCreatorPlans(ctx, true); });
  bot.action('cc:payments', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPaymentsHub(ctx, true); });
  bot.action('cc:pay_methods', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPaymentMethods(ctx, true); });
  bot.action('cc:fampay_cfg', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showFamPayConfig(ctx, true); });
  bot.action('cc:stars_cfg', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showStarsConfig(ctx, true); });
  bot.action('cc:pay_rec', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPaymentRecovery(ctx, true); });
  bot.action('cc:pay_sessions', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showExpiredSessions(ctx, true); });
  bot.action('cc:paid', async (ctx) => { await safeAnswer(ctx); await showPaidLinks(ctx, true); });
  bot.action('cc:paid_reqs', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPaidRequests(ctx, true); });
  bot.action('cc:batch', async (ctx) => { await safeAnswer(ctx); await showBatchLinks(ctx, true); });
  bot.action('cc:batch_reqs', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showBatchRequests(ctx, true); });
  bot.action('cc:autodel', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showAutoDelete(ctx, true); });
  bot.action('cc:autodel_failed', async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showAutoDeleteFailed(ctx, true); });
  bot.action(/^cc:guide:(main|storage|delivery|access|payments|paid)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showGuide(ctx, ctx.match[1], true);
  });
  bot.action(/^cc:uguide:(overview|links|paid|setup|short|earn)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showUserGuide(ctx, ctx.match[1], true);
  });

  // Storage actions
  bot.action(/^cc:stg:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showStorageDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:stg_rm:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showStorageDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:stg_test:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedStorageRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const chatId = Number(ch.telegram_chat_id);
    try {
      await validateStorageChannel(ctx, chatId, { requireUserAdmin: !isOwnerAdmin(ctx) });
      await updateStorageTest(pool, chatId, 'ok', null, ownerId);
      await safeAnswer(ctx, 'Storage permission test passed!', true);
    } catch (error) {
      await updateStorageTest(pool, chatId, 'failed', error.message, ownerId).catch(() => {});
      await safeAnswer(ctx, 'Test failed: ' + error.message, true);
    }
    await showStorageDetail(ctx, id, true);
  });

  bot.action(/^cc:stg_(en|dis|pri):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedStorageRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const chatId = Number(ch.telegram_chat_id);
    if (action === 'pri') await setPrimaryStorageChannel(pool, chatId, ownerId);
    else await setStorageEnabled(pool, chatId, action === 'en', ownerId);
    await safeAnswer(ctx, action === 'pri' ? 'Primary channel updated.' : action === 'en' ? 'Channel enabled.' : 'Channel disabled.');
    await showStorageDetail(ctx, id, true);
  });

  bot.action(/^cc:stg_rm_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedStorageRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const removed = await removeStorageChannel(pool, Number(ch.telegram_chat_id), ownerId);
    await safeAnswer(
      ctx,
      removed.removed ? 'Storage channel removed.' : `Channel has ${removed.references} files; disabled instead.`,
      true,
    );
    await showStorage(ctx, true);
  });

  // Delivery Bot & Slot actions
  bot.action('cc:clone', async (ctx) => {
    await safeAnswer(ctx);
    await showCloneBotScreen(ctx, true);
  });

  bot.action('cc:slot_unlock', async (ctx) => {
    await safeAnswer(ctx);
    await showSlotUnlockScreen(ctx, true);
  });

  bot.action('cc:slot_pay_wallet', async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Owners already have unlimited slots.', true);
    try {
      const result = await unlockSlotWithWallet(pool, Number(ctx.from.id));
      const newTotal = 1 + Number(result.extraSlots || 1);
      await safeAnswer(ctx, 'Extra Delivery Bot slot unlocked! 🔓');
      return renderView(
        ctx,
        [
          '✅ <b>+1 Delivery Bot Slot Unlocked!</b>',
          '━━━━━━━━━━━━━━━━━━',
          '',
          `<blockquote>🎟 <b>New Bot Limit:</b> <code>${newTotal}</code> bots\n`
          + `💵 <b>Paid from Wallet:</b> <code>${escapeHtml(formatMoney(result.amountMinor, 'INR'))}</code>\n`
          + `💰 <b>Remaining Wallet:</b> <code>${escapeHtml(formatMoney(result.availableAfterMinor, 'INR'))}</code></blockquote>`,
          '',
          '👇 Tap below to connect your new Delivery Bot right now.',
        ].join('\n'),
        {
          inline_keyboard: [
            [{ text: '➕ Add Delivery Bot Now', callback_data: 'cc:prompt:delivery_bot_add' }],
            [
              { text: '🤖 My Delivery Bots', callback_data: 'cc:bots' },
              { text: '🎛 Main Menu', callback_data: 'cc:home' },
            ],
          ],
        },
        true,
        true,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
      return showSlotUnlockScreen(ctx, true);
    }
  });

  bot.action('cc:slot_pay_stars', async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Owners already have unlimited slots.', true);
    try {
      await safeAnswer(ctx);
      await sendStarsInvoice(
        bot,
        pool,
        ctx,
        'bot_slot',
        {},
        'Extra Delivery Bot Slot',
        'Unlock +1 additional custom Delivery Bot slot in FileStore',
        config.mainBotToken,
      );
    } catch (error) {
      await ctx.reply('❌ Telegram Stars slot checkout is unavailable right now: ' + error.message);
    }
  });

  bot.action('cc:slot_pay_upi', async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Owners already have unlimited slots.', true);
    try {
      const slotSettings = await getBotSlotSettings(pool);
      const checkout = await createFamPayCheckout(pool, config, {
        userId: Number(ctx.from.id),
        purpose: 'bot_slot',
        target: {},
        baseAmountMinor: slotSettings.priceMinor,
        currency: slotSettings.currency || 'INR',
        label: 'Extra Bot Slot',
      });
      await safeAnswer(ctx);
      const caption = [
        '📲 <b>Pay via UPI to Unlock +1 Bot Slot</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `<blockquote>💵 <b>Exact Amount:</b> <code>₹${escapeHtml(checkout.amountDisplay)}</code>\n`
        + `🏦 <b>UPI ID:</b> <code>${escapeHtml(checkout.upiId)}</code>\n`
        + `🔖 <b>Ref:</b> <code>${escapeHtml(checkout.txnRef)}</code></blockquote>`,
        '',
        '⚡ <i>Scan QR or pay the exact amount above, then tap <b>Verify Payment</b>.</i>',
      ].join('\n');
      const markup = {
        inline_keyboard: [
          [{ text: '✅ I Have Paid · Verify Payment', callback_data: `cc:slot_check:${checkout.session.id}` }],
          [
            { text: '✖ Cancel', callback_data: `cc:slot_cancel:${checkout.session.id}` },
            { text: '← Back', callback_data: 'cc:slot_unlock' },
          ],
        ],
      };
      if (checkout.qrBuffer) {
        await ctx.replyWithPhoto({ source: checkout.qrBuffer }, { caption, parse_mode: 'HTML', reply_markup: markup });
      } else {
        await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: markup });
      }
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });

  bot.action(/^cc:slot_check:(\d+)$/, async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Owners already have unlimited slots.', true);
    const sessionId = Number(ctx.match[1]);
    try {
      const result = await verifyFamPaySession(pool, config, sessionId, { userId: Number(ctx.from.id) });
      if (result.status === 'verified' || result.status === 'already_applied') {
        await safeAnswer(ctx, 'Payment verified! +1 Bot Slot unlocked! 🔓', true);
        return ctx.reply(
          '✅ <b>Payment Verified!</b>\n━━━━━━━━━━━━━━━━━━\n\n🔓 <b>+1 Delivery Bot slot</b> has been added to your account.',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '➕ Add Delivery Bot Now', callback_data: 'cc:prompt:delivery_bot_add' }],
                [
                  { text: '🤖 My Delivery Bots', callback_data: 'cc:bots' },
                  { text: '🎛 Main Menu', callback_data: 'cc:home' },
                ],
              ],
            },
          },
        );
      }
      if (result.status === 'expired') {
        await safeAnswer(ctx, 'This payment QR has expired. Please generate a new one.', true);
        return;
      }
      await safeAnswer(ctx, 'Payment not detected yet. Wait a few seconds after paying and tap Verify again.', true);
    } catch (error) {
      await safeAnswer(ctx, error.message || 'Verification failed.', true);
    }
  });

  bot.action(/^cc:slot_cancel:(\d+)$/, async (ctx) => {
    const sessionId = Number(ctx.match[1]);
    await cancelFamPaySession(pool, sessionId, Number(ctx.from.id)).catch(() => false);
    await safeAnswer(ctx, 'Checkout cancelled.');
    await showSlotUnlockScreen(ctx, false);
  });

  bot.action(/^cc:bot_replace:(\d+)$/, async (ctx) => {
    const botId = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const botRow = await findOwnedBotRow(botId, ownerId);
    if (!botRow) {
      await safeAnswer(ctx, 'Delivery Bot not found.', true);
      return showBots(ctx, true);
    }
    const cfg = setPrompt(ctx.from.id, 'bot_replace', {
      back: `cc:bot:${botRow.id}`,
      meta: { botId: botRow.id },
    });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      `✏️ Replace Delivery Bot @${botRow.username}\n━━━━━━━━━━━━━━━━━━\n${cfg.prompt}`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:bot:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showBotDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:bot_rm:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showBotDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:bot_test:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    try {
      const result = await deliveryManager.test(id, ownerId);
      const okCount = result.checks.filter((c) => c.status === 'ok' || c.status === 'force_sub_admin_ok').length;
      await safeAnswer(ctx, `@${result.bot.username} OK · ${okCount}/${result.checks.length} channel checks passed`, true);
    } catch (error) {
      await safeAnswer(ctx, 'Test failed: ' + error.message, true);
    }
    await showBotDetail(ctx, id, true);
  });

  bot.action(/^cc:bot_(pause|res|rst|pri):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const ownerId = getOwnerScope(ctx);
    let ok = false;
    if (action === 'pause') ok = await deliveryManager.pause(id, ownerId);
    else if (action === 'res') ok = await deliveryManager.resume(id, ownerId);
    else if (action === 'rst') ok = await deliveryManager.restart(id, ownerId);
    else if (action === 'pri') ok = await deliveryManager.promotePrimary(id, ownerId);
    await safeAnswer(ctx, ok ? 'Bot action applied.' : 'Bot action could not be completed.', !ok);
    await showBotDetail(ctx, id, true);
  });

  bot.action(/^cc:bot_rm_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await deliveryManager.remove(id, getOwnerScope(ctx));
    await safeAnswer(ctx, 'Delivery Bot removed.');
    await showBots(ctx, true);
  });

  registerOwnerBotActions(bot, { isOwnerAdmin, denyAdminOnly, safeAnswer, showAllBotsForOwner, showOwnerBotDetail, deliveryManager, updateDeliveryBotForOwner, pool, getDeliveryBotDetailsForOwner, setPrompt, renderView });

  registerDeliveryJobActions(bot, { isOwnerAdmin, denyAdminOnly, retryFailedDeliveryJob, pool, safeAnswer, showJobs });

  registerForceSubActions(bot, { pool, setForceSubGlobal, getOwnerScope, safeAnswer, showForceSub, showForceSubDetail, findOwnedForceSubRow, validateForceSubChannel, isOwnerAdmin, removeForceSubChannel, setForceSubEnabled });

  registerShortenerActions(bot, { getOwnerScope, pool, safeAnswer, setCreatorCheckpointEnabled, showShorteners, clearShortenerDraft, setPrompt, renderView, PROMPT_CONFIGS, getShortenerDraft, clearPrompt, listShortenerProviders, deriveUniqueShortenerName, addShortenerProvider, config, getShortenerProviderById, decryptShortenerApiKey, getShareableBotUsername, shortenUrlWithProvider, markShortenerTest, showShortenerDetail, setShortenerEnabled, showShortenerEdit, setShortenerDuration, setShortenerPriority, removeShortenerProvider });


  registerPremiumPlanActions(bot, { isOwnerAdmin, denyAdminOnly, safeAnswer, showPlanDetail, pool, showPlans });

  registerPaymentMethodActions(bot, { isOwnerAdmin, denyAdminOnly, pool, safeAnswer, setPrompt, renderView });

  registerCreatorPlanActions(bot, { safeAnswer, showCreatorPlanDetail, getOwnerScope, setPremiumPlanEnabled, pool, removePremiumPlan, showCreatorPlans, getPremiumPlanById, setPrompt, renderView });

  registerGatewayActions(bot, { isOwnerAdmin, denyAdminOnly, pool, enableTelegramStars, safeAnswer, showPaymentMethods, showStarsConfig, disablePaymentMethod, testTelegramStars, enableFamPay, config, showFamPayConfig, testFamPayImapConnection, maskEmail, markPaymentMethodTest });

  registerPaidLinkActions(bot, { safeAnswer, showPaidLinkDetail, deletePaidFileLink, pool, getOwnerScope, showPaidLinks, getPaidFileLinkByIdOrCode, setPaidFileLinkEnabled, disablePaidFileLink, isOwnerAdmin, denyAdminOnly, confirmPaidFilePurchase, getPaidFileLink, showPaidRequests, showBatchLinkDetail, deletePaidBatchLink, showBatchLinks, getPaidBatchByIdOrCode, setPaidBatchLinkEnabled, disablePaidBatchLink, confirmPaidBatchPurchase, getPaidBatch, showBatchRequests });

  registerAutoDeleteActions(bot, { isOwnerAdmin, denyAdminOnly, pool, setAutoDeleteMinutes, safeAnswer, showAutoDelete });

  function parseBroadcastContent(raw) {
    const lines = String(raw ?? '').split(/\r?\n/), buttons = [], body = [];
    for (const line of lines) {
      const m = line.match(/^Button:\s*(.{1,40}?)\s*\|\s*(https:\/\/\S+)\s*$/i);
      if (m) {
        if (buttons.length >= 8) throw new Error('Maximum 8 URL buttons allowed.');
        buttons.push([{ text: m[1].trim(), url: m[2].trim() }]);
      } else {
        body.push(line);
      }
    }
    return { body: body.join('\n').trim(), buttons };
  }
  async function confirmBroadcastDraft(ctx) {
    const draft = getBroadcastDraft(ctx.from.id);
    if (!draft) return safeAnswer(ctx, 'Broadcast preview expired. Please compose again.', true);
    try {
      if (draft.kind === 'owner') {
        if (!isOwnerAdmin(ctx)) throw new Error('Owner permission required.');
        const scopeOwner = draft.allowPlatformBot ? null : draft.ownerTelegramId;
        const bots = await deliveryManager.list(scopeOwner);
        if (!bots.some((b) => Number(b.id) === Number(draft.deliveryBotId) && b.is_enabled)) {
          throw new Error('Selected delivery bot is no longer enabled.');
        }
      } else {
        if (isOwnerAdmin(ctx)) throw new Error('Creator permission required.');
        const bots = await deliveryManager.list(Number(ctx.from.id));
        if (!bots.some((b) => Number(b.id) === Number(draft.deliveryBotId) && b.is_enabled)) {
          throw new Error('Your delivery bot is no longer enabled.');
        }
      }
      const created = await createCreatorBroadcast(pool, { ...draft, createdBy: ctx.from.id });
      clearBroadcastDraft(ctx.from.id);
      await safeAnswer(ctx, 'Broadcast queued!');
      const history = draft.kind === 'owner' ? 'cc:owner_broadcast_history' : 'cc:broadcast_history';
      const detailCb = draft.kind === 'owner'
        ? `cc:owner_broadcast_detail:${created.id}`
        : `cc:broadcast_detail:${created.id}`;
      const canEditText = Boolean(ctx.callbackQuery?.message?.text);
      if (!canEditText) await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
      return renderView(
        ctx,
        '✅ <b>Broadcast queued</b>\n━━━━━━━━━━━━━━━━━━\n📋 Campaign #' + created.id + '\n👥 Recipients: ' + created.totalRecipients,
        {
          inline_keyboard: [
            [{ text: '📊 Campaign Status', callback_data: detailCb }],
            [{ text: '📋 Campaigns', callback_data: history }],
          ],
        },
        canEditText,
        true,
        { parse_mode: 'HTML' },
      );
    } catch (e) {
      await safeAnswer(ctx, String(e.message || 'Could not queue broadcast.').slice(0, 190), true);
      const backCb = draft.kind === 'owner' ? 'cc:owner_broadcast' : 'cc:broadcast';
      await ctx.reply(
        `❌ <b>Could not queue broadcast</b>\n${escapeHtml(e.message || 'Unknown error.')}`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '← Broadcast Menu', callback_data: backCb }]] } },
      ).catch(() => {});
    }
  }
  bot.action('cc:broadcast_confirm', confirmBroadcastDraft);
  bot.action('cc:broadcast_cancel_draft', async (ctx) => {
    const draft = getBroadcastDraft(ctx.from.id);
    clearBroadcastDraft(ctx.from.id);
    await safeAnswer(ctx, 'Draft cancelled.');
    const backCb = isOwnerAdmin(ctx) || draft?.kind === 'owner' ? 'cc:owner_broadcast' : 'cc:broadcast';
    const canEditText = Boolean(ctx.callbackQuery?.message?.text);
    if (!canEditText) await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    return renderView(ctx, '🛑 Broadcast draft cancelled.', { inline_keyboard: [[{ text: '📢 Broadcast Menu', callback_data: backCb }]] }, canEditText, true);
  });
  async function showBroadcastPreview(ctx, draft) {
    setBroadcastDraft(ctx.from.id, draft);
    const content = draft.caption || draft.messageText || '';
    const keyboard = [...(draft.buttons || []), [{ text: '✅ Confirm & Queue', callback_data: 'cc:broadcast_confirm' }], [{ text: '✖ Cancel', callback_data: 'cc:broadcast_cancel_draft' }]];
    if (draft.mediaType) {
      const method = { photo: 'replyWithPhoto', video: 'replyWithVideo', document: 'replyWithDocument', animation: 'replyWithAnimation' }[draft.mediaType];
      if (!method) throw new Error('Unsupported media preview type.');
      return ctx[method](draft.mediaFileId, { ...(content ? { caption: content.slice(0, 1024) } : {}), reply_markup: { inline_keyboard: keyboard } });
    }
    return renderView(ctx, '👀 <b>Broadcast Preview</b>\n━━━━━━━━━━━━━━━━━━\nText message\n\n' + escapeHtml(content.slice(0, 1800)) + '\n\n👥 Audience snapshot will be taken when you confirm.\n\nConfirm to queue this campaign?', { inline_keyboard: keyboard }, false, true, { parse_mode: 'HTML' });
  }

  registerOwnerBroadcastActions(bot, { isOwnerAdmin, denyAdminOnly, safeAnswer, pool, renderView, listOwnerCreatedBroadcasts, escapeHtml, getCreatorBroadcast, setCreatorBroadcastStatus, retryCreatorBroadcast, deliveryManager, clearShortenerDraft, shareLinksUi, paidLinksUi, walletUi, setPrompt });

  // Creator broadcast menu and history (creator-owned audience only)
  bot.action('cc:broadcast', async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Creator broadcast is available from a creator account.', true);
    await safeAnswer(ctx);
    const ownerId = Number(ctx.from.id);
    const bots = await deliveryManager.list(ownerId);
    const active = bots.filter((b) => b.is_enabled && b.runtime_status === 'running');
    const selectedBot = pickCreatorBroadcastBot(bots);
    const history = await listCreatorBroadcasts(pool, ownerId, 5).catch(() => []);
    const audience = selectedBot
      ? await pool.query('SELECT COUNT(*)::int AS count FROM delivery_bot_user_activity WHERE delivery_bot_id = $1', [Number(selectedBot.id)])
      : { rows: [{ count: 0 }] };
    const botLine = selectedBot ? '🤖 Sending via: <b>@' + escapeHtml(selectedBot.username) + '</b> (' + active.length + ' active)' : '🤖 Active delivery bots: <b>0</b>';
    const msg = '📢 <b>Creator Broadcast</b>\n━━━━━━━━━━━━━━━━━━\n' + botLine + '\n👥 Tracked audience: <b>' + Number(audience.rows[0]?.count || 0) + '</b>\n\nSend a text or media announcement to users tracked by your delivery bot. Each broadcast runs in the background.';
    const kb = [];
    if (selectedBot) kb.push([{ text: '✉️ Compose Broadcast', callback_data: 'cc:broadcast_compose' }]);
    if (history.length) kb.push([{ text: '📋 Recent Broadcasts', callback_data: 'cc:broadcast_history' }]);
    kb.push([{ text: '↻ Refresh', callback_data: 'cc:broadcast' }, { text: '← Creator Hub', callback_data: 'cc:home' }]);
    return renderView(ctx, msg, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action('cc:broadcast_compose', async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const bots = await deliveryManager.list(Number(ctx.from.id));
    if (!pickCreatorBroadcastBot(bots)) { await safeAnswer(ctx, 'No active delivery bot is running.', true); return; }
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    const cfg = setPrompt(ctx.from.id, 'creator_broadcast', { back: 'cc:broadcast' });
    await safeAnswer(ctx);
    return renderView(ctx, '✏️ <b>New Broadcast</b>\n━━━━━━━━━━━━━━━━━━\n' + escapeHtml(cfg.prompt), { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] }, true, true, { parse_mode: 'HTML' });
  });
  bot.action('cc:broadcast_history', async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await safeAnswer(ctx);
    const rows = await listCreatorBroadcasts(pool, Number(ctx.from.id), 10);
    const statusIcon = { pending: '⏳', processing: '🚀', paused: '⏸', completed: '✅', cancelled: '🛑', failed: '⚠️' };
    const body = rows.length
      ? rows.map((r) => `${statusIcon[r.status] ?? '📋'} #${r.id} · ${escapeHtml(r.status)}\n👥 ${r.total_recipients} · 📤 ${r.sent_count} · ⚠️ ${r.failed_count}`).join('\n\n')
      : 'No broadcasts yet.';
    const kb = rows.map((r) => [{ text: 'Details #' + r.id + ' · ' + r.status, callback_data: 'cc:broadcast_detail:' + r.id }]);
    kb.push([{ text: '← Broadcast', callback_data: 'cc:broadcast' }, { text: 'Creator Hub', callback_data: 'cc:home' }]);
    return renderView(ctx, '📋 <b>Broadcast History</b>\n━━━━━━━━━━━━━━━━━━\n\n' + body, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action(/^cc:broadcast_detail:(\d+)$/, async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]), owner = Number(ctx.from.id);
    const b = await getCreatorBroadcast(pool, owner, id);
    if (!b) { await safeAnswer(ctx, 'Broadcast not found.', true); return; }
    await safeAnswer(ctx);
    const pct = b.total_recipients ? Math.floor(Number(b.sent_count) * 100 / Number(b.total_recipients)) : 0;
    const msg = '📋 <b>Broadcast #' + b.id + '</b>\n━━━━━━━━━━━━━━━━━━\nStatus: <b>' + escapeHtml(b.status) + '</b>\n👥 Total: ' + b.total_recipients + '\n📤 Sent: ' + b.sent_count + ' (' + pct + '%)\n⚠️ Failed: ' + b.failed_count + '\n⏳ Pending: ' + b.pending_count + '\n\n' + (b.last_error ? 'Last error: ' + escapeHtml(String(b.last_error).slice(0, 300)) : '');
    const kb = [];
    if (['processing', 'pending'].includes(b.status)) kb.push([{ text: '⏸ Pause', callback_data: 'cc:broadcast_manage:paused:' + id }]);
    if (b.status === 'paused') kb.push([{ text: '▶ Resume', callback_data: 'cc:broadcast_manage:pending:' + id }]);
    if (['processing', 'pending', 'paused'].includes(b.status)) kb.push([{ text: '🛑 Cancel', callback_data: 'cc:broadcast_manage:cancelled:' + id }]);
    if (['completed', 'failed', 'paused'].includes(b.status) && Number(b.failed_count) > 0) kb.push([{ text: '🔁 Retry Failed', callback_data: 'cc:broadcast_retry:' + id }]);
    kb.push([{ text: '↻ Refresh', callback_data: 'cc:broadcast_detail:' + id }, { text: '← History', callback_data: 'cc:broadcast_history' }]);
    return renderView(ctx, msg, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action(/^cc:broadcast_manage:(paused|pending|cancelled):(\d+)$/, async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const status = ctx.match[1], id = Number(ctx.match[2]), owner = Number(ctx.from.id);
    const changed = await setCreatorBroadcastStatus(pool, owner, id, status);
    await safeAnswer(ctx, changed ? 'Broadcast updated.' : 'Broadcast could not be updated.', !changed);
    return bot.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, { inline_keyboard: [[{ text: '↻ Refresh Details', callback_data: 'cc:broadcast_detail:' + id }], [{ text: '← History', callback_data: 'cc:broadcast_history' }]] }).catch(() => {});
  });
  bot.action(/^cc:broadcast_retry:(\d+)$/, async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    try {
      const n = await retryCreatorBroadcast(pool, Number(ctx.from.id), id);
      await safeAnswer(ctx, 'Retry queued for ' + n + ' failed recipient(s).');
    } catch (e) {
      await safeAnswer(ctx, e.message || 'Retry failed.', true);
    }
    return renderView(ctx, '🔁 Retry requested for Broadcast #' + id, { inline_keyboard: [[{ text: '📋 Details', callback_data: 'cc:broadcast_detail:' + id }, { text: 'History', callback_data: 'cc:broadcast_history' }]] }, true, true);
  });

  // Prompt starters & cancel
  bot.action(/^cc:prompt:([a-z_]+)$/, async (ctx) => {
    const action = ctx.match[1];
    if (OWNER_ONLY_PROMPTS.has(action) && !isOwnerAdmin(ctx)) {
      return denyAdminOnly(ctx);
    }
    try {
      const cfg = setPrompt(ctx.from.id, action);
      let promptText = cfg.prompt;
      const inlineKeyboard = [];

      if (action === 'storage_add') {
        const botInfo = await ctx.telegram.getMe().catch(() => null);
        const botLabel = botInfo?.username ? `@${botInfo.username}` : 'this Main Bot';
        promptText = [
          '🗄 Add Storage Channel',
          '',
          `1️⃣ Add ${botLabel} as an Administrator in your channel (with Post Messages permission). If you use your own Delivery Bot, add it as Administrator too.`,
          '2️⃣ Then send the -100... channel ID, @username, or t.me link — OR simply forward any post from your channel right here.',
        ].join('\n');
      } else if (action === 'delivery_bot_add' && !isOwnerAdmin(ctx)) {
        const creatorId = Number(ctx.from.id);
        const [bots, storageRows, slots] = await Promise.all([
          deliveryManager.list(creatorId),
          listStorageChannels(pool, creatorId).catch(() => []),
          getCreatorSlotsSnapshot(creatorId, false),
        ]);
        const usedSlots = Math.max(slots.usedSlots, bots.length);
        const remainingSlots = Math.max(0, slots.totalAllowed - usedSlots);
        if (remainingSlots <= 0) {
          clearPrompt(ctx.from.id);
          await safeAnswer(ctx, 'Delivery Bot slot limit reached.', true);
          return showSlotUnlockScreen(ctx, true, { limitReached: true });
        }
        const hasOwnStorage = storageRows.some((c) => c.is_enabled);
        promptText = hasOwnStorage
          ? `${cfg.prompt}\n\n🎟 Slot: ${usedSlots}/${slots.totalAllowed} used (${remainingSlots} available)\n🛡️ Reminder: Make sure your new Delivery Bot is also added as an Administrator in your own Storage Channel(s) — otherwise it will not work.`
          : `${cfg.prompt}\n\n🎟 Slot: ${usedSlots}/${slots.totalAllowed} used (${remainingSlots} available)\n⚠️ IMPORTANT REQUIREMENT:\nYou MUST add your own Storage Channel (and make both this Main Bot and your Delivery Bot Administrators in it) — otherwise your Delivery Bot will NOT work!`;
        if (!hasOwnStorage) {
          inlineKeyboard.push([{ text: '🗄 Add Storage Channel First', callback_data: 'cc:prompt:storage_add' }]);
        }
      }

      inlineKeyboard.push([{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]);
      await safeAnswer(ctx);
      await renderView(
        ctx,
        `✏️ Interactive Input\n━━━━━━━━━━━━━━━━━━\n${promptText}`,
        { inline_keyboard: inlineKeyboard },
        true,
      );
    } catch {
      await safeAnswer(ctx, 'Unknown prompt.', true);
    }
  });

  bot.action('cc:cancel_prompt', async (ctx) => {
    const active = getActivePrompt(ctx.from.id);
    const back = active?.back ?? (getShortenerDraft(ctx.from.id) ? 'cc:short' : 'cc:home');
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    await safeAnswer(ctx, 'Cancelled.');
    await renderView(
      ctx,
      '🛑 Input Cancelled\n━━━━━━━━━━━━━━━━━━\nNo changes were saved.',
      { inline_keyboard: [[{ text: '← Back', callback_data: back }, { text: '🎛 Main Menu', callback_data: 'cc:home' }]] },
      true,
    );
  });

  // Forwarded channel message support for storage_add + media input for broadcast prompts.
  bot.on('message', async (ctx, next) => {
    const active = getActivePrompt(ctx.from?.id);
    if (!active) return next();

    const m = ctx.message;
    if (active.action === 'storage_add') {
      const forwardedChat = m.forward_origin?.type === 'channel'
        ? m.forward_origin.chat
        : (m.forward_from_chat?.type === 'channel' ? m.forward_from_chat : null);
      const isForwarded = Boolean(forwardedChat || m.forward_origin || m.forward_from_chat || m.forward_from || m.forward_sender_name);
      if (!isForwarded) return next();

      clearPrompt(ctx.from.id);
      const ownerId = getOwnerScope(ctx);
      const retryKeyboard = {
        inline_keyboard: [
          [{ text: '↻ Try Again', callback_data: 'cc:prompt:storage_add' }],
          [
            { text: '← Back to Section', callback_data: active.back },
            { text: '🎛 Main Menu', callback_data: 'cc:home' },
          ],
        ],
      };
      if (!forwardedChat) {
        return ctx.reply(
          '❌ That forwarded message is not from a Telegram channel.\nPlease forward a post directly from your Telegram channel, or send its -100... channel ID or @username.',
          { reply_markup: retryKeyboard },
        );
      }
      try {
        const chat = await validateStorageChannel(ctx, forwardedChat.id, { requireUserAdmin: !isOwnerAdmin(ctx) });
        const saved = await saveStorageChannel(pool, chat, ctx.from.id, ownerId);
        return ctx.reply(
          `✅ Storage Channel Connected!\n━━━━━━━━━━━━━━━━━━\n🗄 ${saved.title ?? 'Channel'}\n🆔 ID: ${saved.telegram_chat_id}\n⚡ Status: ${saved.is_enabled ? '🟢 Enabled' : '⚪ Disabled'} · 🧪 Tested OK`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '← Back to Section', callback_data: active.back },
                { text: '🎛 Main Menu', callback_data: 'cc:home' },
              ]],
            },
          },
        );
      } catch (error) {
        return ctx.reply('❌ Action failed: ' + error.message, { reply_markup: retryKeyboard });
      }
    }

    if (!['creator_broadcast', 'owner_broadcast'].includes(active.action)) return next();
    let mediaType = null, mediaFileId = null;
    if (m.photo?.length) { mediaType = 'photo'; mediaFileId = m.photo[m.photo.length - 1].file_id; }
    else if (m.video) { mediaType = 'video'; mediaFileId = m.video.file_id; }
    else if (m.document) { mediaType = 'document'; mediaFileId = m.document.file_id; }
    else if (m.animation) { mediaType = 'animation'; mediaFileId = m.animation.file_id; }
    else return next();
    clearPrompt(ctx.from.id);
    try {
      let creatorId, botId, allowPlatformBot = false;
      if (active.action === 'owner_broadcast') {
        if (!isOwnerAdmin(ctx)) throw new Error('Owner permission required.');
        creatorId = Number(active.meta?.creatorId);
        botId = Number(active.meta?.botId);
        allowPlatformBot = Boolean(active.meta?.allowPlatformBot);
        const bots = await deliveryManager.list(allowPlatformBot ? null : creatorId);
        if (!bots.some(b => Number(b.id) === botId && b.is_enabled)) throw new Error('Selected delivery bot is disabled or no longer available.');
      } else {
        if (isOwnerAdmin(ctx)) throw new Error('Creator broadcasts must be sent from a creator account.');
        creatorId = Number(ctx.from.id);
        const bots = await deliveryManager.list(creatorId);
        const activeBot = pickCreatorBroadcastBot(bots);
        if (!activeBot) throw new Error('No active delivery bot is running.');
        botId = Number(activeBot.id);
      }
      const parsed = parseBroadcastContent(m.caption ?? '');
      return showBroadcastPreview(ctx, {
        kind: active.action === 'owner_broadcast' ? 'owner' : 'creator',
        ownerTelegramId: creatorId,
        deliveryBotId: botId,
        allowPlatformBot,
        mediaType,
        mediaFileId,
        caption: parsed.body,
        buttons: parsed.buttons,
      });
    } catch (error) {
      return ctx.reply('❌ Could not queue media broadcast: ' + error.message, { reply_markup: { inline_keyboard: [[{ text: '↻ Try Again', callback_data: active.back || 'cc:broadcast' }]] } });
    }
  });

  // Text handler for guided interactive prompts
  bot.on('text', async (ctx, next) => {
    const text = ctx.message?.text?.trim() ?? '';
    if (text.startsWith('/')) {
      if (!text.startsWith('/cancel')) {
        clearPrompt(ctx.from.id);
        clearShortenerDraft(ctx.from.id);
        walletUi.clearSession(ctx.from.id);
        if (!text.startsWith('/done')) {
          shareLinksUi.clearSession(ctx.from.id);
          paidLinksUi.clearSession(ctx.from.id);
        }
      }
      return next();
    }

    if (await walletUi.handleTextMessage(ctx)) {
      return;
    }
    if (await paidLinksUi.handleTextMessage(ctx)) {
      return;
    }
    if (await shareLinksUi.handleTextMessage(ctx)) {
      return;
    }

    const active = getActivePrompt(ctx.from.id);
    if (!active) return next();

    clearPrompt(ctx.from.id);
    const ownerId = getOwnerScope(ctx);
    const backKeyboard = {
      inline_keyboard: [[
        { text: '← Back to Section', callback_data: active.back },
        { text: '🎛 Main Menu', callback_data: 'cc:home' },
      ]],
    };

    if (OWNER_ONLY_PROMPTS.has(active.action) && !isOwnerAdmin(ctx)) {
      return ctx.reply('🔒 Restricted to platform owner/admin.', { reply_markup: backKeyboard });
    }

    try {
      switch (active.action) {
        case 'owner_broadcast': {
          if (!isOwnerAdmin(ctx)) throw new Error('Owner permission required.');
          const creatorId = Number(active.meta?.creatorId);
          const botId = Number(active.meta?.botId);
          const allowPlatformBot = Boolean(active.meta?.allowPlatformBot);
          if (!Number.isSafeInteger(creatorId) || !Number.isSafeInteger(botId)) throw new Error('Missing creator or delivery bot selection.');
          const bots = await deliveryManager.list(allowPlatformBot ? null : creatorId);
          if (!bots.some((b) => Number(b.id) === botId && b.is_enabled)) throw new Error('Selected delivery bot is disabled or no longer available.');
          const parsed = parseBroadcastContent(text);
          if (!parsed.body) throw new Error('Enter announcement text before adding buttons.');
          return showBroadcastPreview(ctx, {
            kind: 'owner',
            ownerTelegramId: creatorId,
            deliveryBotId: botId,
            allowPlatformBot,
            messageText: parsed.body,
            buttons: parsed.buttons,
          });
        }
        case 'creator_broadcast': {
          if (isOwnerAdmin(ctx)) throw new Error('Creator broadcasts must be sent from a creator account.');
          const bots = await deliveryManager.list(Number(ctx.from.id));
          const activeBot = pickCreatorBroadcastBot(bots);
          if (!activeBot) throw new Error('No active delivery bot is running.');
          const parsed = parseBroadcastContent(text);
          if (!parsed.body) throw new Error('Enter announcement text before adding buttons.');
          return showBroadcastPreview(ctx, { kind: 'creator', ownerTelegramId: ctx.from.id, deliveryBotId: Number(activeBot.id), messageText: parsed.body, buttons: parsed.buttons });
        }
        case 'storage_add': {
          const parsed = parseStorageIdentifier(text);
          const chat = await validateStorageChannel(ctx, parsed, { requireUserAdmin: !isOwnerAdmin(ctx) });
          const saved = await saveStorageChannel(pool, chat, ctx.from.id, ownerId);
          return ctx.reply(
            `✅ Storage Channel Connected!\n━━━━━━━━━━━━━━━━━━\n🗄 ${saved.title ?? 'Channel'}\n🆔 ID: ${saved.telegram_chat_id}\n⚡ Status: ${saved.is_enabled ? '🟢 Enabled' : '⚪ Disabled'} · 🧪 Tested OK`,
            { reply_markup: backKeyboard },
          );
        }
        case 'find': {
          const rows = await searchIndexedFiles(pool, text, 8, ownerId);
          const kb = rows.map((f) => [{ text: `📄 ${f.file_code} · ${String(f.file_name).slice(0, 26)}`, callback_data: `cc:file:${f.file_code}` }]);
          kb.push(...backKeyboard.inline_keyboard);
          return ctx.reply(
            rows.length
              ? `🔍 Search results for "${text}":\n━━━━━━━━━━━━━━━━━━\n` + rows.map((f, i) => `${i + 1}. 📄 ${f.file_name.slice(0, 120)}\n   🔑 ${f.file_code} · ${f.file_type} · ${formatFileSize(f.file_size)}`).join('\n\n')
              : `🔍 No matching files found for "${text}".\n💡 Try a shorter keyword or exact file code.`,
            { reply_markup: { inline_keyboard: kb } },
          );
        }
        case 'delivery_bot_add': {
          try { await ctx.deleteMessage(); } catch {}
          const record = await deliveryManager.addToken(text.replace(/\s+/g, ''), ctx.from.id, ownerId);
          let extraNotice = '';
          let replyMarkup = backKeyboard;
          if (ownerId !== null) {
            const storageRows = await listStorageChannels(pool, ownerId).catch(() => []);
            const hasOwnStorage = storageRows.some((c) => c.is_enabled);
            if (!hasOwnStorage) {
              extraNotice = `\n\n⚠️ ACTION REQUIRED — Bot Will Not Work Yet!\nYou MUST add your own Storage Channel now and make both this Main Bot and @${record.username} Administrators in it — otherwise your Delivery Bot will NOT work!`;
              replyMarkup = {
                inline_keyboard: [
                  [{ text: '🗄 Add Storage Channel Now', callback_data: 'cc:prompt:storage_add' }],
                  ...backKeyboard.inline_keyboard,
                ],
              };
            } else {
              extraNotice = `\n\n🛡️ Important: Make sure @${record.username} is added as an Administrator in your own Storage Channel(s), otherwise it cannot deliver files.`;
            }
          }
          return ctx.reply(
            `🤖 Delivery Bot Connected!\n━━━━━━━━━━━━━━━━━━\n🆔 Record #${record.id}\n🤖 Bot: @${record.username}\n🏷 Role: ${record.role}\n⚡ Runtime: ${record.runtime_status}${extraNotice}`,
            { reply_markup: replyMarkup },
          );
        }
        case 'bot_replace': {
          try { await ctx.deleteMessage(); } catch {}
          const botId = Number(active.meta?.botId);
          if (!Number.isSafeInteger(botId) || botId <= 0) throw new Error('Missing Delivery Bot ID.');
          const existing = await findOwnedBotRow(botId, ownerId);
          if (!existing) throw new Error('Delivery Bot not found.');
          const replaced = await deliveryManager.replaceToken(botId, text.replace(/\s+/g, ''), ctx.from.id, ownerId);
          const checks = replaced.checks || [];
          const failedChecks = checks.filter((c) => c.status !== 'ok' && c.status !== 'force_sub_admin_ok');
          let extraNotice = '\n✅ All your existing file & share links remain active.';
          let replyMarkup = {
            inline_keyboard: [
              [{ text: '🤖 Bot Details', callback_data: `cc:bot:${replaced.bot.id}` }],
              ...backKeyboard.inline_keyboard,
            ],
          };
          if (ownerId !== null) {
            const storageRows = await listStorageChannels(pool, ownerId).catch(() => []);
            const hasOwnStorage = storageRows.some((c) => c.is_enabled);
            if (!hasOwnStorage) {
              extraNotice += `\n\n⚠️ Add your own Storage Channel and make both bots Administrators so @${replaced.bot.username} can deliver files.`;
              replyMarkup = {
                inline_keyboard: [
                  [{ text: '🗄 Add Storage Channel Now', callback_data: 'cc:prompt:storage_add' }],
                  ...replyMarkup.inline_keyboard,
                ],
              };
            } else if (failedChecks.length > 0) {
              extraNotice += `\n\n🛡️ Make sure @${replaced.bot.username} is added as Administrator in ${failedChecks.length} channel(s).`;
            }
          }
          return ctx.reply(
            `🔄 Delivery Bot Replaced!\n━━━━━━━━━━━━━━━━━━\n🆔 Record #${replaced.bot.id}\n🤖 New Bot: @${replaced.bot.username}\n⚡ Runtime: ${replaced.bot.runtime_status}${extraNotice}`,
            { reply_markup: replyMarkup },
          );
        }
        case 'force_sub_add': {
          const [channelInput, joinUrl] = text.split(/\s+/);
          if (!channelInput || !joinUrl) throw new Error('Provide both <channel_id|@username> and <https_join_url>.');
          const parsedUrl = new URL(joinUrl);
          if (parsedUrl.protocol !== 'https:') throw new Error('Join link must use HTTPS.');
          const chat = await validateForceSubChannel(ctx, parseStorageIdentifier(channelInput), { requireUserAdmin: !isOwnerAdmin(ctx) });
          const saved = await saveForceSubChannel(pool, chat, parsedUrl.toString(), ctx.from.id, ownerId);
          return ctx.reply(
            `🔒 Force-Sub Channel Saved!\n━━━━━━━━━━━━━━━━━━\n📢 ${saved.title ?? 'Channel'}\n🆔 ID: ${saved.telegram_chat_id}`,
            { reply_markup: backKeyboard },
          );
        }
        case 'plan_add': {
          const fields = text.split('|').map((v) => v.trim());
          if (fields.length < 4 || fields.length > 5) throw new Error('Use: name|price|currency|duration_days|stars_price(optional)');
          const duration = Number(fields[3]);
          if (!Number.isInteger(duration) || duration < 1 || duration > 3650) throw new Error('Duration must be 1–3650 days.');
          let starsPrice = null;
          if (fields[4] !== undefined && fields[4] !== '') {
            if (!/^\d+$/.test(fields[4]) || Number(fields[4]) < 1) throw new Error('Optional stars_price must be a positive integer.');
            starsPrice = Number(fields[4]);
          }
          const row = await upsertPremiumPlan(pool, {
            name: fields[0],
            priceMinor: parseMinorAmount(fields[1], { allowZero: true }),
            currency: parseCurrencyCode(fields[2]),
            durationDays: duration,
            enabled: true,
          }, ctx.from.id);
          if (starsPrice) {
            await setTelegramStarsPrice(pool, 'premium', row.id, starsPrice, ctx.from.id);
          }
          return ctx.reply(
            `💎 Plan Saved!\n━━━━━━━━━━━━━━━━━━\n✨ #${row.id} ${row.name}\n💵 Price: ${formatMoney(row.price_minor, row.currency)}${starsPrice ? ` · ${starsPrice} ⭐` : ''}\n⏳ Duration: ${row.duration_days} day(s)`,
            { reply_markup: backKeyboard },
          );
        }
        case 'plan_stars_single': {
          const planId = active.meta?.planId;
          if (!planId) throw new Error('Missing Plan ID.');
          if (!/^\d+$/.test(text)) throw new Error('Enter a non-negative integer Stars amount (e.g. 50, or 0 to remove).');
          const stars = Number(text);
          const updated = await setTelegramStarsPrice(pool, 'premium', planId, stars, ctx.from.id);
          return ctx.reply(
            stars === 0
              ? `🗑️ Telegram Stars price removed from Plan #${planId}.`
              : `⭐ Saved Telegram Stars price for Plan #${planId}: ${stars} ⭐\n⚡ Stars Gateway: ${updated.isEnabled ? '🟢 ENABLED' : '🔴 DISABLED'}`,
            {
              reply_markup: {
                inline_keyboard: [
                  ...(!updated.isEnabled && stars > 0 ? [[{ text: '✅ Enable Telegram Stars', callback_data: 'cc:stars_en' }]] : []),
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'cplan_add': {
          const fields = text.split('|').map((v) => v.trim());
          if (fields.length < 3 || fields.length > 5) {
            throw new Error('Use: name|price_inr|duration_days|stars_price(optional)\nExample: VIP Monthly|99|30 or VIP Monthly|99|30|50');
          }
          const name = fields[0];
          if (!name || name.length > 60) throw new Error('Plan name must be 1–60 characters.');
          let priceRaw = fields[1];
          let currency = 'INR';
          let durationRaw;
          let starsRaw = null;
          if (fields.length === 3) {
            durationRaw = fields[2];
          } else if (fields.length === 4) {
            if (/^[A-Za-z]{3}$/.test(fields[2])) {
              currency = parseCurrencyCode(fields[2]);
              durationRaw = fields[3];
            } else {
              durationRaw = fields[2];
              starsRaw = fields[3];
            }
          } else {
            currency = parseCurrencyCode(fields[2]);
            durationRaw = fields[3];
            starsRaw = fields[4];
          }
          if (currency !== 'INR') {
            throw new Error('Creator Premium plans use INR for UPI payouts (e.g. VIP Monthly|99|30).');
          }
          const priceMinor = parseMinorAmount(priceRaw, { allowZero: true });
          const duration = Number(durationRaw);
          if (!Number.isInteger(duration) || duration < 1 || duration > 3650) {
            throw new Error('Duration must be 1–3650 days.');
          }
          let starsPrice = null;
          if (starsRaw !== null && starsRaw !== '') {
            if (!/^\d+$/.test(starsRaw) || Number(starsRaw) < 1 || Number(starsRaw) > 100000000) {
              throw new Error('Optional stars_price must be a positive integer.');
            }
            starsPrice = Number(starsRaw);
          }
          if (priceMinor === 0 && !starsPrice) {
            throw new Error('Set an INR price (at least 1 INR) and/or a Telegram Stars price.');
          }
          if (priceMinor > 0 && priceMinor < 100) {
            throw new Error('Minimum INR price is 1.00 INR.');
          }
          const planOwnerScope = getOwnerScope(ctx);
          const row = await upsertPremiumPlan(pool, {
            name,
            priceMinor,
            currency,
            durationDays: duration,
            enabled: true,
          }, ctx.from.id, planOwnerScope);
          if (starsPrice) {
            await setTelegramStarsPrice(pool, 'premium', row.id, starsPrice, ctx.from.id);
          }
          const botUsername = await getShareableBotUsername(pool, planOwnerScope).catch(() => null);
          const planUrl = botUsername ? buildShareableUrl(botUsername, `prem_${row.id}`) : null;
          return ctx.reply(
            [
              '👑 <b>Premium Plan Saved!</b>',
              '━━━━━━━━━━━━━━━━━━',
              '',
              `✨ <b>#${row.id} ${escapeHtml(row.name)}</b>`,
              `💳 <b>UPI Price:</b> <code>${escapeHtml(formatMoney(row.price_minor, row.currency))}</code>${starsPrice ? ` · ⭐ <code>${starsPrice} ⭐</code>` : ''}`,
              `⏳ <b>Duration:</b> ${row.duration_days} day(s)`,
              ...(planUrl ? ['', `🔗 <b>Shareable Checkout Link:</b>\n<code>${escapeHtml(planUrl)}</code>`] : []),
              '',
              '💰 <i>Payments are received via platform Owner checkout and credited straight to your /me wallet.</i>',
            ].join('\n'),
            {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '👑 View Plan Details', callback_data: `cc:cplan:${row.id}` }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'cplan_stars_single': {
          const planId = active.meta?.planId;
          if (!planId) throw new Error('Missing Plan ID.');
          const planOwnerScope = getOwnerScope(ctx);
          const owned = await getPremiumPlanById(pool, planId, planOwnerScope);
          if (!owned) throw new Error('Plan not found.');
          if (!/^\d+$/.test(text)) throw new Error('Enter a non-negative integer Stars amount (e.g. 50, or 0 to remove).');
          const stars = Number(text);
          const updated = await setTelegramStarsPrice(pool, 'premium', planId, stars, ctx.from.id);
          return ctx.reply(
            stars === 0
              ? `🗑️ Telegram Stars price removed from Plan #${planId} (${owned.name}).`
              : `⭐ Saved Telegram Stars price for Plan #${planId} (${owned.name}): ${stars} ⭐\n⚡ Platform Stars Gateway: ${updated.isEnabled ? '🟢 ENABLED' : '⚪ Currently disabled by owner'}`,
            { reply_markup: backKeyboard },
          );
        }
        case 'stars_plan': {
          const fields = text.split('|').map((v) => v.trim());
          if (fields.length !== 2) throw new Error('Use: PLAN_ID|STARS (example: 1|50)');
          const planId = parsePositiveInt(fields[0], 'Plan ID');
          if (!/^\d+$/.test(fields[1])) throw new Error('Stars price must be a non-negative integer.');
          const stars = Number(fields[1]);
          const planRes = await pool.query('SELECT id, name FROM premium_plans WHERE id = $1 LIMIT 1', [planId]);
          if (!planRes.rowCount) throw new Error(`Premium plan #${planId} not found.`);
          const updated = await setTelegramStarsPrice(pool, 'premium', planId, stars, ctx.from.id);
          return ctx.reply(
            stars === 0
              ? `🗑️ Removed Stars price for Plan #${planId} (${planRes.rows[0].name}).`
              : `⭐ Saved Stars price for Plan #${planId} (${planRes.rows[0].name}): ${stars} ⭐\n⚡ Gateway: ${updated.isEnabled ? '🟢 ENABLED' : '🔴 DISABLED'}`,
            {
              reply_markup: {
                inline_keyboard: [
                  ...(!updated.isEnabled && stars > 0 ? [[{ text: '✅ Enable Telegram Stars', callback_data: 'cc:stars_en' }]] : []),
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'stars_paid': {
          const fields = text.split('|').map((v) => v.trim());
          if (fields.length !== 2) throw new Error('Use: LINK_ID_OR_CODE|STARS (example: 1|25)');
          if (!/^\d+$/.test(fields[1])) throw new Error('Stars price must be a non-negative integer.');
          const stars = Number(fields[1]);
          let linkId;
          let label;
          if (/^\d+$/.test(fields[0])) {
            linkId = Number(fields[0]);
            const res = await pool.query('SELECT id, public_code FROM paid_file_links WHERE id = $1 LIMIT 1', [linkId]);
            if (!res.rowCount) throw new Error(`Paid file link #${linkId} not found.`);
            label = `#${linkId} (${res.rows[0].public_code})`;
          } else {
            const link = await getPaidFileLink(pool, fields[0]);
            if (!link) throw new Error(`Paid file link "${fields[0]}" not found.`);
            linkId = link.id;
            label = `#${link.id} (${link.public_code})`;
          }
          const updated = await setTelegramStarsPrice(pool, 'paid_file', linkId, stars, ctx.from.id);
          return ctx.reply(
            stars === 0
              ? `🗑️ Removed Stars price for Paid Link ${label}.`
              : `⭐ Saved Stars price for Paid Link ${label}: ${stars} ⭐\n⚡ Gateway: ${updated.isEnabled ? '🟢 ENABLED' : '🔴 DISABLED'}`,
            {
              reply_markup: {
                inline_keyboard: [
                  ...(!updated.isEnabled && stars > 0 ? [[{ text: '✅ Enable Telegram Stars', callback_data: 'cc:stars_en' }]] : []),
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'stars_batch': {
          const fields = text.split('|').map((v) => v.trim());
          if (fields.length !== 2) throw new Error('Use: BATCH_ID_OR_CODE|STARS (example: 1|100)');
          if (!/^\d+$/.test(fields[1])) throw new Error('Stars price must be a non-negative integer.');
          const stars = Number(fields[1]);
          let batchId;
          let label;
          if (/^\d+$/.test(fields[0])) {
            batchId = Number(fields[0]);
            const res = await pool.query('SELECT id, title FROM paid_batch_links WHERE id = $1 LIMIT 1', [batchId]);
            if (!res.rowCount) throw new Error(`Paid batch link #${batchId} not found.`);
            label = `#${batchId} (${res.rows[0].title})`;
          } else {
            const batch = await getPaidBatch(pool, fields[0]);
            if (!batch) throw new Error(`Paid batch link "${fields[0]}" not found.`);
            batchId = batch.id;
            label = `#${batch.id} (${batch.title})`;
          }
          const updated = await setTelegramStarsPrice(pool, 'paid_batch', batchId, stars, ctx.from.id);
          return ctx.reply(
            stars === 0
              ? `🗑️ Removed Stars price for Batch ${label}.`
              : `⭐ Saved Stars price for Batch ${label}: ${stars} ⭐\n⚡ Gateway: ${updated.isEnabled ? '🟢 ENABLED' : '🔴 DISABLED'}`,
            {
              reply_markup: {
                inline_keyboard: [
                  ...(!updated.isEnabled && stars > 0 ? [[{ text: '✅ Enable Telegram Stars', callback_data: 'cc:stars_en' }]] : []),
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'premium_grant': {
          const [uRaw, pRaw, dRaw] = text.split(/\s+/);
          const userId = parseTelegramUserId(uRaw);
          const planId = parsePositiveInt(pRaw, 'Plan ID');
          const days = dRaw === undefined ? null : Number(dRaw);
          if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error('Override days must be 1–3650.');
          const result = await grantPremiumMembership(pool, userId, planId, days, ctx.from.id);
          return ctx.reply(
            result.permanent
              ? '💎 User already has permanent Premium.'
              : `✅ Premium Granted!\n━━━━━━━━━━━━━━━━━━\n👤 User: ${userId}\n💎 Plan: ${result.plan}\n⏳ Duration: ${result.days} days\n📅 Expires: ${result.expiresAt.toISOString()}`,
            { reply_markup: backKeyboard },
          );
        }
        case 'premium_status': {
          const userId = parseTelegramUserId(text);
          const rows = await getPremiumStatus(pool, userId);
          return ctx.reply(
            rows.length
              ? `💎 Premium Status · User ${userId}\n━━━━━━━━━━━━━━━━━━\n` + rows.map((r) => `✨ ${r.plan_name ?? 'plan'} · ${r.status}\n📅 Expires: ${r.expires_at ? new Date(r.expires_at).toISOString() : 'Never'}`).join('\n\n')
              : `ℹ️ No Premium records found for user ${userId}.`,
            { reply_markup: backKeyboard },
          );
        }
        case 'premium_revoke': {
          const userId = parseTelegramUserId(text);
          const count = await revokePremiumMembership(pool, userId, ctx.from.id);
          return ctx.reply(
            count ? `🚫 Revoked ${count} active Premium membership(s) for user ${userId}.` : `ℹ️ No active Premium membership found for user ${userId}.`,
            { reply_markup: backKeyboard },
          );
        }
        case 'payment_search': {
          const result = await searchPaymentTransactions(pool, text, 8);
          const kb = result.rows.map((row) => [{ text: `🧾 #${row.id} · ${String(row.status).toUpperCase()}`, callback_data: `paydetail:${row.id}:all:0` }]);
          kb.push(...backKeyboard.inline_keyboard);
          return ctx.reply(
            result.rows.length
              ? `🔎 Payment Search · "${result.term}" (${result.total} match(es))\n━━━━━━━━━━━━━━━━━━\n` + result.rows.map((r) => `🧾 #${r.id} · ${String(r.status).toUpperCase()} · ${r.method}\n👤 User: ${r.user_telegram_id ?? 'unknown'} · 💰 ${formatMoney(r.amount_minor, r.currency)}`).join('\n\n')
              : `🔍 No matching payment transactions for "${result.term}".`,
            { reply_markup: { inline_keyboard: kb }, disable_web_page_preview: true },
          );
        }
        case 'fampay_all': {
          try { await ctx.deleteMessage(); } catch {}
          const fields = text.split('|').map((s) => s.trim());
          if (fields.length < 3 || fields.length > 4) throw new Error('Use: gmail_email|gmail_app_password|upi_id|merchant_name(optional)');
          const saved = await saveFamPayConfig(pool, config, {
            gmailEmail: fields[0],
            gmailAppPassword: fields[1],
            upiId: fields[2],
            ...(fields[3] ? { merchantName: fields[3] } : {}),
          }, ctx.from.id);
          return ctx.reply(
            `✅ FamPay credentials saved!\n━━━━━━━━━━━━━━━━━━\n📧 Gmail: ${maskEmail(saved.gmailEmail)}\n🏦 UPI ID: ${saved.upiId}\n🏷 Merchant: ${saved.merchantName}\n🔒 App Password: Encrypted`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '🧪 Test Gmail IMAP', callback_data: 'cc:fampay_test' },
                    { text: '✅ Enable FamPay', callback_data: 'cc:pay_en_fampay' },
                  ],
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'fampay_gmail': {
          try { await ctx.deleteMessage(); } catch {}
          const fields = text.includes('|') ? text.split('|').map((s) => s.trim()) : text.split(/\s+/, 2);
          if (fields.length < 2 || !fields[0] || !fields[1]) throw new Error('Use: gmail_email|gmail_app_password');
          const saved = await saveFamPayConfig(pool, config, {
            gmailEmail: fields[0],
            gmailAppPassword: fields[1],
          }, ctx.from.id);
          return ctx.reply(
            `✅ Gmail & App Password Saved!\n━━━━━━━━━━━━━━━━━━\n📧 Gmail: ${maskEmail(saved.gmailEmail)}\n🔒 App Password: Encrypted`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🧪 Test Gmail IMAP', callback_data: 'cc:fampay_test' }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'fampay_upi': {
          const fields = text.split('|').map((s) => s.trim());
          if (fields.length < 1 || fields.length > 2 || !fields[0]) throw new Error('Use: upi_id|merchant_name(optional)');
          const saved = await saveFamPayConfig(pool, config, {
            upiId: fields[0],
            ...(fields[1] ? { merchantName: fields[1] } : {}),
          }, ctx.from.id);
          return ctx.reply(
            `✅ FamPay UPI Saved!\n━━━━━━━━━━━━━━━━━━\n🏦 UPI ID: ${saved.upiId}\n🏷 Merchant: ${saved.merchantName}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '✅ Enable FamPay', callback_data: 'cc:pay_en_fampay' }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'auto_delete': {
          if (!/^\d+$/.test(text)) throw new Error('Enter a non-negative integer (0 to disable, or 1–10080 minutes).');
          const minutes = Number(text);
          if (!Number.isSafeInteger(minutes) || minutes > 10080) throw new Error('Delay must be 0–10080 minutes.');
          await setAutoDeleteMinutes(pool, minutes, ctx.from.id);
          return ctx.reply(
            minutes
              ? `🧹 Auto-delete set to ${minutes} minute(s).\nDelivered files will be cleaned up automatically.`
              : '🧹 Auto-delete disabled.\nDelivered files will stay in user chats.',
            { reply_markup: backKeyboard },
          );
        }
        case 'shortener_add': {
          if (text.includes('|') || /\s/.test(text.trim())) {
            try { await ctx.deleteMessage(); } catch {}
            const existing = await listShortenerProviders(pool, ownerId);
            const parsed = parseShortenerInput(text, existing);
            const provider = await addShortenerProvider(pool, config, parsed, ctx.from.id, ownerId);
            clearShortenerDraft(ctx.from.id);
            return ctx.reply(
              `✅ Shortener #${provider.id} saved (${provider.is_enabled ? '🟢 ENABLED' : '⚪ DISABLED'})!\n━━━━━━━━━━━━━━━━━━\n🏷 Name: ${provider.name}\n🌐 Base URL: ${provider.base_url}\n🔌 API Endpoint: ${provider.api_endpoint}\n⏱ Duration: ${provider.checkpoint_minutes}m · 🔢 Priority: ${provider.priority}\n🔒 API Key: Encrypted`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '🧪 Test API Now', callback_data: `cc:short_test:${provider.id}` },
                      { text: '✏ Edit', callback_data: `cc:short_edit:${provider.id}` },
                    ],
                    [
                      { text: '➕ Add Another Shortener', callback_data: 'cc:short_new' },
                      { text: '🗑 Delete', callback_data: `cc:short_rm:${provider.id}` },
                    ],
                    ...backKeyboard.inline_keyboard,
                  ],
                },
                disable_web_page_preview: true,
              },
            );
          }

          const urls = normalizeShortenerUrls(text);
          setShortenerDraft(ctx.from.id, {
            baseUrl: urls.baseUrl,
            apiEndpoint: urls.apiEndpoint,
            hostname: urls.hostname,
          });
          setPrompt(ctx.from.id, 'shortener_wiz_key', { back: 'cc:short' });
          return ctx.reply(
            `➕ Add URL Shortener · Step 2 of 3\n━━━━━━━━━━━━━━━━━━\n🌐 Base URL: ${urls.baseUrl}\n🔌 API Endpoint: ${urls.apiEndpoint}\n\n🔑 Now send your API Key:\n🔒 Your message will be deleted immediately for security.`,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: '← Change Base URL', callback_data: 'cc:short_new' },
                  { text: '✖ Cancel', callback_data: 'cc:cancel_prompt' },
                ]],
              },
              disable_web_page_preview: true,
            },
          );
        }
        case 'shortener_wiz_key': {
          try { await ctx.deleteMessage(); } catch {}
          const draft = getShortenerDraft(ctx.from.id);
          if (!draft?.baseUrl) throw new Error('Setup session expired. Tap ➕ Add Shortener again.');
          const apiKey = text.trim();
          if (apiKey.length < 4) throw new Error('API key must be at least 4 characters.');
          const existing = await listShortenerProviders(pool, ownerId);
          const previewName = deriveUniqueShortenerName(draft.hostname, existing);
          setShortenerDraft(ctx.from.id, { ...draft, apiKey });
          return ctx.reply(
            `➕ Add URL Shortener · Step 3 of 3\n━━━━━━━━━━━━━━━━━━\n🏷 Name: ${previewName}\n🌐 Base URL: ${draft.baseUrl}\n🔌 API Endpoint: ${draft.apiEndpoint}\n🔑 API Key: 🔒 Ready\n\n⏱ Choose checkpoint unlock duration to save:`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '15 min', callback_data: 'cc:short_wiz_dur:15' },
                    { text: '1 hour', callback_data: 'cc:short_wiz_dur:60' },
                    { text: '6 hours', callback_data: 'cc:short_wiz_dur:360' },
                  ],
                  [
                    { text: '12 hours', callback_data: 'cc:short_wiz_dur:720' },
                    { text: '24 hours (Default)', callback_data: 'cc:short_wiz_dur:1440' },
                  ],
                  [
                    { text: '✏ Custom Minutes', callback_data: 'cc:short_wiz_dur:custom' },
                  ],
                  [
                    { text: '← Change API Key', callback_data: 'cc:short_wiz_key_back' },
                    { text: '✖ Cancel', callback_data: 'cc:cancel_prompt' },
                  ],
                ],
              },
              disable_web_page_preview: true,
            },
          );
        }
        case 'shortener_wiz_dur': {
          const draft = getShortenerDraft(ctx.from.id);
          if (!draft?.baseUrl || !draft?.apiKey) throw new Error('Setup session expired. Tap ➕ Add Shortener again.');
          const minutes = Number(text);
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
            throw new Error('Duration must be 1–10080 minutes.');
          }
          const existing = await listShortenerProviders(pool, ownerId);
          const name = deriveUniqueShortenerName(draft.hostname, existing);
          const provider = await addShortenerProvider(
            pool,
            config,
            {
              name,
              baseUrl: draft.baseUrl,
              apiEndpoint: draft.apiEndpoint,
              apiKey: draft.apiKey,
              apiKeyParam: 'api',
              targetUrlParam: 'url',
              responseUrlPath: 'shortenedUrl',
              responseFormat: 'json',
              checkpointMinutes: minutes,
              priority: 100,
              verificationMode: 'callback',
              enabled: true,
            },
            ctx.from.id,
            ownerId,
          );
          clearShortenerDraft(ctx.from.id);
          return ctx.reply(
            `✅ Shortener #${provider.id} Added!\n━━━━━━━━━━━━━━━━━━\n🏷 Name: ${provider.name}\n🌐 Base URL: ${provider.base_url}\n🔌 API Endpoint: ${provider.api_endpoint}\n⏱ Duration: ${provider.checkpoint_minutes} min · 🔢 Priority: ${provider.priority}\n🟢 Status: Enabled · 🔒 API Key: Encrypted`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '🧪 Test API Now', callback_data: `cc:short_test:${provider.id}` },
                    { text: '✏ Edit', callback_data: `cc:short_edit:${provider.id}` },
                  ],
                  [
                    { text: '➕ Add Another Shortener', callback_data: 'cc:short_new' },
                    { text: '🗑 Delete', callback_data: `cc:short_rm:${provider.id}` },
                  ],
                  ...backKeyboard.inline_keyboard,
                ],
              },
              disable_web_page_preview: true,
            },
          );
        }
        case 'shortener_name': {
          const id = active.meta?.providerId;
          if (!id) throw new Error('Missing shortener provider ID.');
          const updated = await updateShortenerName(pool, id, text, ownerId);
          if (!updated) throw new Error('Shortener provider not found.');
          return ctx.reply(
            `✅ Name updated for #${updated.id}: ${updated.name}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '✏ Back to Edit', callback_data: `cc:short_edit:${id}` }, { text: '← Details', callback_data: `cc:short_p:${id}` }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'shortener_url': {
          const id = active.meta?.providerId;
          if (!id) throw new Error('Missing shortener provider ID.');
          const urls = normalizeShortenerUrls(text);
          const updated = await updateShortenerCredentials(pool, config, id, {
            baseUrl: urls.baseUrl,
            apiEndpoint: urls.apiEndpoint,
          }, ownerId);
          if (!updated) throw new Error('Shortener provider not found.');
          return ctx.reply(
            `✅ Base URL updated for #${updated.id} ${updated.name}\n━━━━━━━━━━━━━━━━━━\n🌐 Base URL: ${updated.base_url}\n🔌 API Endpoint: ${updated.api_endpoint}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🧪 Test API Now', callback_data: `cc:short_test:${id}` }, { text: '✏ Back to Edit', callback_data: `cc:short_edit:${id}` }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
              disable_web_page_preview: true,
            },
          );
        }
        case 'shortener_ep': {
          const id = active.meta?.providerId;
          if (!id) throw new Error('Missing shortener provider ID.');
          const existing = await getShortenerProviderById(pool, id, ownerId);
          if (!existing) throw new Error('Shortener provider not found.');
          const urls = normalizeShortenerUrls(existing.base_url, text);
          const updated = await updateShortenerCredentials(pool, config, id, {
            apiEndpoint: urls.apiEndpoint,
          }, ownerId);
          return ctx.reply(
            `✅ API Endpoint updated for #${updated.id} ${updated.name}:\n🔌 ${updated.api_endpoint}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🧪 Test API Now', callback_data: `cc:short_test:${id}` }, { text: '✏ Back to Edit', callback_data: `cc:short_edit:${id}` }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
              disable_web_page_preview: true,
            },
          );
        }
        case 'shortener_key': {
          try { await ctx.deleteMessage(); } catch {}
          const id = active.meta?.providerId;
          if (!id) throw new Error('Missing shortener provider ID.');
          const apiKey = text.trim();
          if (apiKey.length < 4) throw new Error('API key must be at least 4 characters.');
          const updated = await updateShortenerCredentials(pool, config, id, { apiKey }, ownerId);
          if (!updated) throw new Error('Shortener provider not found.');
          return ctx.reply(
            `✅ API key updated for #${updated.id} ${updated.name} (🔒 Encrypted).`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🧪 Test API Now', callback_data: `cc:short_test:${updated.id}` }, { text: '✏ Back to Edit', callback_data: `cc:short_edit:${id}` }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'shortener_dur': {
          const id = active.meta?.providerId;
          if (!id) throw new Error('Missing shortener provider ID.');
          const minutes = Number(text);
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('Duration must be 1–10080 minutes.');
          const row = await setShortenerDuration(pool, id, minutes, ownerId);
          if (!row) throw new Error('Shortener provider not found.');
          return ctx.reply(
            `✅ Checkpoint duration updated for ${row.name}: ${minutes} minutes.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '✏ Back to Edit', callback_data: `cc:short_edit:${id}` }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'shortener_prio': {
          const id = active.meta?.providerId;
          if (!id) throw new Error('Missing shortener provider ID.');
          const priority = Number(text);
          if (!Number.isInteger(priority) || priority < 1 || priority > 100000) throw new Error('Priority must be 1–100000.');
          const row = await setShortenerPriority(pool, id, priority, ownerId);
          if (!row) throw new Error('Shortener provider not found.');
          return ctx.reply(
            `✅ Priority updated for ${row.name}: ${priority}.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '✏ Back to Edit', callback_data: `cc:short_edit:${id}` }],
                  ...backKeyboard.inline_keyboard,
                ],
              },
            },
          );
        }
        case 'owner_bot_prio': {
          if (!isOwnerAdmin(ctx)) throw new Error('Owner permission required.');
          const id = active.meta?.botId;
          if (!id) throw new Error('Missing delivery bot ID.');
          const priority = Number(text);
          if (!Number.isInteger(priority) || priority < 0 || priority > 100000) {
            throw new Error('Priority must be an integer between 0 and 100000.');
          }
          const updated = await updateDeliveryBotForOwner(pool, id, { priority }, deliveryManager);
          if (!updated) throw new Error('Delivery bot not found.');
          return ctx.reply(
            `✅ Priority updated for @${updated.bot.username} (#${updated.bot.id}): ${priority}.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🤖 Bot Details', callback_data: `cc:all_bot:${id}` }, { text: '🌐 All Bots', callback_data: 'cc:all_bots:0' }],
                  [{ text: '🎛 Main Menu', callback_data: 'cc:home' }],
                ],
              },
            },
          );
        }
        default:
          return next();
      }
    } catch (error) {
      if (active.action === 'delivery_bot_add' && error?.code === 'BOT_SLOT_LIMIT_REACHED') {
        return ctx.reply('🔒 ' + error.message, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔓 Unlock +1 Slot', callback_data: 'cc:slot_unlock' }],
              ...backKeyboard.inline_keyboard,
            ],
          },
        });
      }
      const retryRow = active.action === 'storage_add'
        ? [[{ text: '↻ Try Again', callback_data: 'cc:prompt:storage_add' }]]
        : active.action === 'delivery_bot_add'
          ? [[{ text: '↻ Try Again', callback_data: 'cc:prompt:delivery_bot_add' }]]
          : active.action === 'bot_replace' && active.meta?.botId
            ? [[{ text: '↻ Try Again', callback_data: `cc:bot_replace:${active.meta.botId}` }]]
            : [];
      return ctx.reply('❌ Action failed: ' + error.message, {
        reply_markup: { inline_keyboard: [...retryRow, ...backKeyboard.inline_keyboard] },
      });
    }
  });

  function clearAllSessions(userId) {
    pendingPrompts.delete(String(userId));
    clearShortenerDraft(userId);
    shareLinksUi.clearSession(userId);
    paidLinksUi.clearSession(userId);
    walletUi.clearSession(userId);
  }

  return { showHome, clearAllSessions };
}
