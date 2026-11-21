import { isAdmin } from './admin-guard.js';
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
import { getRecentDeliveryJobs, retryFailedDeliveryJob } from '../delivery/repository.js';
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
} from '../payments/fampay.js';
import {
  loadStarsConfig,
  setTelegramStarsPrice,
  enableTelegramStars,
  testTelegramStars,
  getTelegramStarsPrice,
} from '../payments/telegram-stars.js';
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
    title: '📘 FileStore User & Creator Guide',
    body: [
      'Turn your Telegram media into shareable links, protected packs, or paid content — and withdraw your earnings directly to your UPI ID.',
      '',
      '<b>🚀 How It Works (4 Simple Steps)</b>',
      '<blockquote><b>1. Upload Media</b> — Send or forward any video, file, photo, or audio directly to this chat (or start /link, /Batch, or /plink first).\n' +
        '<b>2. Generate Links</b> — Create free single links (/link), multi-file bundles up to 20 items (/Batch), or monetized paid links (/plink).\n' +
        '<b>3. Customize (Optional)</b> — Connect your own Storage Channel, Delivery Bot, URL Shorteners, and Force-Sub channels anytime.\n' +
        '<b>4. Earn &amp; Withdraw</b> — Paid link sales credit your creator balance automatically. Use /me to add your UPI ID and request a payout.</blockquote>',
      '',
      '<b>⚡ Essential Commands</b>',
      '• /menu — Open Creator Hub',
      '• /link — Share link for 1 media file',
      '• /Batch — Share link for up to 20 media files',
      '• /plink — Create paid link (Single or Batch)',
      '• /my_plans — Create &amp; manage your own Premium membership plans',
      '• /links — View, rename, edit, or delete links',
      '• /me — Balance, UPI ID &amp; withdrawals',
      '• /token — Get or regenerate your Web Control Panel token',
      '• /guide — Open this interactive guide anytime',
      '• /cancel — Exit any active input step',
      '',
      '<i>Tap any topic button below for detailed step-by-step instructions.</i>',
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
      '<blockquote>• Open /links to see every generated link.\n' +
        '• Tap any link to copy the URL, <b>rename</b> the title/file, add or remove batch files, pause/resume, or <b>permanently delete</b> it.\n' +
        '• Quick search: /files, /find &lt;keyword&gt;, /fileinfo &lt;code&gt;.</blockquote>',
    ].join('\n'),
  },
  paid: {
    label: '💎 Paid & Plans',
    title: '💎 Paid Links & Your Own Premium Plans',
    body: [
      'Monetize your content in two ways — sell individual files/bundles with /plink, or offer your own ad-free <b>Creator Premium Membership Plans</b> with /my_plans!',
      '',
      '<b>✨ 1. Paid Links (/plink)</b>',
      '<blockquote><b>Step 1:</b> Run /plink and choose <b>Single Media</b> or <b>Batch (2–20 files)</b>.\n' +
        '<b>Step 2:</b> Send your media (for Batch, tap <b>Done</b> and enter a bundle title).\n' +
        '<b>Step 3:</b> Set your price in one message:\n' +
        '  • UPI only: <code>99 INR</code>\n' +
        '  • UPI + Stars: <code>99 INR | 50 stars</code>\n' +
        '  • Stars only: <code>50 stars</code>\n' +
        '  • Optional expiry: <code>99 INR | 7d</code></blockquote>',
      '',
      '<b>👑 2. Your Own Premium Plans (/my_plans)</b>',
      '<blockquote>• Tap <b>👑 My Premium Plans</b> (or /my_plans) to create custom VIP tiers (e.g. <code>VIP Monthly|99|30</code>).\n' +
        '• Share your plan checkout link or let buyers tap <b>💎 Skip Ads — Creator Premium</b> right from your shortener checkpoints!\n' +
        '• Buyers who purchase your Premium plan skip <b>your</b> URL shortener checkpoints automatically.\n' +
        '• Payments are collected via the platform Owner’s UPI / Stars checkout and credited directly to your <b>/me</b> wallet balance!</blockquote>',
      '',
      '<b>ℹ Important Note</b>',
      '• Premium memberships bypass free URL-shortener checkpoints only and never unlock paid links (/plink).',
    ].join('\n'),
  },
  setup: {
    label: '🗄 Storage & Bot',
    title: '🗄 Storage Channel & Delivery Bot Setup',
    body: [
      'Works out of the box with shared platform defaults — or connect your own private channel and branded Delivery Bot.',
      '',
      '<b>🗄 Connect Your Own Storage Channel (Optional)</b>',
      '<blockquote><b>1.</b> Create a private Telegram channel for your files.\n' +
        '<b>2.</b> Add <b>this Main Bot</b> as an Administrator with <b>Post Messages</b> permission.\n' +
        '<b>3.</b> Also add the Delivery Bot (shared or your own) as Admin/Member so it can forward files to users.\n' +
        '<b>4.</b> Tap <b>🗄 Storage Channel → ➕ Add Channel</b> (or run <code>/storage_add -100xxxxxxxxxx</code>).</blockquote>',
      '',
      '<b>🤖 Connect Your Own Delivery Bot (Optional)</b>',
      '<blockquote><b>1.</b> Open @BotFather and create a new bot to get a Bot Token.\n' +
        '<b>2.</b> Tap <b>🤖 Delivery Bot → ➕ Add Delivery Bot</b> and send the token (your token message is deleted immediately and encrypted).\n' +
        '<b>3.</b> Make your new Delivery Bot an Admin in your storage &amp; force-sub channels.\n' +
        '<b>4.</b> All new links you create will automatically use your custom bot username!</blockquote>',
      '',
      '<i>Tip: You can pause, test, switch primary, or remove your custom bot anytime.</i>',
    ].join('\n'),
  },
  short: {
    label: '⚡ Shorteners & F-Sub',
    title: '⚡ URL Shorteners & Force-Sub Guide',
    body: [
      'Grow your Telegram channels and earn extra ad revenue on free links using your own shorteners and Force-Sub rules.',
      '',
      '<b>🔗 URL Shorteners (Multiple Rotation Supported)</b>',
      '<blockquote><b>1.</b> Open <b>🔗 Shorteners → ➕ Add Shortener</b>.\n' +
        '<b>2.</b> Follow the 3-step button wizard (Base URL → API Key → Unlock Duration) or paste <code>https://domain.com|API_KEY</code>.\n' +
        '<b>3.</b> Add multiple shorteners to rotate automatically by priority.\n' +
        '<b>4.</b> Tap <b>🧪 Test API</b>, then toggle <b>Checkpoints: ON</b>.\n' +
        '• Your checkpoints are isolated — unlocking another creator\'s shortener never bypasses yours.</blockquote>',
      '',
      '<b>🔒 Force-Subscription Channels</b>',
      '<blockquote><b>1.</b> Add this bot (and your Delivery Bot) as Administrator in your Telegram channel.\n' +
        '<b>2.</b> Open <b>🔒 Force-Sub → ➕ Add Channel</b> and send <code>@channel https://t.me/joinlink</code> (or numeric <code>-100...</code> ID).\n' +
        '<b>3.</b> Toggle <b>Force-Sub: ON</b> so users must join before receiving your files.</blockquote>',
    ].join('\n'),
  },
  earn: {
    label: '💰 Balance & UPI',
    title: '💰 Creator Balance & Manual UPI Withdrawals',
    body: [
      'Track all earnings from your paid links and Creator Premium membership plans, and withdraw your INR balance straight to your UPI ID.',
      '',
      '<b>📊 Checking Your Balance (/me)</b>',
      '<blockquote>• Run /me or tap <b>💰 Balance &amp; Withdraw</b>.\n' +
        '• View <b>Available Balance</b>, <b>Pending Withdrawal Lock</b>, <b>Total Earned</b>, <b>Total Withdrawn</b>, and full ledger history.</blockquote>',
      '',
      '<b>💸 How to Withdraw to Your UPI ID</b>',
      '<blockquote><b>1.</b> Tap <b>📲 Set Payout UPI ID</b> and enter your UPI handle (e.g. <code>yourname@fam</code>, <code>name@okaxis</code>, <code>9876543210@ybl</code>).\n' +
        '<b>2.</b> Tap <b>💸 Withdraw Funds</b> (or run /withdraw) when you have at least <b>₹1.00 INR</b> available.\n' +
        '<b>3.</b> Choose full balance or a custom amount and confirm.\n' +
        '<b>4.</b> Your requested amount is safely locked while the platform owner transfers funds manually to your UPI ID.\n' +
        '<b>5.</b> You receive an automatic DM as soon as the transfer is marked <b>Paid</b> (with UTR reference) — or refunded instantly if rejected.</blockquote>',
    ].join('\n'),
  },
};

