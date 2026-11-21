import { isAdmin } from './admin-guard.js';
import { escapeHtml, renderView, safeAnswer } from './telegram-utils.js';

const ADMIN_PROMPT_TTL_MS = 5 * 60 * 1000;

export const OWNER_COMMAND_CATEGORIES = [
  {
    id: 'system',
    title: '📊 System, Dashboard & Health',
    shortLabel: '📊 System',
    summary: 'Inspect live bot status, KPI metrics, and operational health checks.',
    commands: [
      { name: 'status', usage: '/admin status', desc: 'Live bot, DB, user, file & revenue summary' },
      { name: 'dashboard', usage: '/admin dashboard', desc: 'Full platform KPI dashboard' },
      { name: 'stats', usage: '/admin stats', desc: 'Alias for /admin dashboard' },
      { name: 'health', usage: '/admin health', desc: 'Operational health & warning alerts' },
    ],
  },
  {
    id: 'delivery',
    title: '📦 Delivery Queue & Auto-Delete',
    shortLabel: '📦 Delivery',
    summary: 'Monitor delivery jobs, retry failed tasks, and configure global auto-delete timers.',
    commands: [
      { name: 'delivery_jobs', usage: '/admin delivery_jobs', desc: 'List latest 10 delivery jobs' },
      { name: 'delivery_retry', usage: '/admin delivery_retry <job_id>', desc: 'Requeue a failed delivery job' },
      { name: 'auto_delete', usage: '/admin auto_delete [minutes]', desc: 'View or set global auto-delete delay (1–10080m)' },
      { name: 'auto_delete_off', usage: '/admin auto_delete_off', desc: 'Disable global auto-delete' },
      { name: 'auto_delete_failed', usage: '/admin auto_delete_failed', desc: 'Inspect failed auto-delete tasks' },
    ],
  },
  {
    id: 'premium',
    title: '💎 Platform Premium Plans & Grants',
    shortLabel: '💎 Premium',
    summary: 'Manage platform-wide Premium plans and manually grant, inspect, or revoke user memberships.',
    commands: [
      { name: 'plans', usage: '/admin plans', desc: 'List platform Premium plans' },
      { name: 'plan_add', usage: '/admin plan_add name|price|currency|days', desc: 'Create or update a platform plan' },
      { name: 'plan_edit', usage: '/admin plan_edit id|name|price|currency|days|true|false', desc: 'Edit an existing platform plan' },
      { name: 'plan_remove', usage: '/admin plan_remove <plan_id>', desc: 'Delete a platform plan' },
      { name: 'premium_grant', usage: '/admin premium_grant <user_id> <plan_id> [days]', desc: 'Manually grant Premium to a user' },
      { name: 'premium_revoke', usage: '/admin premium_revoke <user_id>', desc: 'Revoke active Premium for a user' },
      { name: 'premium_status', usage: '/admin premium_status <user_id>', desc: 'Inspect user Premium memberships' },
    ],
  },
  {
    id: 'payments',
    title: '💳 Payment Gateways & Reconciliation',
    shortLabel: '💳 Payments',
    summary: 'Inspect revenue analytics, search/reconcile transactions, and configure FamPay & Stars gateways.',
    commands: [
      { name: 'payments', usage: '/admin payments', desc: 'Payment reconciliation overview' },
      { name: 'payment_analytics', usage: '/admin payment_analytics', desc: '30-day revenue & method analytics' },
      { name: 'payment_recent', usage: '/admin payment_recent', desc: 'Recent payment transactions' },
      { name: 'payment_search', usage: '/admin payment_search <term>', desc: 'Search payments by ID, user, UTR or ref' },
      { name: 'payment_detail', usage: '/admin payment_detail <tx_id>', desc: 'Inspect a single payment transaction' },
      { name: 'payment_reconcile', usage: '/admin payment_reconcile <tx_id>', desc: 'Reconcile/fulfill a verified transaction' },
      { name: 'payment_apply', usage: '/admin payment_apply <tx_id>', desc: 'Apply/fulfill a verified transaction' },
      { name: 'payment_transactions', usage: '/admin payment_transactions', desc: 'List raw payment transactions' },
      { name: 'payment_sessions_expired', usage: '/admin payment_sessions_expired', desc: 'List expired checkout sessions' },
      { name: 'payment_recovery_pending', usage: '/admin payment_recovery_pending', desc: 'List failed fulfillment recovery queue' },
      { name: 'payment_methods', usage: '/admin payment_methods', desc: 'List payment gateway statuses' },
      { name: 'fampay_set', usage: '/admin fampay_set gmail|app_pass|upi|[merchant]', desc: 'Configure FamPay UPI & Gmail IMAP' },
      { name: 'stars_set', usage: '/admin stars_set <premium|paid_file|paid_batch> <id> <stars>', desc: 'Set Telegram Stars price' },
      { name: 'payment_set', usage: '/admin payment_set method|secret|public_json', desc: 'Low-level gateway config update' },
      { name: 'payment_test', usage: '/admin payment_test <method>', desc: 'Test payment gateway connectivity' },
      { name: 'payment_enable', usage: '/admin payment_enable <method>', desc: 'Enable a payment gateway' },
      { name: 'payment_disable', usage: '/admin payment_disable <method>', desc: 'Disable a payment gateway' },
    ],
  },
  {
    id: 'confirmations',
    title: '🏷 Manual Paid Requests & Creator Payouts',
    shortLabel: '🏷 Payouts',
    summary: 'Confirm manual paid link/batch requests and process creator UPI withdrawal payouts.',
    commands: [
      { name: 'paid_requests', usage: '/admin paid_requests', desc: 'List pending paid file requests' },
      { name: 'paid_confirm', usage: '/admin paid_confirm <code> <user_id>', desc: 'Manually confirm a paid file purchase' },
      { name: 'batch_requests', usage: '/admin batch_requests', desc: 'List pending paid batch requests' },
      { name: 'batch_confirm', usage: '/admin batch_confirm <code> <user_id>', desc: 'Manually confirm a paid batch purchase' },
      { name: 'withdrawals', usage: '/admin withdrawals', desc: 'Open creator UPI withdrawal payout queue' },
      { name: 'withdraw_approve', usage: '/admin withdraw_approve <id> [utr]', desc: 'Mark withdrawal paid with optional UTR' },
      { name: 'withdraw_reject', usage: '/admin withdraw_reject <id> [reason]', desc: 'Reject withdrawal & refund creator wallet' },
    ],
  },
];

export const ADMIN_INTERACTIVE_PROMPTS = {
  delivery_retry: {
    category: 'delivery',
    title: '↻ Retry Failed Delivery Job',
    prompt: 'Send the numeric <b>Job ID</b> to requeue:\n\n📌 Example: <code>42</code>',
  },
  auto_delete: {
    category: 'delivery',
    title: '⏱ Set Global Auto-Delete Delay',
    prompt: 'Send the auto-delete delay in <b>minutes</b> (<code>1</code>–<code>10080</code>):\n\n📌 Example: <code>30</code>',
  },
  plan_add: {
    category: 'premium',
    title: '➕ Add Platform Premium Plan',
    prompt: 'Send plan details separated by pipes:\n<code>name|price|currency|duration_days</code>\n\n📌 Example: <code>Monthly|99|INR|30</code>',
  },
  plan_edit: {
    category: 'premium',
    title: '✏ Edit Platform Premium Plan',
    prompt: 'Send updated plan details separated by pipes:\n<code>id|name|price|currency|duration_days|enabled</code>\n\n📌 Example: <code>1|Monthly VIP|149|INR|30|true</code>',
  },
  plan_remove: {
    category: 'premium',
    title: '🗑 Remove Platform Premium Plan',
    prompt: 'Send the numeric <b>Plan ID</b> to delete:\n\n📌 Example: <code>1</code>',
  },
  premium_grant: {
    category: 'premium',
    title: '🎁 Grant Premium Membership',
    prompt: 'Send <code>user_id plan_id [override_days]</code>:\n\n📌 Example: <code>123456789 1 30</code>',
  },
  premium_revoke: {
    category: 'premium',
    title: '🚫 Revoke Premium Membership',
    prompt: 'Send the numeric <b>Telegram User ID</b> to revoke active Premium:\n\n📌 Example: <code>123456789</code>',
  },
  premium_status: {
    category: 'premium',
    title: '🔍 Inspect User Premium Status',
    prompt: 'Send the numeric <b>Telegram User ID</b> to inspect:\n\n📌 Example: <code>123456789</code>',
  },
  payment_search: {
    category: 'payments',
    title: '🔎 Search Payment Transactions',
    prompt: 'Send a <b>Transaction ID</b>, <b>Telegram User ID</b>, <b>UTR</b>, or <b>external reference</b>:\n\n📌 Example: <code>123456789</code>',
  },
  payment_detail: {
    category: 'payments',
    title: '📄 Payment Transaction Detail',
    prompt: 'Send the numeric <b>Transaction ID</b> to inspect:\n\n📌 Example: <code>23</code>',
  },
  payment_reconcile: {
    category: 'payments',
    title: '↻ Reconcile Verified Payment',
    prompt: 'Send the numeric <b>Verified Transaction ID</b> to reconcile:\n\n📌 Example: <code>23</code>',
  },
  payment_apply: {
    category: 'payments',
    title: '✅ Apply Verified Payment',
    prompt: 'Send the numeric <b>Verified Transaction ID</b> to fulfill:\n\n📌 Example: <code>23</code>',
  },
  fampay_set: {
    category: 'gateways',
    title: '💳 Configure FamPay UPI & Gmail IMAP',
    sensitive: true,
    prompt: 'Send credentials separated by pipes:\n<code>gmail_email|gmail_app_password|upi_id|merchant_name(optional)</code>\n\n📌 Example:\n<code>you@gmail.com|abcd efgh ijkl mnop|you@fam|FileStore</code>\n\n🔒 <i>Your message will be deleted immediately for security.</i>',
  },
  stars_set: {
    category: 'gateways',
    title: '⭐ Set Telegram Stars Price',
    prompt: 'Send <code>&lt;premium|paid_file|paid_batch&gt; &lt;id_or_code&gt; &lt;stars&gt;</code>:\n\n📌 Examples:\n<code>premium 1 50</code>\n<code>paid_file 1 25</code>\n<code>paid_batch PACKCODE 100</code>\n<i>Use 0 to remove a Stars price.</i>',
  },
  payment_set: {
    category: 'gateways',
    title: '🔧 Low-Level Gateway Config',
    sensitive: true,
    prompt: 'Send <code>method|secret|public_config_json</code>:\n\n📌 Example:\n<code>fampay|SECRET_KEY|{"upiId":"you@fam"}</code>\n\n🔒 <i>Your message will be deleted immediately for security.</i>',
  },
  paid_confirm: {
    category: 'confirmations',
    title: '✅ Confirm Manual Paid File Purchase',
    prompt: 'Send <code>&lt;link_code&gt; &lt;buyer_user_id&gt;</code>:\n\n📌 Example: <code>PABC123 123456789</code>',
  },
  batch_confirm: {
    category: 'confirmations',
    title: '✅ Confirm Manual Paid Batch Purchase',
    prompt: 'Send <code>&lt;batch_code&gt; &lt;buyer_user_id&gt;</code>:\n\n📌 Example: <code>BXYZ789 123456789</code>',
  },
  withdraw_approve: {
    category: 'confirmations',
    title: '✅ Approve Creator Withdrawal',
    prompt: 'Send <code>&lt;withdrawal_id&gt; [utr_reference]</code>:\n\n📌 Example: <code>5 UTR4192837465</code>',
  },
  withdraw_reject: {
    category: 'confirmations',
    title: '❌ Reject Creator Withdrawal',
    prompt: 'Send <code>&lt;withdrawal_id&gt; [reason]</code>:\n\n📌 Example: <code>5 Invalid UPI ID</code>',
  },
};