const PROMPT_CONFIGS = {
  storage_add: {
    back: 'cc:storage',
    prompt: '🗄 Send the Telegram channel ID (e.g. -1001234567890) or @username to add as a storage channel.\n\n⚠️ Make sure this bot is an administrator with permission to post messages.',
  },
  find: {
    back: 'cc:files:0',
    prompt: '🔎 Send a filename keyword or file code to search your indexed files:',
  },
  delivery_bot_add: {
    back: 'cc:bots',
    prompt: '🤖 Send the @BotFather token for the Delivery Bot.\n🔒 Your message will be deleted immediately for security.',
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
        { text: '↻ Refresh Overview', callback_data: 'cc:home' },
      ],
    ],
  };
}

export function buildPublicMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔗 Single Link (/link)', callback_data: 'cc:cmd_link' },
        { text: '📦 Batch Link (/Batch)', callback_data: 'cc:cmd_batch' },
      ],
      [
        { text: '💎 Paid Link (/plink)', callback_data: 'cc:plink' },
        { text: '📋 My Links (/links)', callback_data: 'cc:links:0' },
      ],
      [
        { text: '🗄 Storage Channel', callback_data: 'cc:storage' },
        { text: '🤖 Delivery Bot', callback_data: 'cc:bots' },
      ],
      [
        { text: '⚡ Shorteners', callback_data: 'cc:short' },
        { text: '🔒 Force-Sub', callback_data: 'cc:fsub' },
      ],
      [
        { text: '👑 My Premium Plans', callback_data: 'cc:cplans' },
        { text: '💰 Balance & Withdraw (/me)', callback_data: 'cc:me' },
      ],
      [
        { text: '🌐 Web Panel Token', callback_data: 'cc:webtok' },
        { text: '📘 User Guide (/guide)', callback_data: 'cc:uguide:overview' },
      ],
      [
        { text: '↻ Refresh', callback_data: 'cc:home' },
      ],
    ],
  };
}

export function registerControlCenter(bot, config, logger, pool, options = {}) {
  const deliveryManager = config.deliveryManager;
  const pendingPrompts = new Map();
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
        `Welcome, <b>${displayName}</b>!`,
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
          pool.query('SELECT COUNT(*)::int AS total FROM share_links WHERE created_by = $1', [creatorId]),
          listStorageChannels(pool, null).catch(() => []),
          getShareableBotUsername(pool, null).catch(() => null),
        ]);
        const activeOwnStorage = ownStorage.filter((c) => c.is_enabled).length;
        const activeOwnBot = ownBots.find((b) => b.is_enabled);
        const enabledShorts = shorteners.filter((s) => s.is_enabled).length;
        const activePlans = ownPlans.filter((p) => p.is_enabled).length;
        const storageStatus = activeOwnStorage
          ? `✅ <code>${activeOwnStorage}</code> custom channel(s)`
          : sharedStorage.some((c) => c.is_enabled)
            ? '☁️ Shared platform storage <i>(auto)</i>'
            : '⚠️ Not configured — tap <b>Storage Channel</b>';
        const botStatus = activeOwnBot
          ? `✅ @${escapeHtml(activeOwnBot.username)} <i>(custom)</i>`
          : sharedBotUsername
            ? `☁️ @${escapeHtml(sharedBotUsername)} <i>(shared)</i>`
            : '⚠️ None active';
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
          : '<i>Not set (tap /me)</i>';

        lines = [
          '✨ <b>FileStore Creator Hub</b>',
          `👋 Welcome, <b>${displayName}</b>! Share files, monetize links &amp; sell your own Premium plans.`,
          '',
          '📊 <b>Workspace Overview</b>',
          `<blockquote>📁 <b>Files:</b> <code>${fileCountRes.rows[0]?.total ?? 0}</code>  •  🔗 <b>Links:</b> <code>${linkCountRes.rows[0]?.total ?? 0}</code>\n` +
            `🗄 <b>Storage:</b> ${storageStatus}\n` +
            `🤖 <b>Delivery Bot:</b> ${botStatus}\n` +
            `⚡ <b>Shorteners:</b> <code>${enabledShorts}</code> active (${chkBadge})\n` +
            `🔒 <b>Force-Sub:</b> ${fsubBadge}  •  👑 <b>My Plans:</b> <code>${activePlans}</code></blockquote>`,
          '',
          '💰 <b>Creator Wallet</b>',
          `<blockquote>💵 <b>Available:</b> <code>${availableText}</code>  •  ⏳ <b>Locked:</b> <code>${lockedText}</code>\n` +
            `📈 <b>Total Earned:</b> <code>${earnedText}</code>${xtrLine}\n` +
            `📲 <b>Payout UPI:</b> ${upiStatus}</blockquote>`,
          '',
          '🚀 <b>Quick Actions</b>',
          '• Send/forward media here to upload &amp; index',
          '• /link (1 file)  •  /Batch (up to 20)  •  /plink (paid)',
          '• /my_plans (your Premium plans)  •  /me (withdraw)  •  /guide',
        ];
      } catch (error) {
        logger.warn({ creatorId, error: error.message }, 'Creator hub summary fallback');
        lines.push(
          '🚀 Send media here to index, use /link, /Batch, /plink, /me, or tap <b>📘 User Guide (/guide)</b> below:',
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
    const text = [
      `📁 Indexed Files · Page ${activePage + 1} / ${pages} (${total} total)`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      rows.length
        ? rows.map((f, i) => `${activePage * FILES_PAGE_SIZE + i + 1}. 📄 ${String(f.file_name).slice(0, 120)}\n🏷 Code: ${f.file_code} · 📦 ${f.file_type} · ${formatFileSize(f.file_size)}`).join('\n\n')
        : '📭 No files indexed yet. Send any supported media file to this bot to index it!',
    ].join('\n');
    const keyboard = rows.map((f) => [
      { text: `📄 ${f.file_code} · ${String(f.file_name).slice(0, 26)}`, callback_data: `cc:file:${f.file_code}` },
    ]);
    keyboard.push([{ text: '🔎 Search Files', callback_data: 'cc:prompt:find' }]);
    const nav = [];
    if (activePage > 0) nav.push({ text: '← Prev', callback_data: `cc:files:${activePage - 1}` });
    nav.push({ text: '↻ Refresh', callback_data: `cc:files:${activePage}` });
    if (activePage < pages - 1) nav.push({ text: 'Next →', callback_data: `cc:files:${activePage + 1}` });
    keyboard.push(nav);
    keyboard.push([{ text: '← Main Menu', callback_data: 'cc:home' }]);
    return renderView(ctx, text, { inline_keyboard: keyboard }, edit);
  }

  async function showFileDetail(ctx, code, edit = true) {
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
    ].join('\n');
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔗 Generate Share Link', callback_data: `cc:mklink:${file.file_code}` },
          { text: '✏ Rename File', callback_data: `cc:frename:${file.file_code}` },
        ],
        [
          { text: '← Files List', callback_data: 'cc:files:0' },
          { text: '← Main Menu', callback_data: 'cc:home' },
        ],
      ],
    };
    return renderView(ctx, text, keyboard, edit);
  }

  async function showBots(ctx, edit = false) {
    const ownerId = getOwnerScope(ctx);
    const rows = await deliveryManager.list(ownerId);
    let fallbackNote = '';
    if (!rows.length && ownerId !== null) {
      const sharedUsername = await getShareableBotUsername(pool, null).catch(() => null);
      if (sharedUsername) {
        fallbackNote = `\n\n☁️ Currently using shared platform Delivery Bot @${sharedUsername}. Adding your own Delivery Bot is completely optional.`;
      }
    }
    const lines = rows.length
      ? rows.map((row) => `#${row.id} · 🤖 @${row.username} (${row.role === 'primary' ? '⭐ PRIMARY' : row.role.toUpperCase()})\n⚡ Runtime: ${row.runtime_status === 'running' ? '🟢 running' : '🟡 ' + row.runtime_status} · Enabled: ${row.is_enabled ? '✅' : '⏸'} · Priority: ${row.priority}${row.last_error ? '\n⚠️ Error: ' + String(row.last_error).slice(0, 120) : ''}`)
      : [`🤖 No custom Delivery Bots registered yet. Add one with the button below.${fallbackNote}`];
    const keyboard = rows.slice(0, 8).map((row) => [
      {
        text: `${row.role === 'primary' ? '⭐ ' : ''}${row.runtime_status === 'running' ? '🟢' : '🟡'} @${row.username} (#${row.id})`,
        callback_data: `cc:bot:${row.id}`,
      },
    ]);
    keyboard.push([{ text: '➕ Add Delivery Bot', callback_data: 'cc:prompt:delivery_bot_add' }]);
    keyboard.push([
      { text: '↻ Refresh', callback_data: 'cc:bots' },
      { text: '← Main Menu', callback_data: 'cc:home' },
    ]);
    return renderView(ctx, '🤖 Delivery Bots\n━━━━━━━━━━━━━━━━━━\n\n' + lines.join('\n\n'), { inline_keyboard: keyboard }, edit);
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
        ...(botRow.role !== 'primary' ? [{ text: '⭐ Set Primary', callback_data: `cc:bot_pri:${botRow.id}` }] : []),
      ],
    ];
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
        { text: '💰 Wallet (/me)', callback_data: 'cc:me' },
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
        { text: '➕ Create Paid Link (/plink)', callback_data: 'cc:plink_single' },
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
        { text: '➕ Create Batch Link (/plink)', callback_data: 'cc:plink_batch' },
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
    if (key === 'links') {
      contextualRow.push(
        { text: '🔗 Create /link', callback_data: 'cc:cmd_link' },
        { text: '📦 Create /Batch', callback_data: 'cc:cmd_batch' },
      );
    } else if (key === 'paid') {
      contextualRow.push(
        { text: '💎 Create /plink', callback_data: 'cc:plink' },
        { text: '👑 My Plans', callback_data: 'cc:cplans' },
      );
    } else if (key === 'setup') {
      contextualRow.push(
        { text: '🗄 Storage Channel', callback_data: 'cc:storage' },
        { text: '🤖 Delivery Bot', callback_data: 'cc:bots' },
      );
    } else if (key === 'short') {
      contextualRow.push(
        { text: '⚡ Shorteners', callback_data: 'cc:short' },
        { text: '🔒 Force-Sub', callback_data: 'cc:fsub' },
      );
    } else if (key === 'earn') {
      contextualRow.push(
        { text: '💰 Open /me Wallet', callback_data: 'cc:me' },
        { text: '👑 My Plans', callback_data: 'cc:cplans' },
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
          { text: '📘 User Guide (/guide)', callback_data: 'cc:uguide:overview' },
        ],
        [
          { text: '🎛 Open Control Center', callback_data: 'cc:home' },
        ],
      ],
    };
    return renderView(ctx, `📖 ${sec.title}\n\n${sec.body}`, keyboard, edit);
  }

  // Entry commands
  bot.command('start', async (ctx) => {
    clearPrompt(ctx.from.id);
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
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
  bot.action(/^cc:file:([A-Za-z0-9_-]{2,32})$/, async (ctx) => { await safeAnswer(ctx); await showFileDetail(ctx, ctx.match[1], true); });
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

  // Delivery Bot actions
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

  // Delivery job retry
  bot.action(/^cc:job_retry:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const jobId = Number(ctx.match[1]);
    const result = await retryFailedDeliveryJob(pool, jobId);
    await safeAnswer(
      ctx,
      result.ok ? `Requeued job #${jobId} (${result.retriedItems} item(s))` : `Retry blocked (${result.reason})`,
      !result.ok,
    );
    await showJobs(ctx, true);
  });

  // Force-Sub actions
  bot.action(/^cc:fsub_g:(0|1)$/, async (ctx) => {
    const enabled = ctx.match[1] === '1';
    await setForceSubGlobal(pool, enabled, ctx.from.id, getOwnerScope(ctx));
    await safeAnswer(ctx, `Force-subscription ${enabled ? 'enabled' : 'disabled'}.`);
    await showForceSub(ctx, true);
  });

  bot.action(/^cc:fsub_ch:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showForceSubDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:fsub_rm:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showForceSubDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:fsub_test:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedForceSubRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const chatId = Number(ch.telegram_chat_id);
    try {
      await validateForceSubChannel(ctx, chatId, { requireUserAdmin: !isOwnerAdmin(ctx) });
      await pool.query("UPDATE force_sub_channels SET last_test_status = 'ok', last_test_error = NULL, updated_at = NOW() WHERE id = $1", [ch.id]);
      await safeAnswer(ctx, 'Force-sub admin check passed!', true);
    } catch (error) {
      await pool.query("UPDATE force_sub_channels SET last_test_status = 'failed', last_test_error = $2, updated_at = NOW() WHERE id = $1", [ch.id, error.message.slice(0, 500)]).catch(() => {});
      await safeAnswer(ctx, 'Test failed: ' + error.message, true);
    }
    await showForceSubDetail(ctx, id, true);
  });

  bot.action(/^cc:fsub_(en|dis|rm_ok):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const ownerId = getOwnerScope(ctx);
    const ch = await findOwnedForceSubRow(id, ownerId);
    if (!ch) return safeAnswer(ctx, 'Channel not found.', true);
    const chatId = Number(ch.telegram_chat_id);
    if (action === 'rm_ok') {
      await removeForceSubChannel(pool, chatId, ownerId);
      await safeAnswer(ctx, 'Force-sub channel removed.');
      return showForceSub(ctx, true);
    }
    await setForceSubEnabled(pool, chatId, action === 'en', ownerId);
    await safeAnswer(ctx, action === 'en' ? 'Channel enabled.' : 'Channel disabled.');
    return showForceSubDetail(ctx, id, true);
  });

  // Shortener & Checkpoint actions
  bot.action(/^cc:chk_g:(0|1)$/, async (ctx) => {
    const enable = ctx.match[1] === '1';
    const ownerId = getOwnerScope(ctx);
    if (enable) {
      const providers = ownerId === null
        ? await pool.query('SELECT id FROM shortener_providers WHERE is_enabled = TRUE AND owner_telegram_id IS NULL')
        : await pool.query('SELECT id FROM shortener_providers WHERE is_enabled = TRUE AND owner_telegram_id = $1', [ownerId]);
      if (!providers.rowCount) {
        return safeAnswer(ctx, 'Cannot enable checkpoints: no enabled shortener providers.', true);
      }
    }
    if (ownerId !== null) {
      await setCreatorCheckpointEnabled(pool, ownerId, enable);
    } else {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ('checkpoint_enabled', $1::jsonb, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [JSON.stringify(enable), ctx.from.id],
      );
    }
    await safeAnswer(ctx, `Checkpoints ${enable ? 'enabled' : 'disabled'}.`);
    await showShorteners(ctx, true);
  });

  bot.action('cc:short_new', async (ctx) => {
    clearShortenerDraft(ctx.from.id);
    setPrompt(ctx.from.id, 'shortener_add', { back: 'cc:short' });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      PROMPT_CONFIGS.shortener_add.prompt,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action('cc:short_wiz_key_back', async (ctx) => {
    const draft = getShortenerDraft(ctx.from.id);
    if (!draft) {
      clearShortenerDraft(ctx.from.id);
      setPrompt(ctx.from.id, 'shortener_add', { back: 'cc:short' });
      await safeAnswer(ctx);
      return renderView(
        ctx,
        PROMPT_CONFIGS.shortener_add.prompt,
        { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
        true,
      );
    }
    setPrompt(ctx.from.id, 'shortener_wiz_key', { back: 'cc:short' });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      `➕ Add URL Shortener · Step 2 of 3\n━━━━━━━━━━━━━━━━━━\n🌐 Base URL: ${draft.baseUrl}\n🔌 API Endpoint: ${draft.apiEndpoint}\n\n🔑 Now send your API Key:\n🔒 Your message will be deleted immediately for security.`,
      {
        inline_keyboard: [[
          { text: '← Change Base URL', callback_data: 'cc:short_new' },
          { text: '✖ Cancel', callback_data: 'cc:cancel_prompt' },
        ]],
      },
      true,
    );
  });

  bot.action(/^cc:short_wiz_dur:(custom|\d+)$/, async (ctx) => {
    const choice = ctx.match[1];
    const draft = getShortenerDraft(ctx.from.id);
    if (!draft?.baseUrl || !draft?.apiKey) {
      await safeAnswer(ctx, 'Setup session expired. Start again.', true);
      return showShorteners(ctx, true);
    }
    if (choice === 'custom') {
      setPrompt(ctx.from.id, 'shortener_wiz_dur', { back: 'cc:short' });
      await safeAnswer(ctx);
      return renderView(
        ctx,
        `⏱ Add URL Shortener · Custom Duration\n━━━━━━━━━━━━━━━━━━\n🌐 Base URL: ${draft.baseUrl}\n\n✏️ Send unlock duration in minutes (1–10080):`,
        { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
        true,
      );
    }
    const ownerId = getOwnerScope(ctx);
    const checkpointMinutes = Number(choice);
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
        checkpointMinutes,
        priority: 100,
        verificationMode: 'callback',
        enabled: true,
      },
      ctx.from.id,
      ownerId,
    );
    clearShortenerDraft(ctx.from.id);
    clearPrompt(ctx.from.id);
    await safeAnswer(ctx, `✅ Shortener #${provider.id} saved!`);
    return renderView(
      ctx,
      `✅ Shortener #${provider.id} Added!\n━━━━━━━━━━━━━━━━━━\n🏷 Name: ${provider.name}\n🌐 Base URL: ${provider.base_url}\n🔌 API Endpoint: ${provider.api_endpoint}\n⏱ Duration: ${provider.checkpoint_minutes} min · 🔢 Priority: ${provider.priority}\n🟢 Status: Enabled · 🔒 API Key: Encrypted`,
      {
        inline_keyboard: [
          [
            { text: '🧪 Test API Now', callback_data: `cc:short_test:${provider.id}` },
            { text: '✏ Edit', callback_data: `cc:short_edit:${provider.id}` },
          ],
          [
            { text: '➕ Add Another Shortener', callback_data: 'cc:short_new' },
            { text: '🗑 Delete', callback_data: `cc:short_rm:${provider.id}` },
          ],
          [
            { text: '← Shorteners', callback_data: 'cc:short' },
            { text: '← Main Menu', callback_data: 'cc:home' },
          ],
        ],
      },
      true,
    );
  });

  bot.action(/^cc:short_p:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showShortenerDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:short_edit:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showShortenerEdit(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:short_rm:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showShortenerDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:short_test:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    try {
      const p = await getShortenerProviderById(pool, id, ownerId);
      if (!p) return safeAnswer(ctx, 'Provider not found.', true);
      const apiKey = decryptShortenerApiKey(p, config.tokenEncryptionKey);
      if (!apiKey) throw new Error('No API key set for this shortener.');
      const deliveryUsername = await getShareableBotUsername(pool, ownerId).catch(() => null);
      const targetHandle = String(deliveryUsername || ctx.botInfo?.username || 'telegram').replace(/^@+/, '');
      const result = await shortenUrlWithProvider(p, `https://t.me/${targetHandle}?start=chk_test`, apiKey);
      await markShortenerTest(pool, id, 'ok', null, ownerId);
      await safeAnswer(ctx, `API OK → ${result.shortUrl}`, true);
    } catch (error) {
      await markShortenerTest(pool, id, 'failed', error.message, ownerId).catch(() => {});
      await safeAnswer(ctx, 'API test failed: ' + error.message, true);
    }
    await showShortenerDetail(ctx, id, true);
  });

  bot.action(/^cc:short_en:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const p = await getShortenerProviderById(pool, id, ownerId);
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    if (!p.api_key_ciphertext) {
      return safeAnswer(ctx, 'Set an API key before enabling this shortener.', true);
    }
    await setShortenerEnabled(pool, id, true, ownerId);
    await safeAnswer(ctx, 'Provider enabled.');
    await showShortenerDetail(ctx, id, true);
  });

  bot.action(/^cc:short_dis:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const p = await getShortenerProviderById(pool, id, ownerId);
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    await setShortenerEnabled(pool, id, false, ownerId);
    await safeAnswer(ctx, 'Provider disabled.');
    await showShortenerDetail(ctx, id, true);
  });

  bot.action(/^cc:short_name:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_name', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🏷 Edit Name · #${p.id}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.name}\n\n✏️ Send the new name (1–80 characters):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_url:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_url', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🌐 Edit Base URL · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.base_url}\n\n✏️ Send the new HTTPS Base URL (e.g. https://shrinkme.io):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_ep:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_ep', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔌 Edit API Endpoint · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.api_endpoint}\n\n✏️ Send the new HTTPS API Endpoint (e.g. https://shrinkme.io/api):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_key:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_key', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔑 Update API Key · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n✏️ Send the new API key:\n🔒 Your message will be deleted immediately for security.`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_dur:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `⏱ Checkpoint Duration · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.checkpoint_minutes} min\n\n👇 Select a preset duration or enter custom minutes:`,
      {
        inline_keyboard: [
          [
            { text: '15 min', callback_data: `cc:short_durs:${id}:15` },
            { text: '1 hour', callback_data: `cc:short_durs:${id}:60` },
            { text: '6 hours', callback_data: `cc:short_durs:${id}:360` },
          ],
          [
            { text: '12 hours', callback_data: `cc:short_durs:${id}:720` },
            { text: '24 hours', callback_data: `cc:short_durs:${id}:1440` },
          ],
          [
            { text: '✏ Custom Minutes', callback_data: `cc:short_durc:${id}` },
            { text: '← Back', callback_data: `cc:short_edit:${id}` },
          ],
        ],
      },
      true,
    );
  });

  bot.action(/^cc:short_durs:(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const minutes = Number(ctx.match[2]);
    const updated = await setShortenerDuration(pool, id, minutes, getOwnerScope(ctx));
    if (!updated) return safeAnswer(ctx, 'Provider not found.', true);
    await safeAnswer(ctx, `✅ Duration set to ${minutes}m.`);
    await showShortenerEdit(ctx, id, true);
  });

  bot.action(/^cc:short_durc:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_dur', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `⏱ Checkpoint Duration · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.checkpoint_minutes} min\n\n✏️ Send new duration in minutes (1–10080):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_prio:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔢 Shortener Priority · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.priority} (lower number runs first)\n\n👇 Select a priority preset or enter a custom number:`,
      {
        inline_keyboard: [
          [
            { text: '1 (First)', callback_data: `cc:short_prios:${id}:1` },
            { text: '10 (High)', callback_data: `cc:short_prios:${id}:10` },
            { text: '50', callback_data: `cc:short_prios:${id}:50` },
            { text: '100', callback_data: `cc:short_prios:${id}:100` },
          ],
          [
            { text: '✏ Custom Priority', callback_data: `cc:short_prioc:${id}` },
            { text: '← Back', callback_data: `cc:short_edit:${id}` },
          ],
        ],
      },
      true,
    );
  });

  bot.action(/^cc:short_prios:(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const priority = Number(ctx.match[2]);
    const updated = await setShortenerPriority(pool, id, priority, getOwnerScope(ctx));
    if (!updated) return safeAnswer(ctx, 'Provider not found.', true);
    await safeAnswer(ctx, `✅ Priority set to ${priority}.`);
    await showShortenerEdit(ctx, id, true);
  });

  bot.action(/^cc:short_prioc:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_prio', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔢 Shortener Priority · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.priority} (lower runs first)\n\n✏️ Send new priority (1–100000):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_rm_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const res = await removeShortenerProvider(pool, id, getOwnerScope(ctx));
    if (res.removed) await safeAnswer(ctx, 'Provider removed.');
    else if (res.disabled) await safeAnswer(ctx, 'Provider has session history; disabled instead.', true);
    else await safeAnswer(ctx, 'Cannot remove provider with active pending sessions.', true);
    await showShorteners(ctx, true);
  });

  // Premium plan actions
  bot.action(/^cc:plan:(\d+)$/, async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPlanDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:plan_rm:(\d+)$/, async (ctx) => { if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx); await safeAnswer(ctx); await showPlanDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:plan_(en|dis):(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const enabled = ctx.match[1] === 'en';
    const id = Number(ctx.match[2]);
    await pool.query('UPDATE premium_plans SET is_enabled = $2, updated_at = NOW() WHERE id = $1', [id, enabled]);
    await safeAnswer(ctx, enabled ? 'Plan enabled.' : 'Plan disabled.');
    await showPlanDetail(ctx, id, true);
  });

  bot.action(/^cc:plan_rm_ok:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    await pool.query('DELETE FROM premium_plans WHERE id = $1', [id]);
    await safeAnswer(ctx, 'Plan deleted.');
    await showPlans(ctx, true);
  });

  // Payment method actions
  bot.action(/^cc:plan_stars:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const planId = Number(ctx.match[1]);
    const res = await pool.query('SELECT id, name FROM premium_plans WHERE id = $1 LIMIT 1', [planId]);
    if (!res.rowCount) return safeAnswer(ctx, 'Plan not found.', true);
    const plan = res.rows[0];
    setPrompt(ctx.from.id, 'plan_stars_single', { back: `cc:plan:${planId}`, meta: { planId } });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      `⭐ Set Telegram Stars Price\n━━━━━━━━━━━━━━━━━━\n💎 Plan #${plan.id}: ${plan.name}\n\n✏️ Send the integer Stars price (e.g. 50), or 0 to remove:`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  // Creator-scoped Premium plan actions
  bot.action(/^cc:cplan:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showCreatorPlanDetail(ctx, Number(ctx.match[1]), true, false);
  });

  bot.action(/^cc:cplan_rm:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showCreatorPlanDetail(ctx, Number(ctx.match[1]), true, true);
  });

  bot.action(/^cc:cplan_(en|dis):(\d+)$/, async (ctx) => {
    const enabled = ctx.match[1] === 'en';
    const id = Number(ctx.match[2]);
    const ownerScope = getOwnerScope(ctx);
    const updated = await setPremiumPlanEnabled(pool, id, enabled, ownerScope);
    if (!updated) return safeAnswer(ctx, 'Plan not found.', true);
    await safeAnswer(ctx, enabled ? 'Plan enabled.' : 'Plan disabled.');
    await showCreatorPlanDetail(ctx, id, true, false);
  });

  bot.action(/^cc:cplan_rm_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerScope = getOwnerScope(ctx);
    const deleted = await removePremiumPlan(pool, id, ownerScope);
    if (!deleted) return safeAnswer(ctx, 'Plan not found.', true);
    await safeAnswer(ctx, 'Plan deleted.');
    await showCreatorPlans(ctx, true);
  });

  bot.action(/^cc:cplan_stars:(\d+)$/, async (ctx) => {
    const planId = Number(ctx.match[1]);
    const ownerScope = getOwnerScope(ctx);
    const plan = await getPremiumPlanById(pool, planId, ownerScope);
    if (!plan) return safeAnswer(ctx, 'Plan not found.', true);
    setPrompt(ctx.from.id, 'cplan_stars_single', { back: `cc:cplan:${planId}`, meta: { planId } });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      `⭐ Set Telegram Stars Price\n━━━━━━━━━━━━━━━━━━\n👑 Plan #${plan.id}: ${plan.name}\n\n✏️ Send the integer Stars price (e.g. 50), or 0 to remove:`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action('cc:pay_en_stars', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      await enableTelegramStars(pool, ctx.from.id);
      await safeAnswer(ctx, 'Telegram Stars checkout enabled!', true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showPaymentMethods(ctx, true);
  });

  bot.action('cc:stars_en', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      await enableTelegramStars(pool, ctx.from.id);
      await safeAnswer(ctx, 'Telegram Stars checkout enabled!', true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showStarsConfig(ctx, true);
  });

  bot.action('cc:stars_dis', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await disablePaymentMethod(pool, 'telegram_stars', ctx.from.id);
    await safeAnswer(ctx, 'Telegram Stars disabled.');
    await showStarsConfig(ctx, true);
  });

  bot.action('cc:stars_test', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      const res = await testTelegramStars(ctx.telegram, pool);
      await safeAnswer(ctx, `Stars OK (@${res.botUsername ?? 'bot'}) · ${res.counts.total} price(s) set`, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showStarsConfig(ctx, true);
  });

  bot.action('cc:pay_en_fampay', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      await enableFamPay(pool, config, ctx.from.id);
      await safeAnswer(ctx, 'FamPay UPI checkout enabled!', true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showFamPayConfig(ctx, true);
  });

  bot.action('cc:fampay_dis', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await disablePaymentMethod(pool, 'fampay', ctx.from.id);
    await safeAnswer(ctx, 'FamPay disabled.');
    await showFamPayConfig(ctx, true);
  });

  bot.action('cc:fampay_test', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    try {
      const res = await testFamPayImapConnection(pool, config);
      await safeAnswer(ctx, `IMAP OK (${maskEmail(res.gmailEmail)}) · INBOX: ${res.inboxMessages}`, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
    await showFamPayConfig(ctx, true);
  });

  bot.action(/^cc:pay_test:(fampay|telegram_stars|stripe|crypto)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const method = ctx.match[1];
    try {
      if (method === 'fampay') {
        const res = await testFamPayImapConnection(pool, config);
        await safeAnswer(ctx, `FamPay IMAP OK · INBOX: ${res.inboxMessages}`, true);
      } else if (method === 'telegram_stars') {
        const res = await testTelegramStars(ctx.telegram, pool);
        await safeAnswer(ctx, `Telegram Stars OK · ${res.counts.total} price(s) set`, true);
      } else {
        throw new Error(`${method} gateway adapter is not connected yet.`);
      }
    } catch (error) {
      await markPaymentMethodTest(pool, method, 'failed', error.message).catch(() => {});
      await safeAnswer(ctx, error.message, true);
    }
    await showPaymentMethods(ctx, true);
  });

  bot.action(/^cc:pay_dis:(fampay|telegram_stars|stripe|crypto)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const method = ctx.match[1];
    await disablePaymentMethod(pool, method, ctx.from.id);
    await safeAnswer(ctx, `${method} disabled.`);
    await showPaymentMethods(ctx, true);
  });

  // Paid file link & batch actions
  bot.action(/^cc:paid_view:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showPaidLinkDetail(ctx, Number(ctx.match[1]), true, false);
  });

  bot.action(/^cc:paid_del:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showPaidLinkDetail(ctx, Number(ctx.match[1]), true, true);
  });

  bot.action(/^cc:paid_del_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    try {
      const deleted = await deletePaidFileLink(pool, id, getOwnerScope(ctx));
      await safeAnswer(ctx, deleted ? `Deleted paid link ${deleted.public_code}.` : 'Paid link not found.');
    } catch (error) {
      await safeAnswer(ctx, 'Delete failed: ' + error.message, true);
    }
    await showPaidLinks(ctx, true);
  });

  bot.action(/^cc:paid_tog:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const row = await getPaidFileLinkByIdOrCode(pool, id, ownerId);
    if (!row) return safeAnswer(ctx, 'Paid link not found.', true);
    await setPaidFileLinkEnabled(pool, id, !row.is_enabled, ownerId);
    await safeAnswer(ctx, !row.is_enabled ? 'Paid link enabled.' : 'Paid link disabled.');
    await showPaidLinkDetail(ctx, id, true, false);
  });

  bot.action(/^cc:paid_dis:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const row = await getPaidFileLinkByIdOrCode(pool, id, ownerId);
    if (!row) return safeAnswer(ctx, 'Paid link not found.', true);
    await disablePaidFileLink(pool, row.public_code, ctx.from.id, ownerId);
    await safeAnswer(ctx, 'Paid link disabled.');
    await showPaidLinks(ctx, true);
  });

  bot.action(/^cc:paid_ok:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const purchaseId = Number(ctx.match[1]);
    const res = await pool.query(
      `SELECT p.user_telegram_id, l.public_code
       FROM paid_file_purchases p JOIN paid_file_links l ON l.id = p.paid_link_id
       WHERE p.id = $1 LIMIT 1`,
      [purchaseId],
    );
    const row = res.rows[0];
    if (!row) return safeAnswer(ctx, 'Purchase record not found.', true);
    const result = await confirmPaidFilePurchase(pool, row.public_code, String(row.user_telegram_id), ctx.from.id);
    if (!result.alreadyConfirmed) {
      const link = await getPaidFileLink(pool, row.public_code);
      try {
        await ctx.telegram.sendMessage(
          row.user_telegram_id,
          `🎉 Payment Verified!\n━━━━━━━━━━━━━━━━━━\n🔓 Paid access is now unlocked for:\n📄 ${link?.file_name ?? 'your file'}\n\n👇 Request delivery anytime:\n/get ${link?.file_code ?? ''}`,
        );
      } catch {}
    }
    await safeAnswer(ctx, result.alreadyConfirmed ? 'Already confirmed.' : 'Purchase confirmed & unlocked!', true);
    await showPaidRequests(ctx, true);
  });

  bot.action(/^cc:batch_view:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showBatchLinkDetail(ctx, Number(ctx.match[1]), true, false);
  });

  bot.action(/^cc:batch_del:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showBatchLinkDetail(ctx, Number(ctx.match[1]), true, true);
  });

  bot.action(/^cc:batch_del_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    try {
      const deleted = await deletePaidBatchLink(pool, id, getOwnerScope(ctx));
      await safeAnswer(ctx, deleted ? `Deleted batch link ${deleted.public_code}.` : 'Batch link not found.');
    } catch (error) {
      await safeAnswer(ctx, 'Delete failed: ' + error.message, true);
    }
    await showBatchLinks(ctx, true);
  });

  bot.action(/^cc:batch_tog:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const row = await getPaidBatchByIdOrCode(pool, id, ownerId);
    if (!row) return safeAnswer(ctx, 'Batch link not found.', true);
    await setPaidBatchLinkEnabled(pool, id, !row.is_enabled, ownerId);
    await safeAnswer(ctx, !row.is_enabled ? 'Batch link enabled.' : 'Batch link disabled.');
    await showBatchLinkDetail(ctx, id, true, false);
  });

  bot.action(/^cc:batch_dis:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const row = await getPaidBatchByIdOrCode(pool, id, ownerId);
    if (!row) return safeAnswer(ctx, 'Batch link not found.', true);
    await disablePaidBatchLink(pool, row.public_code, ownerId);
    await safeAnswer(ctx, 'Batch link disabled.');
    await showBatchLinks(ctx, true);
  });

  bot.action(/^cc:batch_ok:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const purchaseId = Number(ctx.match[1]);
    const res = await pool.query(
      `SELECT p.user_telegram_id, b.public_code
       FROM paid_batch_purchases p JOIN paid_batch_links b ON b.id = p.batch_link_id
       WHERE p.id = $1 LIMIT 1`,
      [purchaseId],
    );
    const row = res.rows[0];
    if (!row) return safeAnswer(ctx, 'Batch purchase not found.', true);
    const result = await confirmPaidBatchPurchase(pool, row.public_code, String(row.user_telegram_id), ctx.from.id);
    if (!result.alreadyConfirmed) {
      const batch = await getPaidBatch(pool, row.public_code);
      try {
        await ctx.telegram.sendMessage(
          row.user_telegram_id,
          `🎉 Batch Payment Verified!\n━━━━━━━━━━━━━━━━━━\n📦 Collection: ${batch?.title ?? 'your collection'}\n🔓 All files in this batch are unlocked!\n\n👇 Queue delivery anytime:\n/batch_get ${row.public_code}`,
        );
      } catch {}
    }
    await safeAnswer(ctx, result.alreadyConfirmed ? 'Already confirmed.' : 'Batch confirmed & unlocked!', true);
    await showBatchRequests(ctx, true);
  });

  // Auto-delete presets
  bot.action(/^cc:autodel_set:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const minutes = Number(ctx.match[1]);
    if (minutes > 10080) return safeAnswer(ctx, 'Max 10080 minutes.', true);
    await setAutoDeleteMinutes(pool, minutes, ctx.from.id);
    await safeAnswer(ctx, minutes ? `Auto-delete set to ${minutes}m.` : 'Auto-delete turned OFF.');
    await showAutoDelete(ctx, true);
  });

  // Prompt starters & cancel
  bot.action(/^cc:prompt:([a-z_]+)$/, async (ctx) => {
    const action = ctx.match[1];
    if (OWNER_ONLY_PROMPTS.has(action) && !isOwnerAdmin(ctx)) {
      return denyAdminOnly(ctx);
    }
    try {
      const cfg = setPrompt(ctx.from.id, action);
      await safeAnswer(ctx);
      await renderView(
        ctx,
        `✏️ Interactive Input\n━━━━━━━━━━━━━━━━━━\n${cfg.prompt}`,
        { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
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
          return ctx.reply(
            `🤖 Delivery Bot Connected!\n━━━━━━━━━━━━━━━━━━\n🆔 Record #${record.id}\n🤖 Bot: @${record.username}\n🏷 Role: ${record.role}\n⚡ Runtime: ${record.runtime_status}`,
            { reply_markup: backKeyboard },
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
        default:
          return next();
      }
    } catch (error) {
      return ctx.reply('❌ Action failed: ' + error.message, { reply_markup: backKeyboard });
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