const COMMAND_CATEGORY_MAP = new Map();
for (const cat of OWNER_COMMAND_CATEGORIES) {
  for (const cmd of cat.commands) {
    COMMAND_CATEGORY_MAP.set(cmd.name, cat.id);
  }
}
for (const gatewayCmd of ['payment_methods', 'fampay_set', 'stars_set', 'payment_set', 'payment_test', 'payment_enable', 'payment_disable']) {
  COMMAND_CATEGORY_MAP.set(gatewayCmd, 'gateways');
}

export function isPlatformOwner(ctx, adminIds) {
  return Array.isArray(adminIds) && adminIds.length > 0 && isAdmin(ctx?.from?.id, adminIds);
}

export function formatAdminCommandsHelp(view = 'home') {
  if (view === 'home') {
    return [
      '🛡 <b>Owner Admin Commands (<code>/admin</code>)</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '<i>Tap any tool or category below to run owner actions interactively — no manual typing needed.</i>',
      '',
      '📊 <b>System, Dashboard &amp; Health</b> — 4 tools',
      '📦 <b>Delivery Queue &amp; Auto-Delete</b> — 5 tools',
      '💎 <b>Platform Premium Plans &amp; Grants</b> — 7 tools',
      '💳 <b>Payment Gateways &amp; Reconciliation</b> — 17 tools',
      '🏷 <b>Paid Requests &amp; Creator Payouts</b> — 7 tools',
      '',
      '⚡ <i>Tip: Slash shortcuts also work anytime (e.g. <code>/admin status</code>, <code>/admin withdrawals</code>).</i>',
      '🤖 <i>Delivery Bot diagnostics: run <code>/admin</code> on your Delivery Bot for interactive buttons.</i>',
    ].join('\n');
  }

  if (view === 'gateways') {
    return [
      '⚙️ <b>Payment Gateways &amp; Pricing (<code>/admin</code>)</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '<i>Test, enable, disable, or configure FamPay UPI &amp; Telegram Stars with one tap.</i>',
      '',
      '• <b>Gateway Status</b> — Check active adapters &amp; last test results',
      '• <b>Test / Enable / Disable</b> — Instant 1-tap controls for FamPay &amp; Stars',
      '• <b>FamPay &amp; Stars Panels</b> — Guided setup &amp; pricing management',
    ].join('\n');
  }

  if (view === 'all') {
    const lines = [
      '🛡 <b>Owner Admin Commands — Full Reference (<code>/admin</code>)</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '<i>Tap a category button below to run any command interactively.</i>',
      '',
    ];
    for (const cat of OWNER_COMMAND_CATEGORIES) {
      lines.push(`<b>${cat.title}</b>`);
      for (const cmd of cat.commands) {
        lines.push(`• <code>${escapeHtml(cmd.usage)}</code> — ${escapeHtml(cmd.desc)}`);
      }
      lines.push('');
    }
    lines.push('🤖 <i>Delivery Bot owner diagnostics: <code>/admin</code>, <code>/admin status</code>, <code>/admin test</code>.</i>');
    return lines.join('\n');
  }

  const cat = OWNER_COMMAND_CATEGORIES.find((c) => c.id === view);
  if (!cat) return formatAdminCommandsHelp('home');

  const lines = [
    `🛡 <b>${cat.title}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    '',
    `<i>${escapeHtml(cat.summary)}</i>`,
    '',
    '👇 <b>Tap an action button below to launch immediately:</b>',
  ];
  return lines.join('\n');
}

export function buildAdminHelpKeyboard(view = 'home') {
  if (view === 'system') {
    return {
      inline_keyboard: [
        [
          { text: '📡 Live Status', callback_data: 'cc:adm_run:status' },
          { text: '📊 KPI Dashboard', callback_data: 'cc:dash' },
        ],
        [
          { text: '📈 Stats Snapshot', callback_data: 'cc:adm_run:stats' },
          { text: '🩺 Health Check', callback_data: 'cc:health' },
        ],
        [
          { text: '← /admin Hub', callback_data: 'cc:admin_cmds:home' },
          { text: '🎛 Control Center', callback_data: 'cc:home' },
        ],
      ],
    };
  }

  if (view === 'delivery') {
    return {
      inline_keyboard: [
        [
          { text: '📦 Delivery Jobs', callback_data: 'cc:adm_run:delivery_jobs' },
          { text: '↻ Retry Job ID', callback_data: 'cc:adm_ask:delivery_retry' },
        ],
        [
          { text: '⏱ Auto-Delete Panel', callback_data: 'cc:autodel' },
          { text: '⏱ Set Delay (min)', callback_data: 'cc:adm_ask:auto_delete' },
        ],
        [
          { text: '⚪ Auto-Delete OFF', callback_data: 'cc:adm_run:auto_delete_off' },
          { text: '⚠️ Failed Deletes', callback_data: 'cc:adm_run:auto_delete_failed' },
        ],
        [
          { text: '← /admin Hub', callback_data: 'cc:admin_cmds:home' },
          { text: '🎛 Control Center', callback_data: 'cc:home' },
        ],
      ],
    };
  }

  if (view === 'premium') {
    return {
      inline_keyboard: [
        [
          { text: '💎 Plans Panel', callback_data: 'cc:plans' },
          { text: '📋 List Plans', callback_data: 'cc:adm_run:plans' },
        ],
        [
          { text: '➕ Add Plan', callback_data: 'cc:adm_ask:plan_add' },
          { text: '✏ Edit Plan', callback_data: 'cc:adm_ask:plan_edit' },
        ],
        [
          { text: '🗑 Remove Plan', callback_data: 'cc:adm_ask:plan_remove' },
          { text: '🎁 Grant Premium', callback_data: 'cc:adm_ask:premium_grant' },
        ],
        [
          { text: '🔍 User Status', callback_data: 'cc:adm_ask:premium_status' },
          { text: '🚫 Revoke Premium', callback_data: 'cc:adm_ask:premium_revoke' },
        ],
        [
          { text: '← /admin Hub', callback_data: 'cc:admin_cmds:home' },
          { text: '🎛 Control Center', callback_data: 'cc:home' },
        ],
      ],
    };
  }

  if (view === 'payments') {
    return {
      inline_keyboard: [
        [
          { text: '💳 Payments Hub', callback_data: 'cc:payments' },
          { text: '📊 Reconciliation', callback_data: 'cc:adm_run:payments' },
        ],
        [
          { text: '📈 30d Analytics', callback_data: 'cc:adm_run:payment_analytics' },
          { text: '🧾 Recent Tx', callback_data: 'cc:adm_run:payment_recent' },
        ],
        [
          { text: '🔎 Search Payment', callback_data: 'cc:adm_ask:payment_search' },
          { text: '📄 Tx Detail', callback_data: 'cc:adm_ask:payment_detail' },
        ],
        [
          { text: '↻ Reconcile Tx', callback_data: 'cc:adm_ask:payment_reconcile' },
          { text: '✅ Apply Tx', callback_data: 'cc:adm_ask:payment_apply' },
        ],
        [
          { text: '📜 Raw Transactions', callback_data: 'cc:adm_run:payment_transactions' },
          { text: '⏳ Expired Sessions', callback_data: 'cc:adm_run:payment_sessions_expired' },
        ],
        [
          { text: '⚠️ Recovery Queue', callback_data: 'cc:adm_run:payment_recovery_pending' },
          { text: '⚙️ Gateways & Pricing →', callback_data: 'cc:admin_cmds:gateways' },
        ],
        [
          { text: '← /admin Hub', callback_data: 'cc:admin_cmds:home' },
          { text: '🎛 Control Center', callback_data: 'cc:home' },
        ],
      ],
    };
  }

  if (view === 'gateways') {
    return {
      inline_keyboard: [
        [
          { text: '⚙️ Gateway Status', callback_data: 'cc:adm_run:payment_methods' },
          { text: '💳 FamPay Panel', callback_data: 'cc:fampay_cfg' },
        ],
        [
          { text: '⭐ Stars Panel', callback_data: 'cc:stars_cfg' },
          { text: '🔧 Custom Gateway', callback_data: 'cc:adm_ask:payment_set' },
        ],
        [
          { text: '🧪 Test FamPay', callback_data: 'cc:adm_run:payment_test:fampay' },
          { text: '🧪 Test Stars', callback_data: 'cc:adm_run:payment_test:telegram_stars' },
        ],
        [
          { text: '🟢 Enable FamPay', callback_data: 'cc:adm_run:payment_enable:fampay' },
          { text: '🟢 Enable Stars', callback_data: 'cc:adm_run:payment_enable:telegram_stars' },
        ],
        [
          { text: '⚪ Disable FamPay', callback_data: 'cc:adm_run:payment_disable:fampay' },
          { text: '⚪ Disable Stars', callback_data: 'cc:adm_run:payment_disable:telegram_stars' },
        ],
        [
          { text: '💳 Quick FamPay Set', callback_data: 'cc:adm_ask:fampay_set' },
          { text: '⭐ Quick Stars Set', callback_data: 'cc:adm_ask:stars_set' },
        ],
        [
          { text: '← Payments Reports', callback_data: 'cc:admin_cmds:payments' },
          { text: '← /admin Hub', callback_data: 'cc:admin_cmds:home' },
        ],
      ],
    };
  }

  if (view === 'confirmations') {
    return {
      inline_keyboard: [
        [
          { text: '💸 Withdrawal Queue', callback_data: 'cc:wdq:pending:0' },
          { text: '📋 Withdrawals Cmd', callback_data: 'cc:adm_run:withdrawals' },
        ],
        [
          { text: '✅ Approve Payout', callback_data: 'cc:adm_ask:withdraw_approve' },
          { text: '❌ Reject Payout', callback_data: 'cc:adm_ask:withdraw_reject' },
        ],
        [
          { text: '📥 Paid File Requests', callback_data: 'cc:adm_run:paid_requests' },
          { text: '✅ Confirm Paid File', callback_data: 'cc:adm_ask:paid_confirm' },
        ],
        [
          { text: '📥 Paid Batch Requests', callback_data: 'cc:adm_run:batch_requests' },
          { text: '✅ Confirm Paid Batch', callback_data: 'cc:adm_ask:batch_confirm' },
        ],
        [
          { text: '← /admin Hub', callback_data: 'cc:admin_cmds:home' },
          { text: '🎛 Control Center', callback_data: 'cc:home' },
        ],
      ],
    };
  }

  if (view === 'all') {
    return {
      inline_keyboard: [
        [
          { text: '📊 System', callback_data: 'cc:admin_cmds:system' },
          { text: '📦 Delivery', callback_data: 'cc:admin_cmds:delivery' },
          { text: '💎 Premium', callback_data: 'cc:admin_cmds:premium' },
        ],
        [
          { text: '💳 Payments', callback_data: 'cc:admin_cmds:payments' },
          { text: '⚙️ Gateways', callback_data: 'cc:admin_cmds:gateways' },
          { text: '🏷 Payouts', callback_data: 'cc:admin_cmds:confirmations' },
        ],
        [
          { text: '← Interactive Hub', callback_data: 'cc:admin_cmds:home' },
          { text: '🎛 Control Center', callback_data: 'cc:home' },
        ],
      ],
    };
  }

  // Default: 'home' interactive hub
  return {
    inline_keyboard: [
      [
        { text: '📡 Live Status', callback_data: 'cc:adm_run:status' },
        { text: '📊 Dashboard', callback_data: 'cc:dash' },
      ],
      [
        { text: '🩺 Health', callback_data: 'cc:health' },
        { text: '💸 Withdrawals', callback_data: 'cc:wdq:pending:0' },
      ],
      [
        { text: '📊 System (4)', callback_data: 'cc:admin_cmds:system' },
        { text: '📦 Delivery (5)', callback_data: 'cc:admin_cmds:delivery' },
      ],
      [
        { text: '💎 Premium (7)', callback_data: 'cc:admin_cmds:premium' },
        { text: '💳 Payments (17)', callback_data: 'cc:admin_cmds:payments' },
      ],
      [
        { text: '⚙️ Gateways & Pricing', callback_data: 'cc:admin_cmds:gateways' },
        { text: '🏷 Paid & Payouts (7)', callback_data: 'cc:admin_cmds:confirmations' },
      ],
      [
        { text: '📋 Full Command List', callback_data: 'cc:admin_cmds:all' },
        { text: '🎛 Control Center', callback_data: 'cc:home' },
      ],
    ],
  };
}

function composeHandlers(handlers) {
  return async (ctx) => {
    let idx = 0;
    const run = async () => {
      if (idx >= handlers.length) return;
      const fn = handlers[idx++];
      if (typeof fn === 'function') {
        await fn(ctx, run);
      }
    };
    await run();
  };
}

function appendNavRows(extra, navRows) {
  const base = extra ? { ...extra } : {};
  const existingRows = base.reply_markup?.inline_keyboard;
  if (Array.isArray(existingRows)) {
    const alreadyHasAdminHub = existingRows.some((row) =>
      Array.isArray(row) && row.some((btn) => String(btn?.callback_data ?? '').startsWith('cc:admin_cmds:')),
    );
    if (alreadyHasAdminHub) return base;
    return {
      ...base,
      reply_markup: {
        ...base.reply_markup,
        inline_keyboard: [...existingRows, ...navRows],
      },
    };
  }
  return {
    ...base,
    reply_markup: { inline_keyboard: navRows },
  };
}

export function createAdminCommandRouter(bot, config, logger, hooks = {}) {
  const subcommands = new Map();
  const pendingPrompts = new Map();
  const adminIds = config?.adminIds;

  function clearPrompt(userId) {
    if (userId !== undefined && userId !== null) {
      pendingPrompts.delete(String(userId));
    }
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

  function setPrompt(userId, sub, category) {
    pendingPrompts.set(String(userId), {
      sub,
      category,
      expiresAt: Date.now() + ADMIN_PROMPT_TTL_MS,
    });
  }

  async function executeSubcommand(ctx, sub, argText = '', navRows = null) {
    const handler = subcommands.get(sub);
    if (!handler) {
      return ctx.reply(
        `❓ Unknown admin command: <code>${escapeHtml(sub)}</code>\n\nUse <code>/admin help</code> to open the interactive Owner Admin Hub.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '🛡 /admin Hub', callback_data: 'cc:admin_cmds:home' },
              { text: '🎛 Control Center', callback_data: 'cc:home' },
            ]],
          },
        },
      );
    }

    const rewrittenText = `/${sub}${argText ? ' ' + argText : ''}`;
    const syntheticMessage = { ...(ctx.message ?? {}), text: rewrittenText };
    const extraDescriptors = {
      message: { value: syntheticMessage, enumerable: true, configurable: true },
      ...(ctx.update
        ? { update: { value: { ...ctx.update, message: syntheticMessage }, enumerable: true, configurable: true } }
        : {}),
    };
    if (navRows && navRows.length > 0) {
      extraDescriptors.reply = {
        value: (text, extra) => ctx.reply(text, appendNavRows(extra, navRows)),
        enumerable: true,
        configurable: true,
      };
    }

    const delegatedCtx = Object.create(ctx, extraDescriptors);
    try {
      return await handler(delegatedCtx);
    } catch (error) {
      logger?.error?.({ subcommand: sub, error: error.message }, 'Admin subcommand execution failed');
      return ctx.reply('❌ Admin command failed: ' + error.message, navRows ? { reply_markup: { inline_keyboard: navRows } } : undefined);
    }
  }

  const guardAction = (handler) => async (ctx, ...rest) => {
    if (!isPlatformOwner(ctx, adminIds)) {
      if (ctx.callbackQuery) {
        try { await ctx.answerCbQuery('🔒 Restricted to platform owner.', { show_alert: true }); } catch {}
      } else if (ctx.reply) {
        await ctx.reply('🔒 This command is restricted to the platform owner.');
      }
      return;
    }
    return handler(ctx, ...rest);
  };

  const adminBot = new Proxy(bot, {
    get(target, prop) {
      if (prop === 'command') {
        return (pattern, ...handlers) => {
          const names = Array.isArray(pattern) ? pattern : [pattern];
          const composed = composeHandlers(handlers);
          for (const name of names) {
            if (typeof name === 'string') {
              subcommands.set(name.toLowerCase(), composed);
            }
          }
          return adminBot;
        };
      }
      if (prop === 'action') {
        return (pattern, ...handlers) => {
          const wrapped = handlers.map((fn) => (typeof fn === 'function' ? guardAction(fn) : fn));
          return target.action(pattern, ...wrapped);
        };
      }
      return target[prop];
    },
  });

  // Interactive category & hub navigation
  bot.action(/^cc:admin_cmds(?::([a-z_]+))?$/, async (ctx) => {
    if (!isPlatformOwner(ctx, adminIds)) {
      return safeAnswer(ctx, '🔒 Restricted to platform owner.', true);
    }
    clearPrompt(ctx.from.id);
    await safeAnswer(ctx);
    const view = ctx.match?.[1] ?? 'home';
    return renderView(ctx, formatAdminCommandsHelp(view), buildAdminHelpKeyboard(view), true, true, { parse_mode: 'HTML' });
  });

  // One-tap execution of zero-arg or preset-arg owner commands
  bot.action(/^cc:adm_run:([a-z_]+)(?::([a-z0-9_]+))?$/, async (ctx) => {
    if (!isPlatformOwner(ctx, adminIds)) {
      return safeAnswer(ctx, '🔒 Restricted to platform owner.', true);
    }
    clearPrompt(ctx.from.id);
    hooks.clearOtherSessions?.(ctx.from.id);
    const sub = ctx.match[1].toLowerCase();
    const presetArg = ctx.match[2] ?? '';
    await safeAnswer(ctx, `⚡ Running /admin ${sub}...`);
    const cat = COMMAND_CATEGORY_MAP.get(sub) ?? 'home';
    const navRows = [[
      ...(cat !== 'home' ? [{ text: '← Back to Category', callback_data: `cc:admin_cmds:${cat}` }] : []),
      { text: '🛡 /admin Hub', callback_data: 'cc:admin_cmds:home' },
    ]];
    return executeSubcommand(ctx, sub, presetArg, navRows);
  });

  // Guided interactive prompt for argument-taking owner commands
  bot.action(/^cc:adm_ask:([a-z_]+)$/, async (ctx) => {
    if (!isPlatformOwner(ctx, adminIds)) {
      return safeAnswer(ctx, '🔒 Restricted to platform owner.', true);
    }
    const sub = ctx.match[1].toLowerCase();
    const cfg = ADMIN_INTERACTIVE_PROMPTS[sub];
    if (!cfg || !subcommands.has(sub)) {
      return safeAnswer(ctx, 'Unknown admin action.', true);
    }
    hooks.clearOtherSessions?.(ctx.from.id);
    setPrompt(ctx.from.id, sub, cfg.category);
    await safeAnswer(ctx);
    return renderView(
      ctx,
      [
        `✏ <b>${cfg.title}</b>`,
        '━━━━━━━━━━━━━━━━━━',
        '',
        cfg.prompt,
        '',
        '<i>Send your reply below, or tap Cancel to go back.</i>',
      ].join('\n'),
      {
        inline_keyboard: [[
          { text: '✖ Cancel', callback_data: `cc:adm_cancel:${cfg.category}` },
          { text: '🛡 /admin Hub', callback_data: 'cc:admin_cmds:home' },
        ]],
      },
      true,
      true,
      { parse_mode: 'HTML' },
    );
  });

  // Cancel active interactive admin prompt
  bot.action(/^cc:adm_cancel(?::([a-z_]+))?$/, async (ctx) => {
    if (!isPlatformOwner(ctx, adminIds)) {
      return safeAnswer(ctx, '🔒 Restricted to platform owner.', true);
    }
    clearPrompt(ctx.from.id);
    await safeAnswer(ctx, 'Cancelled.');
    const view = ctx.match?.[1] ?? 'home';
    return renderView(ctx, formatAdminCommandsHelp(view), buildAdminHelpKeyboard(view), true, true, { parse_mode: 'HTML' });
  });

  // Main /admin command entry point
  bot.command('admin', async (ctx) => {
    if (!isPlatformOwner(ctx, adminIds)) {
      return ctx.reply('🔒 This command is restricted to the platform owner.');
    }

    clearPrompt(ctx.from.id);
    const rawText = ctx.message?.text?.trim() ?? '';
    const afterAdmin = rawText.replace(/^\/admin(?:@\S+)?\s*/i, '').trim();
    if (!afterAdmin) {
      if (typeof hooks.onAdminHome === 'function') {
        return hooks.onAdminHome(ctx);
      }
      return ctx.reply(formatAdminCommandsHelp('home'), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildAdminHelpKeyboard('home'),
      });
    }

    const firstSpace = afterAdmin.search(/\s/);
    const rawSub = firstSpace === -1 ? afterAdmin : afterAdmin.slice(0, firstSpace);
    const argText = firstSpace === -1 ? '' : afterAdmin.slice(firstSpace).trim();
    const sub = rawSub.replace(/^\/+/, '').toLowerCase();

    if (sub === 'help' || sub === 'commands' || sub === 'list') {
      const view = argText ? argText.toLowerCase() : 'home';
      return ctx.reply(formatAdminCommandsHelp(view), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buildAdminHelpKeyboard(view),
      });
    }

    return executeSubcommand(ctx, sub, argText);
  });

  function registerPromptTextHandler() {
    bot.on('text', async (ctx, next) => {
      const text = ctx.message?.text?.trim() ?? '';
      if (!text || text.startsWith('/')) return next();
      if (!isPlatformOwner(ctx, adminIds)) return next();

      const active = getActivePrompt(ctx.from?.id);
      if (!active) return next();

      clearPrompt(ctx.from.id);
      const cfg = ADMIN_INTERACTIVE_PROMPTS[active.sub];
      if (cfg?.sensitive) {
        try { await ctx.deleteMessage(); } catch {}
      }

      const navRows = [
        [
          { text: '🔁 Run Again', callback_data: `cc:adm_ask:${active.sub}` },
          { text: '← Back to Category', callback_data: `cc:admin_cmds:${active.category}` },
        ],
        [{ text: '🛡 /admin Hub', callback_data: 'cc:admin_cmds:home' }],
      ];
      return executeSubcommand(ctx, active.sub, text, navRows);
    });
  }

  return {
    adminBot,
    subcommands,
    clearPrompt,
    getActivePrompt,
    registerPromptTextHandler,
    listSubcommands() {
      return [...subcommands.keys()].sort();
    },
  };
}
