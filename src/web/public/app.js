const state = {
  // Token is strictly kept in JS memory (never written to localStorage/sessionStorage)
  token: '',
  user: null,
  botUsername: null,
  theme: 'dark',
  mobileNavOpen: false,
  sidebarCollapsed: false,
  activeView: 'overview',
  loading: false,
  error: '',
  data: {
    overview: null,
    bots: null,
    links: null,
    files: null,
    shorteners: null,
    channels: null,
    plans: null,
    wallet: null,
    broadcasts: null,
    ownerDashboard: null,
    ownerWithdrawals: null,
    ownerPayments: null,
    ownerBots: null,
    ownerBotDetail: null,
    users: null,
    premiumMembers: null,
    ownerLinkAnalytics: null,
  },
  selectedBotId: null,
  filters: {
    linksTab: 'all',
    linksSearch: '',
    withdrawalsStatus: 'pending',
    paymentsStatus: 'all',
    paymentsSearch: '',
    usersSearch: '',
    usersBotId: '',
    usersBotName: '',
    botsSearch: '',
    botsScope: 'all',
    botsStatus: 'all',
    premiumSearch: '',
    premiumStatus: 'all',
    overviewDays: 7,
  },
  freshRotatedToken: null,
};

const appEl = document.getElementById('app');
const toastRoot = document.getElementById('toast-root');
const modalRoot = document.getElementById('modal-root');
let directorySearchTimer = null;
let slotPollTimer = null;

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHttpsUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
  } catch {}
  return '';
}

function safeUpiUrl(url) {
  const s = String(url || '').trim();
  if (/^upi:\/\/pay\?/i.test(s)) return s;
  return '';
}

function safeImagePreviewUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s;
  try {
    const parsed = new URL(s);
    if (parsed.protocol === 'https:') return parsed.toString();
  } catch {}
  return '';
}

function formatMoney(minor, currency = 'INR') {
  const value = Number(minor || 0);
  const code = String(currency || 'INR').toUpperCase();
  if (code === 'XTR') return `${value} XTR`;
  return `${(value / 100).toFixed(2)} ${code}`;
}

function formatInrHero(minor) {
  const val = Number(minor || 0) / 100;
  return `₹${val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRelativeTime(iso) {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

function formatRevenue(byCurrency = {}) {
  const entries = Object.entries(byCurrency || {}).filter(([, v]) => Number(v) > 0);
  if (!entries.length) return '0.00 INR';
  return entries.map(([c, v]) => formatMoney(v, c)).join(' · ');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = 'toast' + (isError ? ' error' : '');
  node.textContent = message;
  toastRoot.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, 3400);
}

function closeModal() {
  if (slotPollTimer) {
    clearInterval(slotPollTimer);
    slotPollTimer = null;
  }
  modalRoot.innerHTML = '';
}

function openModal({ title, bodyHtml, submitLabel = 'Save', onSubmit }) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-close="1">
      <div class="modal-box" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3>${esc(title)}</h3>
          <button type="button" class="btn btn-sm btn-ghost" data-modal-close="1">Close</button>
        </div>
        <form id="panel-modal-form">
          <div class="modal-body">${bodyHtml}</div>
          <div class="modal-footer">
            <button type="button" class="btn" data-modal-close="1">Cancel</button>
            <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  modalRoot.querySelectorAll('[data-modal-close]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target === el) closeModal();
    });
  });

  const form = document.getElementById('panel-modal-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const formData = new FormData(form);
      const shouldClose = await onSubmit(Object.fromEntries(formData.entries()));
      if (shouldClose !== false) closeModal();
    } catch (err) {
      toast(err.message || 'Action failed.', true);
      submitBtn.disabled = false;
    }
  });
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) {
      lockPanel('Your token was revoked or rotated. Enter your active token to reconnect.');
    }
    const err = new Error(payload.error || `Request failed (${res.status})`);
    if (payload.code) err.code = payload.code;
    throw err;
  }
  return payload;
}

function lockPanel(notice = '') {
  state.token = '';
  state.user = null;
  state.freshRotatedToken = null;
  state.selectedBotId = null;
  state.filters.usersBotId = '';
  state.filters.usersBotName = '';
  state.activeView = 'overview';
  state.error = notice;
  for (const key of Object.keys(state.data)) {
    state.data[key] = null;
  }
  closeModal();
  render();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.classList.toggle('dark', state.theme === 'dark');
  render();
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Copy failed — select text manually.', true);
  }
}

async function loadMeta() {
  try {
    const meta = await fetch('/api/panel/meta').then((r) => r.json());
    state.botUsername = meta.botUsername || null;
  } catch {}
}

async function loadViewData(view = state.activeView) {
  if (!state.token || !state.user) return;
  state.loading = true;
  state.error = '';
  render();
  try {
    if (view === 'overview') {
      state.data.overview = await api(`/api/panel/overview?days=${state.filters.overviewDays}`);
    } else if (view === 'setup') {
      state.data.bots = await api('/api/panel/bots');
    } else if (view === 'links') {
      const [linksData, filesData] = await Promise.all([
        api('/api/panel/links'),
        api('/api/panel/files').catch(() => ({ files: [], unusedCount: 0 })),
      ]);
      state.data.links = linksData;
      state.data.files = filesData;
    } else if (view === 'shorteners') {
      state.data.shorteners = await api('/api/panel/shorteners');
    } else if (view === 'channels') {
      state.data.channels = await api('/api/panel/channels');
    } else if (view === 'plans') {
      state.data.plans = await api('/api/panel/plans');
    } else if (view === 'wallet') {
      state.data.wallet = await api('/api/panel/wallet');
    } else if (view === 'broadcasts') {
      state.data.broadcasts = await api('/api/panel/broadcasts');
    } else if (view === 'users') {
      const params = new URLSearchParams({ q: state.filters.usersSearch.trim() });
      if (state.filters.usersBotId) params.set('botId', state.filters.usersBotId);
      state.data.users = await api(`/api/panel/users?${params.toString()}`);
    } else if (view === 'owner_bots') {
      if (state.selectedBotId) {
        state.data.ownerBotDetail = await api(`/api/panel/owner/bots/${state.selectedBotId}`);
      } else {
        const params = new URLSearchParams({
          q: state.filters.botsSearch.trim(),
          scope: state.filters.botsScope,
          status: state.filters.botsStatus,
        });
        state.data.ownerBots = await api(`/api/panel/owner/bots?${params.toString()}`);
      }
    } else if (view === 'premium_members') {
      const params = new URLSearchParams({ q: state.filters.premiumSearch.trim(), status: state.filters.premiumStatus });
      state.data.premiumMembers = await api(`/api/panel/premium-members?${params.toString()}`);
    } else if (view === 'owner_link_analytics') {
      state.data.ownerLinkAnalytics = await api('/api/panel/owner/link-analytics');
    } else if (view === 'owner_kpis' || view === 'owner_delivery') {
      state.data.ownerDashboard = await api('/api/panel/owner/dashboard');
    } else if (view === 'owner_withdrawals') {
      const status = encodeURIComponent(state.filters.withdrawalsStatus);
      state.data.ownerWithdrawals = await api(`/api/panel/owner/withdrawals?status=${status}`);
    } else if (view === 'owner_payments') {
      const params = new URLSearchParams();
      if (state.filters.paymentsSearch.trim()) {
        params.set('q', state.filters.paymentsSearch.trim());
      } else {
        params.set('status', state.filters.paymentsStatus);
      }
      const [payments, dash] = await Promise.all([
        api(`/api/panel/owner/payments?${params.toString()}`),
        api('/api/panel/owner/dashboard'),
      ]);
      state.data.ownerPayments = payments;
      state.data.ownerDashboard = dash;
    }
  } catch (err) {
    state.error = err.message || 'Failed to load data.';
  } finally {
    state.loading = false;
    render();
  }
}

function switchView(view) {
  state.activeView = view;
  if (view === 'owner_bots') {
    state.selectedBotId = null;
    state.data.ownerBotDetail = null;
  }
  state.mobileNavOpen = false;
  if (view !== 'token') {
    loadViewData(view);
  } else {
    render();
  }
}

const BRAND_LOGO_SVG = `
  <svg class="brand-logo-svg" viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <linearGradient id="fsDiscA" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#4bf5e2"/>
        <stop offset="100%" stop-color="#0ea5e9"/>
      </linearGradient>
    </defs>
    <ellipse cx="20" cy="11" rx="14" ry="5.2" fill="url(#fsDiscA)" opacity="0.96"/>
    <path d="M6 15.5c0 2.9 6.3 5.2 14 5.2s14-2.3 14-5.2v4.6c0 2.9-6.3 5.2-14 5.2s-14-2.3-14-5.2v-4.6z" fill="#1dd8c9" opacity="0.88"/>
    <path d="M6 24.5c0 2.9 6.3 5.2 14 5.2s14-2.3 14-5.2v4.6c0 2.9-6.3 5.2-14 5.2s-14-2.3-14-5.2v-4.6z" fill="#0ea5e9" opacity="0.82"/>
  </svg>
`;

const HERO_ARTWORK_SVG = `
  <svg viewBox="0 0 220 120" width="190" height="104" aria-hidden="true">
    <defs>
      <linearGradient id="folderGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="100%" stop-color="#14b8a6"/>
      </linearGradient>
      <linearGradient id="folderTab" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#60a5fa"/>
        <stop offset="100%" stop-color="#22d3ee"/>
      </linearGradient>
    </defs>
    <rect x="18" y="42" width="24" height="24" rx="6" fill="rgba(56,189,248,0.16)" stroke="rgba(56,189,248,0.35)" transform="rotate(-10 30 54)"/>
    <polygon points="27,49 35,54 27,59" fill="#38bdf8" transform="rotate(-10 30 54)"/>
    <rect x="164" y="16" width="32" height="26" rx="7" fill="rgba(56,189,248,0.18)" stroke="rgba(56,189,248,0.4)" transform="rotate(14 180 29)"/>
    <polygon points="176,24 186,29 176,34" fill="#67e8f9" transform="rotate(14 180 29)"/>
    <rect x="176" y="64" width="26" height="22" rx="6" fill="rgba(34,227,203,0.16)" stroke="rgba(34,227,203,0.35)" transform="rotate(-8 189 75)"/>
    <path d="M58 34c0-5 4-9 9-9h28c4 0 7 2 9 5l5 7h40c5 0 9 4 9 9v47c0 6-5 11-11 11H69c-6 0-11-5-11-11V34z" fill="url(#folderTab)" opacity="0.72"/>
    <rect x="52" y="42" width="102" height="64" rx="13" fill="url(#folderGrad)"/>
    <path d="M90 79h26a8 8 0 0 0 1-16 11 11 0 0 0-21-3 9 9 0 0 0-6 19z" fill="rgba(255,255,255,0.92)"/>
    <path d="M103 77V64m0 0-5 5m5-5 5 5" stroke="#0891b2" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>
`;

const NAV_ICONS = {
  overview: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>',
  setup: '<svg class="nav-icon" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 4h6M9 13h.01M15 13h.01M9 17h6"/></svg>',
  links: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  shorteners: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  channels: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  plans: '<svg class="nav-icon" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  wallet: '<svg class="nav-icon" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M16 12h2"/></svg>',
  broadcasts: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M3 11l18-5v12L3 13v-2z"/><path d="M11 15v4a2 2 0 0 1-4 0v-4"/></svg>',
  token: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
  owner_kpis: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
  owner_bots: '<svg class="nav-icon" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 4h6M9 13h.01M15 13h.01M9 17h6"/></svg>',
  owner_withdrawals: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  owner_payments: '<svg class="nav-icon" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
  users: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  premium_members: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg>',
  owner_link_analytics: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  owner_delivery: '<svg class="nav-icon" viewBox="0 0 24 24"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
};

const HEADER_ICONS = {
  dots: '<svg class="nav-icon" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/></svg>',
  sun: '<svg class="nav-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
  moon: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  refresh: '<svg class="nav-icon" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  logout: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
};

function getNavSections() {
  const ov = state.data.overview;
  const totalLinks = ov ? (ov.counts?.shareLinks || 0) + (ov.counts?.paidLinks || 0) : null;
  const totalChannels = ov ? (ov.counts?.storageChannels || 0) + (ov.counts?.forceSubChannels || 0) : null;

  const creatorItems = [
    { id: 'overview', label: 'Overview', count: null },
    { id: 'setup', label: 'Setup & Delivery Bots', count: ov ? ov.counts?.ownDeliveryBots : null },
    { id: 'channels', label: 'Channels', count: totalChannels },
    { id: 'shorteners', label: 'Shorteners', count: ov ? ov.counts?.totalShorteners : null },
    { id: 'plans', label: state.user?.isOwner ? 'Platform Plans' : 'My Premium Plans', count: ov ? ov.counts?.plans : null },
    { id: 'links', label: 'Share & Paid Links', count: totalLinks },
    { id: 'wallet', label: 'Wallet & Payouts', count: null },
    { id: 'broadcasts', label: 'Broadcasts', count: null },
    { id: 'users', label: state.user?.isOwner ? 'All Users' : 'My Bot Users', count: null },
    { id: 'premium_members', label: state.user?.isOwner ? 'Premium Members' : 'My Premium Members', count: null },
    { id: 'token', label: 'Access Token', count: null },
  ];

  const sections = [{ title: 'Workspace', items: creatorItems }];
  if (state.user?.isOwner) {
    sections.push({
      title: 'Platform Owner',
      items: [
        { id: 'owner_kpis', label: 'Platform KPIs', count: null },
        { id: 'owner_bots', label: 'All Delivery Bots', count: ov?.ownerSummary?.totalDeliveryBots ?? null },
        { id: 'owner_withdrawals', label: 'Withdrawals Queue', count: ov?.ownerSummary?.pendingWithdrawals ?? null },
        { id: 'owner_payments', label: 'Payments & Gateways', count: null },
        { id: 'owner_link_analytics', label: 'Link Analytics', count: null },
        { id: 'owner_delivery', label: 'Delivery & Auto-Delete', count: null },
      ],
    });
  }
  return sections;
}

function getBreadcrumb() {
  for (const sec of getNavSections()) {
    const found = sec.items.find((i) => i.id === state.activeView);
    if (found) return { section: sec.title, page: found.label };
  }
  return { section: 'Workspace', page: 'Overview' };
}

function renderSkeletonRows(count = 4) {
  return Array.from({ length: count })
    .map(() => `<div class="skeleton-row"><div class="skeleton-bar"></div><div class="skeleton-bar"></div><div class="skeleton-bar"></div></div>`)
    .join('');
}

function renderTokenGate() {
  const botHandle = state.botUsername ? `@${esc(state.botUsername)}` : 'the FileStore Main Bot';
  const botLink = state.botUsername ? safeHttpsUrl(`https://t.me/${state.botUsername}?start=token`) : '';

  appEl.innerHTML = `
    <div class="gate-shell">
      <header class="gate-header">
        <span class="brand-mark">${BRAND_LOGO_SVG}<span class="brand-stack"><span>Filestore-adv</span><span class="brand-sub">Control Panel</span></span></span>
        <div class="topbar-actions">
          <button type="button" class="icon-btn" id="btn-theme" aria-label="Toggle dark or light theme" title="${state.theme === 'dark' ? 'Switch to Light theme' : 'Switch to Dark theme'}">
            ${state.theme === 'dark' ? HEADER_ICONS.sun : HEADER_ICONS.moon}
          </button>
          ${botLink ? `<a class="btn btn-sm btn-primary" href="${esc(botLink)}" target="_blank" rel="noopener noreferrer">Open Telegram Bot</a>` : ''}
        </div>
      </header>
      <main class="gate-main">
        <div class="gate-grid">
          <section class="gate-intro">
            <h1>FileStore Control Panel</h1>
            <p class="gate-lead">Manage delivery bots, channels, links, shorteners, plans &amp; payouts.</p>
            <div class="step-list">
              <div class="step-item">
                <span class="step-num">01.</span>
                <div>
                  <div class="step-title">Send <span class="mono">/token</span> in ${botHandle}</div>
                </div>
              </div>
              <div class="step-item">
                <span class="step-num">02.</span>
                <div>
                  <div class="step-title">Paste your <span class="mono">fs_…</span> token to sign in</div>
                </div>
              </div>
              <div class="step-item">
                <span class="step-num">03.</span>
                <div>
                  <div class="step-title">Rotate or lock access anytime</div>
                </div>
              </div>
            </div>
          </section>

          <section class="gate-panel">
            <h2>Unlock Panel</h2>
            <p class="gate-panel-sub">Paste the <span class="mono">fs_…</span> token from ${botHandle}.</p>
            <form id="token-auth-form" class="gate-form">
              <div class="field">
                <label class="field-label" for="token-input">Access Token</label>
                <div class="input-row">
                  <input
                    id="token-input"
                    name="token"
                    type="password"
                    class="input mono"
                    placeholder="fs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    autocomplete="off"
                    spellcheck="false"
                    required
                  />
                  <button type="button" class="btn" id="btn-toggle-token-vis">Show</button>
                </div>
              </div>
              ${state.error ? `<div class="inline-error">${esc(state.error)}</div>` : ''}
              <button type="submit" class="btn btn-primary" id="btn-unlock">Unlock Panel</button>
            </form>
            <div class="gate-footnote">Kept in session memory only — reloading locks the panel.</div>
          </section>
        </div>
      </main>
    </div>
  `;

  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  const input = document.getElementById('token-input');
  const toggleBtn = document.getElementById('btn-toggle-token-vis');
  toggleBtn.addEventListener('click', () => {
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    toggleBtn.textContent = isHidden ? 'Hide' : 'Show';
  });

  document.getElementById('token-auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    const btn = document.getElementById('btn-unlock');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    state.error = '';
    try {
      const res = await fetch('/api/panel/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: raw }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Invalid token.');
      state.token = raw;
      state.user = payload.user;
      state.botUsername = payload.botUsername || state.botUsername;
      state.activeView = 'overview';
      await loadViewData('overview');
    } catch (err) {
      state.error = err.message || 'Token verification failed.';
      render();
    }
  });
}

function renderOverviewChart(overviewStats = {}) {
  const series = Array.isArray(overviewStats?.series) && overviewStats.series.length
    ? overviewStats.series
    : Array.from({ length: 7 }, (_, idx) => ({ label: `D${idx + 1}`, opens: 0, earningsMinor: 0 }));

  const values = series.map((pt) => Number(pt.opens || 0));
  const rawMax = Math.max(...values, 0);
  const yMax = Math.max(4, Math.ceil(rawMax / 4) * 4);
  const w = 520;
  const h = 190;
  const padL = 34;
  const padR = 14;
  const padT = 32;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const coords = values.map((val, i) => {
    const x = series.length === 1 ? padL + plotW / 2 : padL + (i / (series.length - 1)) * plotW;
    const y = padT + plotH - (val / yMax) * plotH;
    return { x, y, val, label: series[i].label || '' };
  });

  let linePath = '';
  for (let i = 0; i < coords.length; i += 1) {
    const cur = coords[i];
    if (i === 0) {
      linePath = `M ${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`;
    } else {
      const prev = coords[i - 1];
      const cx = ((prev.x + cur.x) / 2).toFixed(1);
      linePath += ` C ${cx} ${prev.y.toFixed(1)}, ${cx} ${cur.y.toFixed(1)}, ${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`;
    }
  }
  const last = coords[coords.length - 1];
  const first = coords[0];
  const areaPath = `${linePath} L ${last.x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${first.x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  let peak = coords[0];
  for (const pt of coords) {
    if (pt.val >= peak.val) peak = pt;
  }

  const labelStep = series.length > 10 ? Math.ceil(series.length / 6) : 1;
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const tipX = Math.max(42, Math.min(w - 42, peak.x));
  const tipY = Math.max(22, peak.y - 12);

  return `
    <div class="chart-wrap">
      <svg class="stats-chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Link opens over time">
        <defs>
          <linearGradient id="fsAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#22e3cb" stop-opacity="0.34"/>
            <stop offset="100%" stop-color="#22e3cb" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${yTicks.map((ratio) => {
          const yPos = padT + plotH - ratio * plotH;
          const tickVal = Math.round(ratio * yMax);
          return `
            <line x1="${padL}" y1="${yPos.toFixed(1)}" x2="${w - padR}" y2="${yPos.toFixed(1)}" stroke="currentColor" stroke-opacity="0.09" stroke-width="1"/>
            <text x="${padL - 8}" y="${(yPos + 3.5).toFixed(1)}" text-anchor="end" fill="currentColor" fill-opacity="0.48" font-size="10.5">${tickVal}</text>
          `;
        }).join('')}
        <path d="${areaPath}" fill="url(#fsAreaFill)"/>
        <path d="${linePath}" fill="none" stroke="#22e3cb" stroke-width="2.4" stroke-linecap="round"/>
        ${peak.val > 0 ? `
          <line x1="${peak.x.toFixed(1)}" y1="${peak.y.toFixed(1)}" x2="${peak.x.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}" stroke="#22e3cb" stroke-opacity="0.35" stroke-dasharray="3 3"/>
          <g transform="translate(${tipX.toFixed(1)}, ${(tipY - 14).toFixed(1)})">
            <rect x="-34" y="-12" width="68" height="24" rx="7" fill="#0d1b2f" stroke="rgba(34,227,203,0.45)"/>
            <text x="0" y="0" text-anchor="middle" fill="#f1f6ff" font-size="10" font-weight="700">${peak.val} opens</text>
            <text x="0" y="9" text-anchor="middle" fill="#7c93b2" font-size="8.5">${esc(peak.label)}</text>
          </g>
        ` : ''}
        ${coords.map((pt, idx) => (
          series.length <= 10 || idx === coords.length - 1 || pt === peak
            ? `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${pt === peak && pt.val > 0 ? '4.5' : '3.2'}" fill="#22e3cb" stroke="#0b1526" stroke-width="1.5"/>`
            : ''
        )).join('')}
        ${coords.map((pt, idx) => (
          idx % labelStep === 0 || idx === coords.length - 1
            ? `<text x="${pt.x.toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="currentColor" fill-opacity="0.52" font-size="10">${esc(pt.label)}</text>`
            : ''
        )).join('')}
      </svg>
    </div>
  `;
}

function renderOverview() {
  const d = state.data.overview;
  if (state.loading && !d) {
    return `<div class="surface"><div class="surface-body">${renderSkeletonRows(5)}</div></div>`;
  }
  if (!d) {
    return `<div class="surface"><div class="empty-state"><h3>Could not load overview</h3><p>${esc(state.error || 'Try refreshing the panel.')}</p><button class="btn btn-primary" data-refresh="1">Retry</button></div></div>`;
  }

  const totalLinks = (d.counts.shareLinks || 0) + (d.counts.paidLinks || 0);
  const displayName = state.user.firstName || state.user.username || `User ${state.user.userId}`;
  const availableMinor = Number(d.wallet.availableMinor || 0);
  const minWithdrawalMinor = Number(d.wallet.minWithdrawalMinor || 100);
  const canWithdraw = availableMinor >= minWithdrawalMinor && Boolean(d.wallet.upiId);
  const walletReadinessText = canWithdraw
    ? 'Ready to withdraw'
    : !d.wallet.upiId
      ? 'Set payout UPI ID to withdraw'
      : `Min ${formatInrHero(minWithdrawalMinor)} required`;

  const ovStats = d.overviewStats || { days: state.filters.overviewDays, totalOpens: 0, uniqueViewers: 0, series: [] };
  const recentActivity = Array.isArray(d.recentActivity) ? d.recentActivity : [];
  const allConfigured = d.counts.storageChannels > 0 && d.wallet.upiId;

  const ownerRow = d.ownerSummary
    ? `
      <div class="surface">
        <div class="surface-header">
          <div class="surface-title">Platform Summary</div>
          <div class="page-actions">
            <button type="button" class="btn btn-sm" data-nav="owner_bots">All Delivery Bots (${Number(d.ownerSummary.totalDeliveryBots ?? 0)})</button>
            <button type="button" class="btn btn-sm btn-primary" data-nav="owner_withdrawals">Withdrawals (${d.ownerSummary.pendingWithdrawals})</button>
          </div>
        </div>
        <div class="surface-body">
          <div class="kpi-grid" style="margin-bottom:0;">
            <div class="kpi-cell">
              <div class="kpi-label">Tracked Users</div>
              <div class="kpi-value num">${d.ownerSummary.trackedUsers}</div>
            </div>
            <div class="kpi-cell">
              <div class="kpi-label">Active Premium</div>
              <div class="kpi-value num">${d.ownerSummary.activePremium}</div>
            </div>
            <div class="kpi-cell">
              <div class="kpi-label">Applied Payments</div>
              <div class="kpi-value num">${d.ownerSummary.paymentsApplied}</div>
            </div>
            <div class="kpi-cell">
              <div class="kpi-label">Revenue</div>
              <div class="kpi-value num" style="font-size:16px;">${esc(formatRevenue(d.ownerSummary.revenueByCurrency))}</div>
            </div>
          </div>
        </div>
      </div>
    `
    : '';

  const activityMeta = (item) => {
    if (item.kind === 'earning') return { badge: 'icon-badge-ok', icon: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a4 4 0 0 0 0-8"/></svg>' };
    if (item.kind === 'withdrawal') return { badge: 'icon-badge-info', icon: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>' };
    if (item.kind === 'link') return { badge: 'icon-badge-teal', icon: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' };
    return { badge: 'icon-badge-ok', icon: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' };
  };

  return `
    <section class="hero-banner">
      <div class="hero-copy">
        <div class="hero-kicker">${d.isOwner ? 'Owner Workspace' : 'Creator Workspace'}</div>
        <h1>Hi, ${esc(displayName)}</h1>
        <p class="hero-sub">Bot: ${d.deliveryBotUsername ? '@' + esc(d.deliveryBotUsername) : 'Shared default'}</p>
      </div>
      <div class="hero-artwork">${HERO_ARTWORK_SVG}</div>
    </section>

    <section class="wallet-split">
      <div class="wallet-hero-card">
        <div class="wallet-hero-head">
          <div class="card-title-row">
            <span class="icon-badge icon-badge-teal">${NAV_ICONS.wallet}</span>
            <span>My Wallet</span>
          </div>
          <span class="currency-label">INR ₹</span>
        </div>
        <div class="wallet-hero-body">
          <div class="wallet-balance-block">
            <div class="wallet-balance-kicker">Available Balance</div>
            <div class="wallet-balance-amount num">${esc(formatInrHero(availableMinor))}</div>
            <div class="wallet-ready-row ${canWithdraw ? 'status-ok' : 'status-warn'}">
              <span>${canWithdraw ? '●' : '○'}</span>
              <span>${esc(walletReadinessText)}</span>
            </div>
          </div>
          <button type="button" class="btn btn-primary" data-nav="wallet">
            ${NAV_ICONS.wallet}
            <span>Withdraw →</span>
          </button>
        </div>
      </div>

      <div class="stat-quad">
        <div class="stat-tile">
          <span class="icon-badge icon-badge-ok">
            <svg class="ui-icon" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
          </span>
          <div class="stat-tile-body">
            <div class="stat-tile-label">Total Earned</div>
            <div class="stat-tile-value num">${esc(formatInrHero(d.wallet.totalEarnedMinor))}</div>
          </div>
        </div>
        <div class="stat-tile">
          <span class="icon-badge icon-badge-info">
            <svg class="ui-icon" viewBox="0 0 24 24"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11"/></svg>
          </span>
          <div class="stat-tile-body">
            <div class="stat-tile-label">Withdrawn</div>
            <div class="stat-tile-value num">${esc(formatInrHero(d.wallet.totalWithdrawnMinor))}</div>
          </div>
        </div>
        <div class="stat-tile">
          <span class="icon-badge icon-badge-warn">
            <svg class="ui-icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </span>
          <div class="stat-tile-body">
            <div class="stat-tile-label">Locked</div>
            <div class="stat-tile-value num">${esc(formatInrHero(d.wallet.lockedMinor))}</div>
          </div>
        </div>
        <div class="stat-tile">
          <span class="icon-badge icon-badge-teal">
            <svg class="ui-icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </span>
          <div class="stat-tile-body">
            <div class="stat-tile-label">Files</div>
            <div class="stat-tile-value num">${Number(d.counts.files || 0).toLocaleString()}</div>
            <div class="stat-tile-sub">${totalLinks} links</div>
          </div>
        </div>
      </div>
    </section>

    ${ownerRow}

    <section class="stats-activity-split">
      <div class="surface">
        <div class="surface-header">
          <div class="card-title-row">
            <span class="icon-badge icon-badge-teal">${NAV_ICONS.owner_kpis}</span>
            <span>Statistics</span>
          </div>
          <select id="overview-days-select" class="select" style="width:auto; min-height:34px; padding:5px 10px; font-size:12.5px;" aria-label="Statistics timeframe">
            <option value="7" ${Number(ovStats.days) === 7 ? 'selected' : ''}>7 Days</option>
            <option value="30" ${Number(ovStats.days) === 30 ? 'selected' : ''}>30 Days</option>
          </select>
        </div>
        <div class="surface-body">
          ${renderOverviewChart(ovStats)}
          <div class="chart-footer-metrics">
            <div class="chart-metric">
              <span class="icon-badge icon-badge-teal">
                <svg class="ui-icon" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </span>
              <div>
                <div class="chart-metric-val num">${Number(ovStats.totalOpens || 0).toLocaleString()}</div>
                <div class="chart-metric-label">Opens</div>
              </div>
            </div>
            <div class="chart-metric">
              <span class="icon-badge icon-badge-info">
                <svg class="ui-icon" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
              </span>
              <div>
                <div class="chart-metric-val num">${Number(ovStats.uniqueViewers || 0).toLocaleString()}</div>
                <div class="chart-metric-label">Viewers</div>
              </div>
            </div>
            <div class="chart-metric">
              <span class="icon-badge icon-badge-ok">
                <svg class="ui-icon" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
              </span>
              <div>
                <div class="chart-metric-val num">${totalLinks.toLocaleString()}</div>
                <div class="chart-metric-label">Links</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="surface">
        <div class="surface-header">
          <div class="card-title-row">
            <span class="icon-badge icon-badge-teal">${NAV_ICONS.shorteners}</span>
            <span>Recent Activity</span>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-nav="links">All →</button>
        </div>
        <div class="surface-body">
          ${recentActivity.length === 0 ? `
            <div class="empty-state" style="padding: 18px 10px;">
              <h3>No recent activity</h3>
            </div>
          ` : `
            <div class="activity-list">
              ${recentActivity.slice(0, 5).map((item) => {
                const meta = activityMeta(item);
                const amountLine = item.amountMinor
                  ? `<span class="${item.kind === 'earning' ? 'status-ok' : 'status-warn'} mono">${item.kind === 'earning' ? '+' : ''}${esc(formatInrHero(item.amountMinor))}</span> · `
                  : '';
                return `
                  <div class="activity-item">
                    <div class="activity-left">
                      <span class="icon-badge ${meta.badge}">${meta.icon}</span>
                      <div>
                        <div class="activity-title">${esc(item.title)}</div>
                        <div class="activity-detail">${amountLine}${esc(item.detail)}</div>
                      </div>
                    </div>
                    <span class="activity-time num">${esc(formatRelativeTime(item.createdAt))}</span>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </div>
      </div>
    </section>

    <section class="bottom-split">
      <div class="surface">
        <div class="surface-header">
          <div class="card-title-row">
            <span class="icon-badge icon-badge-teal">
              <svg class="ui-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </span>
            <span>Configuration</span>
          </div>
          <span class="currency-label" style="${allConfigured ? '' : 'color: var(--state-warn); border-color: rgba(245,158,11,0.35); background: var(--state-warn-bg);'}">
            ${allConfigured ? 'Ready ✓' : 'Incomplete'}
          </span>
        </div>
        <div class="surface-body">
          <button type="button" class="cfg-row cfg-row-btn" data-nav="setup">
            <span class="cfg-key">${NAV_ICONS.setup}<span>Delivery Bots</span></span>
            <span class="cfg-val"><span class="${(d.deliveryBots?.running || 0) > 0 ? 'status-ok' : 'status-muted'}">${d.deliveryBots?.primaryUsername ? `@${esc(d.deliveryBots.primaryUsername)} (${d.deliveryBots.running}/${d.deliveryBots.total})` : 'Shared'}</span></span>
          </button>
          <button type="button" class="cfg-row cfg-row-btn" data-nav="channels">
            <span class="cfg-key">${NAV_ICONS.channels}<span>Storage</span></span>
            <span class="cfg-val num"><span class="${d.counts.storageChannels > 0 ? 'status-ok' : 'status-muted'}">${d.counts.storageChannels > 0 ? `${d.counts.storageChannels} Active` : 'Shared'}</span></span>
          </button>
          <button type="button" class="cfg-row cfg-row-btn" data-nav="channels">
            <span class="cfg-key">${NAV_ICONS.users}<span>Force-Sub</span></span>
            <span class="cfg-val"><span class="${d.toggles.forceSubEnabled ? 'status-ok' : d.counts.forceSubChannels > 0 ? 'status-warn' : 'status-muted'}">${d.counts.forceSubChannels > 0 ? `${d.counts.forceSubChannels} (${d.toggles.forceSubEnabled ? 'On' : 'Off'})` : 'Off'}</span></span>
          </button>
          <button type="button" class="cfg-row cfg-row-btn" data-nav="shorteners">
            <span class="cfg-key">${NAV_ICONS.shorteners}<span>Shorteners</span></span>
            <span class="cfg-val"><span class="${d.toggles.checkpointEnabled ? 'status-ok' : 'status-muted'}">${d.toggles.checkpointEnabled ? `${d.counts.activeShorteners} On` : 'Off'}</span></span>
          </button>
          <button type="button" class="cfg-row cfg-row-btn" data-nav="plans">
            <span class="cfg-key">${NAV_ICONS.plans}<span>VIP Plans</span></span>
            <span class="cfg-val num">${d.counts.plans}</span>
          </button>
          <button type="button" class="cfg-row cfg-row-btn" data-nav="wallet">
            <span class="cfg-key">${NAV_ICONS.wallet}<span>Payout UPI</span></span>
            <span class="cfg-val"><span class="mono">${d.wallet.upiId ? esc(d.wallet.upiId) : 'Not set'}</span></span>
          </button>
        </div>
      </div>

      <div class="surface">
        <div class="surface-header">
          <div class="card-title-row">
            <span class="icon-badge icon-badge-teal">${NAV_ICONS.setup}</span>
            <span>Quick Actions</span>
          </div>
        </div>
        <div class="surface-body">
          <div class="quick-grid">
            <button type="button" class="quick-tile" data-nav="setup">
              <div>
                <span class="icon-badge icon-badge-info">${NAV_ICONS.setup}</span>
                <div class="quick-tile-title">Delivery Bots</div>
                <div class="quick-tile-sub">${Number(d.deliveryBots?.total || 0)} bot(s)</div>
              </div>
              <span class="mono">→</span>
            </button>
            <button type="button" class="quick-tile" data-nav="channels">
              <div>
                <span class="icon-badge icon-badge-ok">${NAV_ICONS.channels}</span>
                <div class="quick-tile-title">Channels</div>
                <div class="quick-tile-sub">${d.counts.storageChannels} storage</div>
              </div>
              <span class="mono">→</span>
            </button>
            <button type="button" class="quick-tile" data-nav="shorteners">
              <div>
                <span class="icon-badge icon-badge-teal">${NAV_ICONS.shorteners}</span>
                <div class="quick-tile-title">Shorteners</div>
                <div class="quick-tile-sub">${d.counts.activeShorteners} active</div>
              </div>
              <span class="mono">→</span>
            </button>
            <button type="button" class="quick-tile" data-nav="broadcasts">
              <div>
                <span class="icon-badge icon-badge-warn">${NAV_ICONS.broadcasts}</span>
                <div class="quick-tile-title">Broadcast</div>
                <div class="quick-tile-sub">Send update</div>
              </div>
              <span class="mono">→</span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Creator Setup Checklist</div>
        </div>
        ${state.botUsername ? `<a class="btn btn-sm btn-primary" href="${esc(safeHttpsUrl(`https://t.me/${state.botUsername}`))}" target="_blank" rel="noopener noreferrer">Open @${esc(state.botUsername)} →</a>` : ''}
      </div>
      <div class="surface-body">
        <div class="setup-checklist">
          <button type="button" class="setup-step-card" data-nav="setup">
            <div>
              <div class="setup-step-num">01 · BOT</div>
              <div class="setup-step-title">Delivery Bot</div>
              <div class="setup-step-desc">${d.deliveryBots?.total > 0 ? `@${esc(d.deliveryBots.primaryUsername || 'configured')}` : 'Optional @BotFather bot'}</div>
            </div>
            <span class="${d.deliveryBots?.running > 0 ? 'status-ok' : 'status-muted'}">${d.deliveryBots?.running > 0 ? 'Ready' : 'Setup →'}</span>
          </button>
          <button type="button" class="setup-step-card" data-nav="channels">
            <div>
              <div class="setup-step-num">02 · CHANNELS</div>
              <div class="setup-step-title">Storage &amp; Force-Sub</div>
              <div class="setup-step-desc">${d.counts.storageChannels > 0 ? `${d.counts.storageChannels} storage · ${d.counts.forceSubChannels} fsub` : 'Add channel'}</div>
            </div>
            <span class="${d.counts.storageChannels > 0 ? 'status-ok' : 'status-warn'}">${d.counts.storageChannels > 0 ? 'Ready' : 'Add →'}</span>
          </button>
          <button type="button" class="setup-step-card" data-nav="shorteners">
            <div>
              <div class="setup-step-num">03 · MONETIZE</div>
              <div class="setup-step-title">Shorteners &amp; Plans</div>
              <div class="setup-step-desc">${d.counts.activeShorteners} shortener · ${d.counts.plans} plan</div>
            </div>
            <span class="${d.counts.activeShorteners > 0 || d.counts.plans > 0 ? 'status-ok' : 'status-muted'}">${d.counts.activeShorteners > 0 || d.counts.plans > 0 ? 'Ready' : 'Setup →'}</span>
          </button>
          <button type="button" class="setup-step-card" data-nav="wallet">
            <div>
              <div class="setup-step-num">04 · PAYOUTS</div>
              <div class="setup-step-title">Payout UPI</div>
              <div class="setup-step-desc">${d.wallet.upiId ? esc(d.wallet.upiId) : 'Add UPI handle'}</div>
            </div>
            <span class="${d.wallet.upiId ? 'status-ok' : 'status-warn'}">${d.wallet.upiId ? 'Saved' : 'Add →'}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderSetupBots() {
  const d = state.data.bots;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(5)}</div>`;
  const bots = d?.bots || [];
  const mainHandle = d?.mainBotUsername ? `@${d.mainBotUsername}` : 'the Main Bot';
  const isOwner = Boolean(state.user?.isOwner);
  const rawSlots = d?.slots || null;
  const totalSlots = rawSlots?.totalAllowed ?? (1 + Number(rawSlots?.extraSlots || 0));
  const usedSlots = Number(rawSlots?.usedSlots ?? bots.length);
  const remainingSlots = rawSlots?.remainingSlots !== null && rawSlots?.remainingSlots !== undefined
    ? Number(rawSlots.remainingSlots)
    : Math.max(0, Number(totalSlots) - usedSlots);
  const canAddMore = isOwner || Boolean(rawSlots?.isUnlimited) || remainingSlots > 0;
  const slots = {
    unlimited: isOwner || Boolean(rawSlots?.isUnlimited),
    freeSlots: Number(rawSlots?.freeSlots ?? 1),
    extraSlots: Number(rawSlots?.extraSlots ?? 0),
    totalSlots: Number(totalSlots),
    usedSlots,
    remainingSlots,
    canAddMore,
    priceMinor: Number(rawSlots?.priceMinor ?? 9900),
    currency: rawSlots?.currency || 'INR',
    starsPrice: rawSlots?.starsPrice ?? null,
  };
  const slotPriceLabel = formatInrHero(slots.priceMinor || 9900);

  return `
    <div class="page-header">
      <div>
        <h1>Setup &amp; Delivery Bots</h1>
        <p class="page-sub">1 free slot · Change Bot replaces deleted bots without breaking links.</p>
      </div>
      <div class="page-actions">
        ${isOwner || slots.canAddMore
          ? `<button type="button" class="btn btn-primary" id="btn-add-creator-bot">Connect Delivery Bot</button>`
          : `<button type="button" class="btn btn-primary" id="btn-unlock-bot-slot">Unlock Slot (${esc(slotPriceLabel)})</button>`}
        ${!isOwner && slots.canAddMore
          ? `<button type="button" class="btn" id="btn-unlock-bot-slot">+1 Slot (${esc(slotPriceLabel)})</button>`
          : ''}
      </div>
    </div>

    ${d?.requiresStorageWarning ? `
      <div class="notice-card notice-warn">
        <div class="notice-card-copy">
          <div class="notice-card-title">Storage Channel Required</div>
          <div class="notice-card-desc">Add your Storage Channel and make ${esc(mainHandle)} &amp; your Delivery Bot Admins.</div>
        </div>
        <button type="button" class="btn btn-sm btn-primary" data-nav="channels">Add Storage Channel →</button>
      </div>
    ` : ''}

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Connected Delivery Bots (${bots.length})</div>
          <div class="surface-meta">${isOwner
            ? 'Platform bots'
            : `${Number(slots.usedSlots || 0)}/${Number(slots.totalSlots || 1)} slots · Extra ${esc(slotPriceLabel)}${slots.starsPrice ? ` / ${Number(slots.starsPrice)}★` : ''}`}</div>
        </div>
        ${!isOwner && bots.length > 0 && !slots.canAddMore
          ? `<button type="button" class="btn btn-sm btn-primary" id="btn-unlock-bot-slot-inline">+1 Slot (${esc(slotPriceLabel)})</button>`
          : ''}
      </div>
      ${!isOwner ? `
        <div class="slot-quota-bar">
          <div class="slot-quota-copy">
            <strong>${slots.canAddMore
              ? `${Number(slots.remainingSlots)} slot available`
              : `Slot limit reached (${Number(slots.usedSlots)}/${Number(slots.totalSlots)})`}</strong>
            <span>${slots.canAddMore ? '1 free slot included.' : `Unlock +1 slot (${esc(slotPriceLabel)}) or use Change Bot.`}</span>
          </div>
          <div class="slot-quota-meta mono">${Number(slots.usedSlots || 0)} / ${Number(slots.totalSlots || 1)}</div>
        </div>
      ` : ''}
      ${bots.length === 0 ? `
        <div class="empty-state">
          <h3>No custom bot connected</h3>
          <p>Uses ${d?.sharedBotUsername ? '@' + esc(d.sharedBotUsername) : 'shared bot'} by default. Custom bots need your own Storage Channel.</p>
          <button type="button" class="btn btn-primary" id="btn-add-creator-bot-empty">Connect Delivery Bot</button>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Bot</th>
                <th>Role &amp; Priority</th>
                <th class="col-right">Users</th>
                <th>Runtime</th>
                <th>Last Health</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${bots.map((b) => {
                const st = botRuntimeBadge(b);
                const botLink = b.username ? safeHttpsUrl(`https://t.me/${b.username}`) : '';
                return `
                  <tr>
                    <td data-label="Bot">
                      <div class="cell-primary">${botLink ? `<a href="${esc(botLink)}" target="_blank" rel="noopener noreferrer">@${esc(b.username)}</a>` : `@${esc(b.username)}`}</div>
                      <div class="cell-sub mono">#${b.id} · ${esc(b.telegramBotId)}</div>
                      ${b.hasCustomStartMessage ? `<div class="cell-sub status-ok">Custom /start${b.hasStartImage ? ' + Image' : ''}</div>` : ''}
                    </td>
                    <td data-label="Role &amp; Priority">
                      <div class="cell-primary">${b.role === 'primary' ? 'Primary' : 'Backup'}</div>
                      <div class="cell-sub mono">Prio ${Number(b.priority)}</div>
                    </td>
                    <td data-label="Users" class="col-right">
                      <div class="cell-primary num">${Number(b.totalUsers || 0).toLocaleString()}</div>
                      <div class="cell-sub num">${Number(b.activeUsers7d || 0)} 7d · ${Number(b.totalInteractions || 0).toLocaleString()} hits</div>
                    </td>
                    <td data-label="Runtime">
                      <span class="${st.cls}">${esc(st.label)}</span>
                      ${b.lastError ? `<div class="cell-sub status-danger">${esc(String(b.lastError).slice(0, 60))}</div>` : ''}
                    </td>
                    <td data-label="Last Health" class="num">${esc(formatDateTime(b.lastHealthAt))}</td>
                    <td data-label="Actions" class="col-right">
                      <div class="row-actions">
                        <button type="button" class="btn btn-sm" data-cbot-start="${b.id}" data-cbot-name="${esc(b.username)}">Start Msg</button>
                        <button type="button" class="btn btn-sm" data-cbot-test="${b.id}">Test</button>
                        <button type="button" class="btn btn-sm btn-primary" data-cbot-replace="${b.id}" data-cbot-name="${esc(b.username)}">Change Bot</button>
                        ${b.runtimeStatus === 'paused' || !b.isEnabled
                          ? `<button type="button" class="btn btn-sm" data-cbot-action="${b.id}:resume">Resume</button>`
                          : `<button type="button" class="btn btn-sm" data-cbot-action="${b.id}:pause">Pause</button>`}
                        <button type="button" class="btn btn-sm" data-cbot-action="${b.id}:restart">Restart</button>
                        ${b.role !== 'primary' && b.isEnabled ? `<button type="button" class="btn btn-sm" data-cbot-action="${b.id}:set_primary">Primary</button>` : ''}
                        <button type="button" class="btn btn-sm" data-cbot-prio="${b.id}" data-cbot-cur-prio="${Number(b.priority)}">Priority</button>
                        <button type="button" class="btn btn-sm btn-danger" data-cbot-del="${b.id}" data-cbot-name="${esc(b.username)}">Remove</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Workspace Setup</div>
      </div>
      <div class="surface-body">
        <div class="setup-checklist">
          <button type="button" class="setup-step-card" data-nav="channels">
            <div>
              <div class="setup-step-num">01 · CHANNELS</div>
              <div class="setup-step-title">Storage &amp; Force-Sub</div>
            </div>
            <span class="${d?.hasOwnStorage ? 'status-ok' : 'status-warn'}">${d?.hasOwnStorage ? 'Ready' : 'Setup →'}</span>
          </button>
          <button type="button" class="setup-step-card" data-nav="shorteners">
            <div>
              <div class="setup-step-num">02 · SHORTENERS</div>
              <div class="setup-step-title">Shorteners &amp; Test</div>
            </div>
            <span class="status-muted">Open →</span>
          </button>
          <button type="button" class="setup-step-card" data-nav="plans">
            <div>
              <div class="setup-step-num">03 · PLANS</div>
              <div class="setup-step-title">INR &amp; Stars VIP</div>
            </div>
            <span class="status-muted">Open →</span>
          </button>
          <button type="button" class="setup-step-card" data-nav="broadcasts">
            <div>
              <div class="setup-step-num">04 · BROADCAST</div>
              <div class="setup-step-title">Message Bot Users</div>
            </div>
            <span class="status-muted">Open →</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderBroadcasts() {
  const d = state.data.broadcasts;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(5)}</div>`;
  const bots = d?.bots || [];
  const campaigns = d?.campaigns || [];

  return `
    <div class="page-header">
      <div>
        <h1>Broadcasts</h1>
        <p class="page-sub">Message subscribers of your Delivery Bot.</p>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">New Broadcast</div>
      </div>
      <div class="surface-body">
        ${bots.length === 0 ? `
          <div class="empty-state">
            <h3>Connect a Delivery Bot first</h3>
            <button type="button" class="btn btn-primary" data-nav="setup">Setup Delivery Bots →</button>
          </div>
        ` : `
          <form id="creator-broadcast-form" class="gate-form">
            <div class="form-grid">
              <div class="field span-2">
                <label class="field-label" for="bc-bot-id">Delivery Bot</label>
                <select id="bc-bot-id" class="select" name="deliveryBotId" required>
                  ${bots.map((b) => `<option value="${b.id}">@${esc(b.username)} · ${Number(b.totalUsers || 0)} users</option>`).join('')}
                </select>
              </div>
              <div class="field span-2">
                <label class="field-label" for="bc-msg">Message</label>
                <textarea id="bc-msg" class="textarea" name="messageText" maxlength="4000" placeholder="Announcement text…" required></textarea>
              </div>
              <div class="field">
                <label class="field-label" for="bc-btn-text">Button Label (optional)</label>
                <input id="bc-btn-text" class="input" name="buttonText" maxlength="64" placeholder="Open Channel" />
              </div>
              <div class="field">
                <label class="field-label" for="bc-btn-url">Button URL (optional)</label>
                <input id="bc-btn-url" class="input mono" name="buttonUrl" placeholder="https://t.me/..." />
              </div>
            </div>
            <div class="page-actions" style="justify-content:flex-end;">
              <button type="submit" class="btn btn-primary">Send Broadcast</button>
            </div>
          </form>
        `}
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Campaigns (${campaigns.length})</div>
      </div>
      ${campaigns.length === 0 ? `
        <div class="empty-state">
          <h3>No broadcasts yet</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th class="col-right">Sent / Total</th>
                <th class="col-right">Failed</th>
                <th>Created</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${campaigns.map((c) => `
                <tr>
                  <td data-label="Campaign" class="mono">#${c.id} · Bot #${c.deliveryBotId}</td>
                  <td data-label="Status">
                    <span class="${c.status === 'completed' ? 'status-ok' : c.status === 'cancelled' ? 'status-danger' : 'status-warn'}">${esc(String(c.status).toUpperCase())}</span>
                    ${c.lastError ? `<div class="cell-sub status-danger">${esc(String(c.lastError).slice(0, 60))}</div>` : ''}
                  </td>
                  <td data-label="Sent / Total" class="col-right num">${Number(c.sentCount || 0)} / ${Number(c.totalRecipients || 0)}</td>
                  <td data-label="Failed" class="col-right num">${Number(c.failedCount || 0)}</td>
                  <td data-label="Created" class="num">${esc(formatDateTime(c.createdAt))}</td>
                  <td data-label="Actions" class="col-right">
                    <div class="row-actions">
                      ${c.status === 'pending' || c.status === 'running' ? `<button type="button" class="btn btn-sm" data-bc-act="${c.id}:pause">Pause</button>` : ''}
                      ${c.status === 'paused' ? `<button type="button" class="btn btn-sm" data-bc-act="${c.id}:resume">Resume</button>` : ''}
                      ${c.failedCount > 0 ? `<button type="button" class="btn btn-sm" data-bc-act="${c.id}:retry">Retry Failed</button>` : ''}
                      ${c.status === 'pending' || c.status === 'running' || c.status === 'paused' ? `<button type="button" class="btn btn-sm btn-danger" data-bc-act="${c.id}:cancel">Cancel</button>` : ''}
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderLinks() {
  const d = state.data.links;
  if (state.loading && !d) {
    return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  }
  const share = d?.shareLinks || [];
  const paidF = d?.paidFileLinks || [];
  const paidB = d?.paidBatchLinks || [];
  const files = state.data.files?.files || [];
  const unusedCount = Number(state.data.files?.unusedCount ?? files.filter((f) => Number(f.linkCount || 0) === 0).length);
  const all = [
    ...share.map((r) => ({ ...r, typeLabel: r.linkType === 'batch' ? `Free Batch (${r.itemCount})` : 'Free Single', priceText: 'Free' })),
    ...paidF.map((r) => ({ ...r, typeLabel: 'Paid Single', priceText: formatMoney(r.priceMinor, r.currency) })),
    ...paidB.map((r) => ({ ...r, typeLabel: `Paid Batch (${r.itemCount})`, priceText: formatMoney(r.priceMinor, r.currency) })),
  ];

  const tab = state.filters.linksTab;
  const search = state.filters.linksSearch.trim().toLowerCase();
  const filtered = all.filter((item) => {
    if (tab === 'share' && item.kind !== 'share') return false;
    if (tab === 'paid' && item.kind === 'share') return false;
    if (search && !`${item.title} ${item.code} ${item.typeLabel}`.toLowerCase().includes(search)) return false;
    return true;
  });
  const filteredFiles = files.filter((f) => (
    !search || `${f.fileName} ${f.fileCode} ${f.fileType}`.toLowerCase().includes(search)
  ));
  const mainBotUrl = state.botUsername ? safeHttpsUrl(`https://t.me/${state.botUsername}`) : '';

  return `
    <div class="page-header">
      <div>
        <h1>Links &amp; Files</h1>
        <p class="page-sub">Create in Telegram (/link, /Batch, /plink) · Manage &amp; clean here.</p>
      </div>
      <div class="page-actions">
        ${unusedCount > 0 ? `<button class="btn btn-sm" id="clean-unused-files-btn">Clean Unused Files (${unusedCount})</button>` : ''}
        ${mainBotUrl ? `<a class="btn btn-primary" href="${esc(mainBotUrl)}" target="_blank" rel="noopener noreferrer">Create in @${esc(state.botUsername)} →</a>` : ''}
      </div>
    </div>

    <div class="surface">
      <div class="toolbar">
        <div class="segmented" role="tablist">
          <button class="seg-btn ${tab === 'all' ? 'active' : ''}" data-link-tab="all">All (${all.length})</button>
          <button class="seg-btn ${tab === 'share' ? 'active' : ''}" data-link-tab="share">Free (${share.length})</button>
          <button class="seg-btn ${tab === 'paid' ? 'active' : ''}" data-link-tab="paid">Paid (${paidF.length + paidB.length})</button>
          <button class="seg-btn ${tab === 'files' ? 'active' : ''}" data-link-tab="files">Indexed Files (${files.length})</button>
        </div>
        <input id="links-search" class="input search-input" type="search" placeholder="${tab === 'files' ? 'Search files…' : 'Search links…'}" value="${esc(state.filters.linksSearch)}" />
      </div>

      ${tab === 'files' ? (
        filteredFiles.length === 0 ? `
          <div class="empty-state">
            <h3>No indexed files</h3>
          </div>
        ` : `
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>File &amp; Code</th>
                  <th>Type</th>
                  <th class="col-right">Size</th>
                  <th>Link Status</th>
                  <th>Uploaded</th>
                  <th class="col-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filteredFiles.map((f) => {
                  const mb = f.fileSize ? `${(Number(f.fileSize) / (1024 * 1024)).toFixed(2)} MB` : '—';
                  const inUse = Number(f.linkCount || 0) > 0;
                  return `
                    <tr>
                      <td data-label="File &amp; Code">
                        <div>
                          <div class="cell-primary">${esc(f.fileName || f.fileCode)}</div>
                          <div class="cell-sub mono">${esc(f.fileCode)}</div>
                        </div>
                      </td>
                      <td data-label="Type">${esc(f.fileType || 'media')}</td>
                      <td data-label="Size" class="col-right mono">${esc(mb)}</td>
                      <td data-label="Link Status">
                        <span class="${inUse ? 'status-ok' : 'status-warn'}">${inUse ? `Used (${f.linkCount})` : 'Unused'}</span>
                      </td>
                      <td data-label="Uploaded" class="num">${esc(formatDate(f.createdAt))}</td>
                      <td data-label="Actions" class="col-right">
                        <div class="row-actions">
                          ${inUse
                            ? '<span class="cell-sub">In active link</span>'
                            : `<button class="btn btn-sm btn-danger" data-delete-file="${esc(f.id)}" data-file-name="${esc(f.fileName || f.fileCode)}">Delete File</button>`}
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `
      ) : (
        filtered.length === 0 ? `
          <div class="empty-state">
            <h3>No links yet</h3>
            ${unusedCount > 0 ? `<p>${unusedCount} unused file(s) in Indexed Files.</p>` : ''}
          </div>
        ` : `
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Title &amp; Code</th>
                  <th>Type</th>
                  <th class="col-right">Price</th>
                  <th>Status</th>
                  <th class="col-right">Views</th>
                  <th>Created</th>
                  <th class="col-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map((item) => `
                  <tr>
                    <td data-label="Title &amp; Code">
                      <div>
                        <div class="cell-primary">${esc(item.title)}</div>
                        <div class="cell-sub mono">${esc(item.code)}</div>
                      </div>
                    </td>
                    <td data-label="Type">${esc(item.typeLabel)}</td>
                    <td data-label="Price" class="col-right mono">${esc(item.priceText)}</td>
                    <td data-label="Status"><span class="${item.isEnabled ? 'status-ok' : 'status-muted'}">${item.isEnabled ? 'Active' : 'Paused'}</span></td>
                    <td data-label="Views" class="col-right num"><span class="view-count">${Number(item.views||0).toLocaleString()}</span></td>
                    <td data-label="Created" class="num">${esc(formatDate(item.createdAt))}</td>
                    <td data-label="Actions" class="col-right">
                      <div class="row-actions">
                        ${item.url ? `<button class="btn btn-sm" data-copy-url="${esc(item.url)}">Copy URL</button>` : ''}
                        ${item.kind === 'share' ? `<button class="btn btn-sm" data-rename-link="${item.id}" data-link-title="${esc(item.title)}">Edit</button>` : `<button class="btn btn-sm" data-edit-paid-link="${item.kind}:${item.id}:${item.priceMinor}:${esc(item.currency)}:${esc(item.title)}">Edit</button>`}
                        <button class="btn btn-sm" data-toggle-link="${item.kind}:${item.id}:${item.isEnabled ? '0' : '1'}">${item.isEnabled ? 'Pause' : 'Enable'}</button>
                        <button class="btn btn-sm btn-danger" data-delete-link="${item.kind}:${item.id}">Delete</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `
      )}
    </div>
  `;
}

function renderShorteners() {
  const d = state.data.shorteners;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(4)}</div>`;
  const providers = d?.providers || [];
  const cpOn = Boolean(d?.checkpointEnabled);

  return `
    <div class="page-header">
      <div>
        <h1>URL Shorteners</h1>
        <p class="page-sub">Shortener rotation &amp; live API checks.</p>
      </div>
      <div class="page-actions">
        <button class="btn" id="btn-toggle-cp">${cpOn ? 'Checkpoints: ON' : 'Checkpoints: OFF'}</button>
        <button class="btn btn-primary" id="btn-add-shortener">Add Shortener</button>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Providers (${providers.length})</div>
          <div class="surface-meta">
            Checkpoints: <span class="${cpOn ? 'status-ok' : 'status-muted'}">${cpOn ? 'On' : 'Off'}</span>
          </div>
        </div>
      </div>

      ${providers.length === 0 ? `
        <div class="empty-state">
          <h3>No shorteners added</h3>
          <button class="btn btn-primary" id="btn-add-shortener-empty">Add Shortener</button>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Base URL</th>
                <th class="col-right">Duration</th>
                <th class="col-right">Priority</th>
                <th>Health</th>
                <th>Status</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${providers.map((p) => `
                <tr>
                  <td data-label="Provider"><div><div class="cell-primary">${esc(p.name)}</div><div class="cell-sub mono">#${p.id}</div></div></td>
                  <td data-label="Base URL">
                    <div class="mono" style="font-size:12.5px;">${esc(p.baseUrl)}</div>
                    ${p.apiEndpoint ? `<div class="cell-sub mono">${esc(p.apiEndpoint)}</div>` : ''}
                  </td>
                  <td data-label="Duration" class="col-right mono">${p.durationMinutes} min</td>
                  <td data-label="Priority" class="col-right mono">${p.priority}</td>
                  <td data-label="Health">
                    <span class="${p.lastTestStatus === 'ok' ? 'status-ok' : p.lastTestStatus === 'failed' ? 'status-danger' : 'status-muted'}">${esc(p.lastTestStatus || 'Untested')}</span>
                    ${p.lastTestError ? `<div class="cell-sub status-danger">${esc(String(p.lastTestError).slice(0, 50))}</div>` : ''}
                  </td>
                  <td data-label="Status"><span class="${p.isEnabled ? 'status-ok' : 'status-muted'}">${p.isEnabled ? 'Enabled' : 'Disabled'}</span></td>
                  <td data-label="Actions" class="col-right">
                    <div class="row-actions">
                      <button class="btn btn-sm" data-test-short="${p.id}">Test API</button>
                      <button class="btn btn-sm" data-toggle-short="${p.id}:${p.isEnabled ? '0' : '1'}">${p.isEnabled ? 'Disable' : 'Enable'}</button>
                      <button class="btn btn-sm" data-edit-short="${p.id}">Edit</button>
                      <button class="btn btn-sm btn-danger" data-del-short="${p.id}">Remove</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderChannels() {
  const d = state.data.channels;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(4)}</div>`;
  const storage = d?.storageChannels || [];
  const fsub = d?.forceSubChannels || [];
  const fsubOn = Boolean(d?.forceSubEnabled);
  const mainHandle = d?.mainBotUsername ? `@${d.mainBotUsername}` : 'the Main Bot';

  return `
    <div class="page-header">
      <div>
        <h1>Channels</h1>
        <p class="page-sub">Make ${esc(mainHandle)} &amp; your Delivery Bot Admin first.</p>
      </div>
      <div class="page-actions">
        <button class="btn" id="btn-toggle-fsub-global">${fsubOn ? 'Force-Sub: ON' : 'Force-Sub: OFF'}</button>
        <button class="btn" id="btn-add-fsub">Add Force-Sub Channel</button>
        <button class="btn btn-primary" id="btn-add-storage">Add Storage Channel</button>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Storage Channels (${storage.length})</div>
        <button type="button" class="btn btn-sm btn-primary" id="btn-add-storage-hdr">Add Storage Channel</button>
      </div>
      ${storage.length === 0 ? `
        <div class="empty-state">
          <h3>Using shared platform storage</h3>
          <p>Custom Delivery Bots require your own Storage Channel.</p>
          <button type="button" class="btn btn-primary" id="btn-add-storage-empty">Add Storage Channel</button>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Chat ID</th>
                <th>Role</th>
                <th>Access Check</th>
                <th>Status</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${storage.map((c) => `
                <tr>
                  <td data-label="Channel" class="cell-primary">${esc(c.title)}</td>
                  <td data-label="Chat ID" class="mono">${esc(c.chatId)}</td>
                  <td data-label="Role">${c.isPrimary ? 'Primary' : 'Secondary'}</td>
                  <td data-label="Access Check"><span class="${c.lastTestStatus === 'ok' ? 'status-ok' : c.lastTestStatus === 'failed' ? 'status-danger' : 'status-muted'}">${esc(c.lastTestStatus || 'Untested')}</span></td>
                  <td data-label="Status"><span class="${c.isEnabled ? 'status-ok' : 'status-muted'}">${c.isEnabled ? 'Enabled' : 'Disabled'}</span></td>
                  <td data-label="Actions" class="col-right">
                    <div class="row-actions">
                      <button class="btn btn-sm" data-storage-test="${esc(c.chatId)}">Test Access</button>
                      ${!c.isPrimary ? `<button class="btn btn-sm" data-storage-primary="${esc(c.chatId)}">Set Primary</button>` : ''}
                      <button class="btn btn-sm" data-storage-toggle="${esc(c.chatId)}:${c.isEnabled ? '0' : '1'}">${c.isEnabled ? 'Disable' : 'Enable'}</button>
                      <button class="btn btn-sm btn-danger" data-storage-del="${esc(c.chatId)}">Remove</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Force-Sub Channels (${fsub.length})</div>
          <div class="surface-meta">Gate: <span class="${fsubOn ? 'status-ok' : 'status-muted'}">${fsubOn ? 'On' : 'Off'}</span></div>
        </div>
        <button type="button" class="btn btn-sm btn-primary" id="btn-add-fsub-hdr">Add Force-Sub Channel</button>
      </div>
      ${fsub.length === 0 ? `
        <div class="empty-state">
          <h3>No force-sub channels</h3>
          <button type="button" class="btn btn-primary" id="btn-add-fsub-empty">Add Force-Sub Channel</button>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Join Link</th>
                <th>Access Check</th>
                <th>Status</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${fsub.map((c) => {
                const href = safeHttpsUrl(c.joinUrl);
                return `
                  <tr>
                    <td data-label="Channel"><div><div class="cell-primary">${esc(c.title)}</div><div class="cell-sub mono">${esc(c.chatId)}</div></div></td>
                    <td data-label="Join Link">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a>` : '—'}</td>
                    <td data-label="Access Check"><span class="${c.lastTestStatus === 'ok' ? 'status-ok' : c.lastTestStatus === 'failed' ? 'status-danger' : 'status-muted'}">${esc(c.lastTestStatus || 'Untested')}</span></td>
                    <td data-label="Status"><span class="${c.isEnabled ? 'status-ok' : 'status-muted'}">${c.isEnabled ? 'Enabled' : 'Disabled'}</span></td>
                    <td data-label="Actions" class="col-right">
                      <div class="row-actions">
                        <button class="btn btn-sm" data-fsub-test="${esc(c.chatId)}">Test Access</button>
                        <button class="btn btn-sm" data-fsub-toggle="${esc(c.chatId)}:${c.isEnabled ? '0' : '1'}">${c.isEnabled ? 'Disable' : 'Enable'}</button>
                        <button class="btn btn-sm btn-danger" data-fsub-del="${esc(c.chatId)}">Remove</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderPlans() {
  const d = state.data.plans;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(4)}</div>`;
  const plans = d?.plans || [];
  const isOwner = state.user?.isOwner;

  return `
    <div class="page-header">
      <div>
        <h1>${isOwner ? 'Platform Plans' : 'VIP Plans'}</h1>
        <p class="page-sub">${isOwner ? 'Manage platform plans &amp; grants.' : 'Paid tiers to skip shorteners.'}</p>
      </div>
      <div class="page-actions">
        ${isOwner ? `<button class="btn" id="btn-grant-premium">Grant</button><button class="btn" id="btn-revoke-premium">Revoke</button>` : ''}
        ${d?.checkoutLink ? `<button class="btn" data-copy-url="${esc(d.checkoutLink)}">Copy Link</button>` : ''}
        <button class="btn btn-primary" id="btn-add-plan">Create Plan</button>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">${isOwner ? 'Platform Plans' : 'Your Plans'} (${plans.length})</div>
      </div>

      ${plans.length === 0 ? `
        <div class="empty-state">
          <h3>No plans yet</h3>
          <button class="btn btn-primary" id="btn-add-plan-empty">Create Plan</button>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Plan Name</th>
                <th class="col-right">Price</th>
                <th class="col-right">Stars</th>
                <th class="col-right">Duration</th>
                <th>Status</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${plans.map((p) => `
                <tr>
                  <td data-label="Plan Name"><div><div class="cell-primary">${esc(p.name)}</div><div class="cell-sub mono">#${p.id}</div></div></td>
                  <td data-label="Price" class="col-right mono">${esc(formatMoney(p.priceMinor, p.currency))}</td>
                  <td data-label="Stars" class="col-right mono">${p.starsPrice ? `${Number(p.starsPrice)} XTR` : '—'}</td>
                  <td data-label="Duration" class="col-right mono">${p.durationDays}d</td>
                  <td data-label="Status"><span class="${p.isEnabled ? 'status-ok' : 'status-muted'}">${p.isEnabled ? 'Active' : 'Paused'}</span></td>
                  <td data-label="Actions" class="col-right">
                    <div class="row-actions">
                      <button class="btn btn-sm" data-edit-plan="${p.id}">Edit</button>
                      <button class="btn btn-sm" data-plan-stars="${p.id}" data-plan-cur-stars="${p.starsPrice ?? ''}">Stars</button>
                      <button class="btn btn-sm" data-toggle-plan="${p.id}:${p.isEnabled ? '0' : '1'}">${p.isEnabled ? 'Pause' : 'Enable'}</button>
                      <button class="btn btn-sm btn-danger" data-del-plan="${p.id}">Delete</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderWallet() {
  const d = state.data.wallet;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(5)}</div>`;
  const w = d?.wallet || { availableMinor: 0, lockedMinor: 0, totalEarnedMinor: 0, totalWithdrawnMinor: 0, upiId: null };
  const ledger = d?.recentLedger || [];
  const withdrawals = d?.recentWithdrawals || [];

  return `
    <div class="page-header">
      <div>
        <h1>Wallet &amp; Payouts</h1>
        <p class="page-sub">Min payout: ${esc(formatMoney(d?.minWithdrawalMinor || 100, 'INR'))} · UPI: <span class="mono">${w.upiId ? esc(w.upiId) : 'Not set'}</span></p>
      </div>
      <div class="page-actions">
        <button class="btn" id="btn-set-upi">${w.upiId ? 'Edit UPI' : 'Set UPI ID'}</button>
        <button class="btn btn-primary" id="btn-request-withdraw" ${w.availableMinor < (d?.minWithdrawalMinor || 100) ? 'disabled' : ''}>Withdraw</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <div class="kpi-label">Available</div>
        <div class="kpi-value">${esc(formatMoney(w.availableMinor, 'INR'))}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Locked</div>
        <div class="kpi-value">${esc(formatMoney(w.lockedMinor, 'INR'))}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Total Earned</div>
        <div class="kpi-value">${esc(formatMoney(w.totalEarnedMinor, 'INR'))}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Withdrawn</div>
        <div class="kpi-value">${esc(formatMoney(w.totalWithdrawnMinor, 'INR'))}</div>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Withdrawals (${withdrawals.length})</div>
      </div>
      ${withdrawals.length === 0 ? `
        <div class="empty-state">
          <h3>No withdrawals yet</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Request</th>
                <th>UPI ID</th>
                <th class="col-right">Amount</th>
                <th>Status</th>
                <th>Reference / Note</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              ${withdrawals.map((r) => `
                <tr>
                  <td data-label="Request" class="mono">#${r.id}</td>
                  <td data-label="UPI ID" class="mono">${esc(r.upiId)}</td>
                  <td data-label="Amount" class="col-right mono">${esc(formatMoney(r.amountMinor, r.currency))}</td>
                  <td data-label="Status"><span class="${r.status === 'paid' ? 'status-ok' : r.status === 'rejected' ? 'status-danger' : 'status-warn'}">${esc(r.status.toUpperCase())}</span></td>
                  <td data-label="Reference / Note" class="cell-sub">${esc(r.payoutReference || r.adminNote || '—')}</td>
                  <td data-label="Date" class="num">${esc(formatDate(r.createdAt))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Wallet Ledger (${ledger.length})</div>
      </div>
      ${ledger.length === 0 ? `
        <div class="empty-state">
          <h3>No transactions yet</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Description</th>
                <th class="col-right">Amount</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              ${ledger.map((e) => `
                <tr>
                  <td data-label="Type">${esc(e.entryType.replaceAll('_', ' '))}</td>
                  <td data-label="Description">${esc(e.description || '—')}</td>
                  <td data-label="Amount" class="col-right mono ${e.amountMinor >= 0 ? 'status-ok' : 'status-muted'}">${e.amountMinor >= 0 ? '+' : ''}${esc(formatMoney(e.amountMinor, e.currency))}</td>
                  <td data-label="Date" class="num">${esc(formatDateTime(e.createdAt))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderTokenSettings() {
  return `
    <div class="page-header">
      <div>
        <h1>Access Token</h1>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Token Status</div>
          <div class="surface-meta">SHA-256 hashed</div>
        </div>
        <button class="btn btn-danger" id="btn-rotate-token">Regenerate Token</button>
      </div>
      <div class="surface-body">
        <div class="kv-list">
          <div class="kv-row">
            <span class="kv-key">Account</span>
            <span class="kv-val">${esc(state.user.firstName || state.user.username || 'User')} · <span class="mono">${state.user.userId}</span></span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Role</span>
            <span class="kv-val">${state.user.isOwner ? 'Platform Owner' : 'Creator'}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Prefix</span>
            <span class="kv-val mono">${esc(state.user.tokenPrefix)}••••••••</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Last Rotated</span>
            <span class="kv-val num">${esc(formatDateTime(state.user.rotatedAt))}</span>
          </div>
        </div>

        ${state.freshRotatedToken ? `
          <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-hairline);">
            <div class="field-label">New Token (save safely)</div>
            <div class="token-reveal">${esc(state.freshRotatedToken)}</div>
            <button class="btn btn-primary btn-sm" data-copy-url="${esc(state.freshRotatedToken)}">Copy Token</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderOwnerKpis() {
  const d = state.data.ownerDashboard;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(5)}</div>`;
  if (!d) return `<div class="surface"><div class="empty-state"><h3>Could not load owner dashboard</h3><button class="btn btn-primary" data-refresh="1">Retry</button></div></div>`;

  const s = d.stats;
  const h = d.health;
  return `
    <div class="page-header">
      <div>
        <h1>Platform KPIs</h1>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <div class="kpi-label">Users</div>
        <div class="kpi-value">${s.trackedUsers}</div>
        <div class="kpi-sub">VIP: ${s.activePremium}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Files</div>
        <div class="kpi-value">${s.activeFiles}</div>
        <div class="kpi-sub">${s.paidFileLinks} file · ${s.paidBatchLinks} batch</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Revenue</div>
        <div class="kpi-value" style="font-size:17px;">${esc(formatRevenue(s.revenueByCurrency))}</div>
        <div class="kpi-sub">${s.paymentsApplied} tx</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">DB Latency</div>
        <div class="kpi-value">${h.latencyMs} ms</div>
        <div class="kpi-sub"><span class="${h.warnings?.length ? 'status-warn' : 'status-ok'}">${h.warnings?.length ? `${h.warnings.length} warn` : 'Nominal'}</span></div>
      </div>
    </div>

    <div class="two-col">
      <div class="surface">
        <div class="surface-header"><div class="surface-title">Counters</div></div>
        <div class="surface-body">
          <div class="kv-list">
            <div class="kv-row"><span class="kv-key">Pending / Processing</span><span class="kv-val mono">${h.stats.delivery_pending} / ${h.stats.delivery_processing}</span></div>
            <div class="kv-row"><span class="kv-key">Delivery Failed</span><span class="kv-val mono ${h.stats.delivery_failed > 0 ? 'status-danger' : ''}">${h.stats.delivery_failed}</span></div>
            <div class="kv-row"><span class="kv-key">Auto-Delete Due</span><span class="kv-val mono">${h.stats.deletions_due}</span></div>
            <div class="kv-row"><span class="kv-key">Payment Recovery</span><span class="kv-val mono ${h.stats.payment_recovery_pending > 0 ? 'status-warn' : ''}">${h.stats.payment_recovery_pending}</span></div>
          </div>
        </div>
      </div>

      <div class="surface">
        <div class="surface-header"><div class="surface-title">Warnings</div></div>
        <div class="surface-body">
          ${h.warnings?.length ? `
            <div class="kv-list">
              ${h.warnings.map((w) => `<div class="kv-row"><span class="status-warn">${esc(w)}</span></div>`).join('')}
            </div>
          ` : `<p>All queues healthy.</p>`}
        </div>
      </div>
    </div>
  `;
}

function renderOwnerWithdrawals() {
  const d = state.data.ownerWithdrawals;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(5)}</div>`;
  const rows = d?.rows || [];
  const currentStatus = state.filters.withdrawalsStatus;

  return `
    <div class="page-header">
      <div>
        <h1>Withdrawals Queue</h1>
      </div>
    </div>

    <div class="surface">
      <div class="toolbar">
        <div class="segmented">
          ${['pending', 'paid', 'rejected', 'all'].map((st) => `
            <button class="seg-btn ${currentStatus === st ? 'active' : ''}" data-wd-status="${st}">${st[0].toUpperCase() + st.slice(1)}</button>
          `).join('')}
        </div>
        <span class="surface-meta num">${d?.total || 0} total</span>
      </div>

      ${rows.length === 0 ? `
        <div class="empty-state">
          <h3>No ${esc(currentStatus)} requests</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Creator</th>
                <th>UPI ID</th>
                <th class="col-right">Amount</th>
                <th>Status</th>
                <th>Requested</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((w) => `
                <tr>
                  <td data-label="ID" class="mono">#${w.id}</td>
                  <td data-label="Creator">
                    <div>
                      <div class="cell-primary">${esc(w.firstName || w.username || 'Creator')}</div>
                      <div class="cell-sub mono">${esc(w.userId)}</div>
                    </div>
                  </td>
                  <td data-label="UPI ID" class="mono">${esc(w.upiId)}</td>
                  <td data-label="Amount" class="col-right mono">${esc(formatMoney(w.amountMinor, w.currency))}</td>
                  <td data-label="Status">
                    <div>
                      <span class="${w.status === 'paid' ? 'status-ok' : w.status === 'rejected' ? 'status-danger' : 'status-warn'}">${esc(w.status.toUpperCase())}</span>
                      ${w.payoutReference ? `<div class="cell-sub mono">${esc(w.payoutReference)}</div>` : ''}
                    </div>
                  </td>
                  <td data-label="Requested" class="num">${esc(formatDateTime(w.createdAt))}</td>
                  <td data-label="Actions" class="col-right">
                    ${w.status === 'pending' ? `
                      <div class="row-actions">
                        <button class="btn btn-sm btn-primary" data-wd-approve="${w.id}" data-wd-upi="${esc(w.upiId)}" data-wd-amt="${esc(formatMoney(w.amountMinor, w.currency))}">Mark Paid</button>
                        <button class="btn btn-sm btn-danger" data-wd-reject="${w.id}">Reject</button>
                      </div>
                    ` : `<span class="status-muted">Done</span>`}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderOwnerPayments() {
  const pay = state.data.ownerPayments;
  const dash = state.data.ownerDashboard;
  if (state.loading && !pay) return `<div class="surface">${renderSkeletonRows(5)}</div>`;
  const rows = pay?.rows || [];
  const methods = dash?.paymentMethods || [];

  return `
    <div class="page-header">
      <div>
        <h1>Payments &amp; Gateways</h1>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Gateways</div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Gateway</th>
              <th>Status</th>
              <th>Last Test</th>
              <th class="col-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${methods.map((m) => `
              <tr>
                <td data-label="Gateway" class="cell-primary">${esc(m.method)}</td>
                <td data-label="Status"><span class="${m.isEnabled ? 'status-ok' : 'status-muted'}">${m.isEnabled ? 'Enabled' : 'Disabled'}</span></td>
                <td data-label="Last Test" class="cell-sub">${esc(m.lastTestStatus || 'Untested')}${m.lastTestError ? ' · ' + esc(m.lastTestError) : ''}</td>
                <td data-label="Actions" class="col-right">
                  ${(m.method === 'fampay' || m.method === 'telegram_stars') ? `
                    <button class="btn btn-sm" data-gw-toggle="${esc(m.method)}:${m.isEnabled ? '0' : '1'}">${m.isEnabled ? 'Disable' : 'Enable'}</button>
                  ` : `<span class="status-muted">—</span>`}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="surface">
      <div class="toolbar">
        <div class="segmented">
          ${['all', 'verified', 'applied', 'rejected'].map((st) => `
            <button class="seg-btn ${state.filters.paymentsStatus === st && !state.filters.paymentsSearch ? 'active' : ''}" data-pay-status="${st}">${st[0].toUpperCase() + st.slice(1)}</button>
          `).join('')}
        </div>
        <form id="pay-search-form" class="input-row">
          <input id="pay-search-input" class="input search-input" type="search" placeholder="Search tx, user, UTR…" value="${esc(state.filters.paymentsSearch)}" />
          <button class="btn btn-sm" type="submit">Go</button>
        </form>
      </div>

      ${rows.length === 0 ? `
        <div class="empty-state">
          <h3>No matching transactions</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Tx ID</th>
                <th>User</th>
                <th>Method · Purpose</th>
                <th class="col-right">Amount</th>
                <th>Status</th>
                <th>Created</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td data-label="Tx ID" class="mono">#${r.id}</td>
                  <td data-label="User" class="mono">${esc(r.user_telegram_id)}</td>
                  <td data-label="Method · Purpose">${esc(r.method)} · ${esc(r.purpose)}</td>
                  <td data-label="Amount" class="col-right mono">${esc(formatMoney(r.amount_minor, r.currency))}</td>
                  <td data-label="Status"><span class="${r.status === 'applied' ? 'status-ok' : r.status === 'verified' ? 'status-warn' : 'status-muted'}">${esc(String(r.status).toUpperCase())}</span></td>
                  <td data-label="Created" class="num">${esc(formatDateTime(r.created_at))}</td>
                  <td data-label="Actions" class="col-right">
                    ${r.status === 'verified' ? `<button class="btn btn-sm btn-primary" data-pay-reconcile="${r.id}">Reconcile</button>` : '<span class="status-muted">—</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderOwnerDelivery() {
  const d = state.data.ownerDashboard;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(5)}</div>`;
  const jobs = d?.jobs || [];
  const mins = Number(d?.autoDeleteMinutes || 0);

  return `
    <div class="page-header">
      <div>
        <h1>Delivery &amp; Auto-Delete</h1>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" id="btn-set-autodel">Set Auto-Delete</button>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Auto-Delete</div>
          <div class="surface-meta">
            Status: <span class="${mins > 0 ? 'status-ok' : 'status-muted'}">${mins > 0 ? `${mins} min` : 'Off'}</span>
          </div>
        </div>
        ${mins > 0 ? `<button class="btn btn-sm" id="btn-autodel-off">Turn Off</button>` : ''}
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Recent Jobs (${jobs.length})</div>
      </div>
      ${jobs.length === 0 ? `
        <div class="empty-state">
          <h3>No delivery jobs</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Job ID</th>
                <th>Requester</th>
                <th>Status</th>
                <th class="col-right">Attempts</th>
                <th>Error</th>
                <th>Created</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${jobs.map((j) => `
                <tr>
                  <td data-label="Job ID" class="mono">#${j.id}</td>
                  <td data-label="Requester" class="mono">${esc(j.requesterId)}</td>
                  <td data-label="Status"><span class="${j.status === 'completed' ? 'status-ok' : j.status === 'failed' ? 'status-danger' : 'status-warn'}">${esc(j.status)}</span></td>
                  <td data-label="Attempts" class="col-right mono">${j.attemptCount}</td>
                  <td data-label="Error" class="cell-sub">${esc(j.lastError || '—')}</td>
                  <td data-label="Created" class="num">${esc(formatDateTime(j.createdAt))}</td>
                  <td data-label="Actions" class="col-right">
                    ${j.status === 'failed' ? `<button class="btn btn-sm" data-retry-job="${j.id}">Retry</button>` : '<span class="status-muted">—</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function botRuntimeBadge(b) {
  if (!b.isEnabled) return { cls: 'status-muted', label: 'Disabled' };
  if (b.runtimeStatus === 'running') return { cls: 'status-ok', label: 'Running' };
  if (b.runtimeStatus === 'error') return { cls: 'status-danger', label: 'Error' };
  if (b.runtimeStatus === 'paused') return { cls: 'status-warn', label: 'Paused' };
  return { cls: 'status-muted', label: b.runtimeStatus || 'Offline' };
}

function formatBotOwner(b) {
  if (b.isPlatform) return { title: 'Platform Default', sub: 'Owner / Shared Pool' };
  const name = [b.ownerFirstName, b.ownerLastName].filter(Boolean).join(' ') || `Creator ${b.ownerId}`;
  const sub = `${b.ownerUsername ? '@' + b.ownerUsername + ' · ' : ''}ID ${b.ownerId}`;
  return { title: name, sub };
}

function renderOwnerBotDetail() {
  const detail = state.data.ownerBotDetail;
  if (state.loading && !detail) return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  if (!detail?.bot) {
    return `
      <div class="surface">
        <div class="empty-state">
          <h3>Delivery bot not found</h3>
          <p>This delivery bot may have been removed.</p>
          <button class="btn btn-primary" id="btn-bots-back">Back to All Delivery Bots</button>
        </div>
      </div>
    `;
  }
  const b = detail.bot;
  const st = botRuntimeBadge(b);
  const owner = formatBotOwner(b);
  const botLink = b.username ? safeHttpsUrl(`https://t.me/${b.username}`) : '';
  const recentUsers = detail.recentUsers || [];
  const storage = detail.storageChannels || [];
  const fsub = detail.forceSubChannels || [];

  return `
    <div class="page-header">
      <div>
        <h1>@${esc(b.username)} <span class="mono" style="font-size:0.72em; color:var(--text-muted);">#${b.id}</span></h1>
        <p class="page-sub">${esc(owner.title)} · ${esc(owner.sub)}</p>
      </div>
      <div class="page-actions">
        <button class="btn" id="btn-bots-back">← Back</button>
        ${botLink ? `<a class="btn" href="${esc(botLink)}" target="_blank" rel="noopener noreferrer">Open Bot</a>` : ''}
        <button class="btn btn-primary" data-bot-edit="${b.id}">Edit</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <div class="kpi-label">Total Users</div>
        <div class="kpi-value">${Number(b.totalUsers || 0).toLocaleString()}</div>
        <div class="kpi-sub">7d: ${Number(b.activeUsers7d || 0).toLocaleString()}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Interactions</div>
        <div class="kpi-value">${Number(b.totalInteractions || 0).toLocaleString()}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Jobs</div>
        <div class="kpi-value">${Number(b.jobsCompleted || 0).toLocaleString()} <span style="font-size:0.6em; color:var(--text-muted);">/ ${Number(b.jobsTotal || 0).toLocaleString()}</span></div>
        <div class="kpi-sub">Fail: ${Number(b.jobsFailed || 0)} · Wait: ${Number(b.jobsPending || 0)}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Runtime</div>
        <div class="kpi-value"><span class="${st.cls}">${esc(st.label)}</span></div>
        <div class="kpi-sub">${b.role === 'primary' ? 'Primary' : 'Backup'} · Prio ${Number(b.priority)}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="surface">
        <div class="surface-header">
          <div class="surface-title">Bot Controls</div>
          <div class="row-actions">
            <button class="btn btn-sm" data-bot-test="${b.id}">Test</button>
            ${b.runtimeStatus === 'paused' || !b.isEnabled
              ? `<button class="btn btn-sm" data-bot-action="${b.id}:resume">Resume</button>`
              : `<button class="btn btn-sm" data-bot-action="${b.id}:pause">Pause</button>`}
            <button class="btn btn-sm" data-bot-action="${b.id}:restart">Restart</button>
          </div>
        </div>
        <div class="surface-body">
          <div class="kv-list">
            <div class="kv-row"><span class="kv-key">Bot ID</span><span class="kv-val mono">#${b.id} · ${esc(b.telegramBotId)}</span></div>
            <div class="kv-row"><span class="kv-key">Owner</span><span class="kv-val">${esc(owner.title)} (${esc(owner.sub)})</span></div>
            <div class="kv-row"><span class="kv-key">Role / Priority</span><span class="kv-val">${b.role === 'primary' ? 'Primary' : 'Backup'} · ${Number(b.priority)}</span></div>
            <div class="kv-row"><span class="kv-key">Custom /start</span><span class="kv-val">${b.hasCustomStartMessage ? (b.hasStartImage ? 'Text + Image' : 'Text Only') : 'Default'}</span></div>
            <div class="kv-row"><span class="kv-key">Health</span><span class="kv-val num">${esc(formatDateTime(b.lastHealthAt))}</span></div>
            ${b.lastError ? `<div class="kv-row"><span class="kv-key">Error</span><span class="kv-val status-danger">${esc(b.lastError)}</span></div>` : ''}
          </div>
          <div class="row-actions" style="margin-top:12px;">
            <button class="btn btn-sm btn-primary" data-bot-users="${b.id}" data-bot-name="${esc(b.username)}">Users (${Number(b.totalUsers || 0)})</button>
            ${b.role !== 'primary' && b.isEnabled ? `<button class="btn btn-sm" data-bot-action="${b.id}:primary">Set Primary</button>` : ''}
            <button class="btn btn-sm btn-danger" data-bot-remove="${b.id}" data-bot-name="${esc(b.username)}">Remove</button>
          </div>
        </div>
      </div>

      <div class="surface">
        <div class="surface-header">
          <div class="surface-title">Channels (${storage.length} Storage · ${fsub.length} Force-Sub)</div>
        </div>
        <div class="surface-body">
          ${storage.length === 0 && fsub.length === 0 ? `
            <div class="empty-state">
              <h3>No channels linked</h3>
            </div>
          ` : `
            <div class="kv-list">
              ${storage.map((c) => `
                <div class="kv-row">
                  <span class="kv-key">Storage · ${esc(c.title)}</span>
                  <span class="kv-val"><span class="${c.isEnabled ? 'status-ok' : 'status-muted'}">${c.isEnabled ? 'On' : 'Off'}</span> · ${esc(c.lastTestStatus || 'unknown')}</span>
                </div>
              `).join('')}
              ${fsub.map((c) => `
                <div class="kv-row">
                  <span class="kv-key">Force-Sub · ${esc(c.title)}</span>
                  <span class="kv-val"><span class="${c.isEnabled ? 'status-ok' : 'status-muted'}">${c.isEnabled ? 'On' : 'Off'}</span> · ${esc(c.lastTestStatus || 'unknown')}</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Recent Users (${recentUsers.length} / ${Number(b.totalUsers || 0).toLocaleString()})</div>
        <button class="btn btn-sm" data-bot-users="${b.id}" data-bot-name="${esc(b.username)}">All Users</button>
      </div>
      ${recentUsers.length === 0 ? `
        <div class="empty-state">
          <h3>No users yet</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Telegram ID</th>
                <th>First Seen</th>
                <th>Last Seen</th>
                <th class="col-right">Interactions</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${recentUsers.map((u) => `
                <tr>
                  <td data-label="User">
                    <div class="cell-primary">${esc([u.firstName, u.lastName].filter(Boolean).join(' ') || 'Telegram User')}</div>
                    <div class="cell-sub">${u.username ? '@' + esc(u.username) : 'No username'}</div>
                  </td>
                  <td data-label="Telegram ID" class="mono">${esc(u.userId)}</td>
                  <td data-label="First Seen" class="num">${esc(formatDate(u.firstSeenAt))}</td>
                  <td data-label="Last Seen" class="num">${esc(formatDateTime(u.lastSeenAt))}</td>
                  <td data-label="Interactions" class="col-right num">${Number(u.interactions || 0).toLocaleString()}</td>
                  <td data-label="Status"><span class="${u.isBlocked ? 'status-danger' : 'status-ok'}">${u.isBlocked ? 'Blocked' : 'Active'}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderOwnerBots() {
  if (state.selectedBotId) return renderOwnerBotDetail();
  const d = state.data.ownerBots;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  const rows = d?.rows || [];
  const slotSettings = d?.botSlotSettings || { priceMinor: 9900, currency: 'INR', starsPrice: null };
  const slotPriceLabel = formatInrHero(slotSettings.priceMinor || 9900);
  const summary = d?.summary || {
    totalBots: rows.length,
    runningBots: rows.filter((r) => r.isEnabled && r.runtimeStatus === 'running').length,
    platformBots: rows.filter((r) => r.isPlatform).length,
    creatorBots: rows.filter((r) => !r.isPlatform).length,
    uniqueBotUsers: 0,
  };

  return `
    <div class="page-header">
      <div>
        <h1>All Delivery Bots</h1>
      </div>
      <div class="page-actions">
        <button type="button" class="btn btn-primary" id="btn-owner-slot-price" data-owner-slot-price="1">Set Slot Price (${esc(slotPriceLabel)})</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <div class="kpi-label">Total Bots</div>
        <div class="kpi-value">${Number(summary.totalBots || 0).toLocaleString()}</div>
        <div class="kpi-sub">Plat ${Number(summary.platformBots || 0)} · User ${Number(summary.creatorBots || 0)}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Running</div>
        <div class="kpi-value">${Number(summary.runningBots || 0).toLocaleString()}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Creator Bots</div>
        <div class="kpi-value">${Number(summary.creatorBots || 0).toLocaleString()}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Bot Users</div>
        <div class="kpi-value">${Number(summary.uniqueBotUsers || 0).toLocaleString()}</div>
      </div>
    </div>

    <div class="slot-quota-bar surface">
      <div class="slot-quota-copy">
        <strong>Extra Bot Slot Price: ${esc(slotPriceLabel)}${slotSettings.starsPrice ? ` · ${Number(slotSettings.starsPrice)}★` : ''}</strong>
        <span>1 free slot per creator</span>
      </div>
      <button type="button" class="btn btn-sm" data-owner-slot-price="1">Edit Price</button>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">${Number(d?.total ?? 0).toLocaleString()} bots</div>
      </div>
      <div class="toolbar">
        <input class="input search-input" id="bots-search" placeholder="Search @bot or owner…" value="${esc(state.filters.botsSearch)}"/>
        <select class="select search-input" id="bots-scope">
          <option value="all" ${state.filters.botsScope === 'all' ? 'selected' : ''}>All Scopes</option>
          <option value="platform" ${state.filters.botsScope === 'platform' ? 'selected' : ''}>Platform</option>
          <option value="creator" ${state.filters.botsScope === 'creator' ? 'selected' : ''}>Creator</option>
        </select>
        <select class="select search-input" id="bots-status">
          <option value="all" ${state.filters.botsStatus === 'all' ? 'selected' : ''}>All Statuses</option>
          <option value="running" ${state.filters.botsStatus === 'running' ? 'selected' : ''}>Running</option>
          <option value="paused" ${state.filters.botsStatus === 'paused' ? 'selected' : ''}>Paused</option>
          <option value="error" ${state.filters.botsStatus === 'error' ? 'selected' : ''}>Error</option>
          <option value="disabled" ${state.filters.botsStatus === 'disabled' ? 'selected' : ''}>Disabled</option>
        </select>
      </div>
      ${rows.length === 0 ? `
        <div class="empty-state">
          <h3>No delivery bots found</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Bot</th>
                <th>Owner</th>
                <th>Role & Priority</th>
                <th class="col-right">Total Users</th>
                <th>Runtime</th>
                <th>Last Health</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((b) => {
                const st = botRuntimeBadge(b);
                const owner = formatBotOwner(b);
                return `
                  <tr>
                    <td data-label="Bot">
                      <div class="cell-primary">@${esc(b.username)}</div>
                      <div class="cell-sub mono">#${b.id} · TG ${esc(b.telegramBotId)}</div>
                    </td>
                    <td data-label="Owner">
                      <div class="cell-primary">${esc(owner.title)}</div>
                      <div class="cell-sub">${esc(owner.sub)}</div>
                    </td>
                    <td data-label="Role & Priority">
                      <div class="cell-primary">${b.role === 'primary' ? 'Primary' : 'Backup'}</div>
                      <div class="cell-sub mono">Priority ${Number(b.priority)} · ${Number(b.storageChannelsCount)} storage</div>
                    </td>
                    <td data-label="Total Users" class="col-right">
                      <div class="cell-primary num">${Number(b.totalUsers || 0).toLocaleString()}</div>
                      <div class="cell-sub num">${Number(b.activeUsers7d || 0)} 7d · ${Number(b.totalInteractions || 0).toLocaleString()} hits</div>
                    </td>
                    <td data-label="Runtime">
                      <span class="${st.cls}">${esc(st.label)}</span>
                      ${b.lastError ? `<div class="cell-sub status-danger">${esc(String(b.lastError).slice(0, 60))}</div>` : ''}
                    </td>
                    <td data-label="Last Health" class="num">${esc(formatDateTime(b.lastHealthAt))}</td>
                    <td data-label="Actions" class="col-right">
                      <div class="row-actions">
                        <button class="btn btn-sm btn-primary" data-bot-view="${b.id}">View</button>
                        <button class="btn btn-sm" data-bot-edit="${b.id}">Edit</button>
                        <button class="btn btn-sm" data-bot-users="${b.id}" data-bot-name="${esc(b.username)}">Users (${Number(b.totalUsers || 0)})</button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderUserDirectory() {
  const d = state.data.users;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  const rows = d?.rows || [];
  return `
    <div class="page-header">
      <div>
        <h1>${state.user?.isOwner ? 'All Users' : 'Bot Users'}</h1>
      </div>
      ${state.filters.usersBotId ? `
        <div class="page-actions">
          <button class="btn" id="btn-clear-user-bot-filter">All Users (Clear @${esc(state.filters.usersBotName || state.filters.usersBotId)})</button>
        </div>
      ` : ''}
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">${Number(d?.total ?? 0).toLocaleString()} users${state.filters.usersBotId ? ` · @${esc(state.filters.usersBotName || state.filters.usersBotId)}` : ''}</div>
      </div>
      <div class="toolbar">
        <input class="input search-input" id="users-search" placeholder="Search name, @user or ID" value="${esc(state.filters.usersSearch)}"/>
      </div>
      ${rows.length === 0 ? `
        <div class="empty-state">
          <h3>No users found</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Telegram ID</th>
                <th>Joined</th>
                <th>Last Seen</th>
                <th>Bots</th>
                <th>Premium</th>
                <th class="col-right">Interactions</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((u) => `
                <tr>
                  <td data-label="User">
                    <div class="cell-primary">${esc([u.firstName, u.lastName].filter(Boolean).join(' ') || 'Telegram User')}</div>
                    <div class="cell-sub">${u.username ? '@' + esc(u.username) : 'No username'}</div>
                  </td>
                  <td data-label="Telegram ID" class="mono">${esc(u.userId)}</td>
                  <td data-label="Joined" class="num">${esc(formatDate(u.joinedAt))}</td>
                  <td data-label="Last Seen" class="num">${esc(formatDateTime(u.lastSeenAt))}</td>
                  <td data-label="Bots">${esc((u.botNames || []).join(', ') || '—')}</td>
                  <td data-label="Premium"><span class="${u.premiumActive ? 'status-ok' : 'status-muted'}">${u.premiumActive ? 'Premium' : 'Free'}</span></td>
                  <td data-label="Interactions" class="col-right num">${Number(u.interactions || 0).toLocaleString()}</td>
                  <td data-label="Status"><span class="${u.isBlocked ? 'status-danger' : 'status-ok'}">${u.isBlocked ? 'Blocked' : 'Active'}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderPremiumDirectory() {
  const d = state.data.premiumMembers;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  const rows = d?.rows || [];
  return `
    <div class="page-header">
      <div>
        <h1>${state.user?.isOwner ? 'Premium Members' : 'My VIP Members'}</h1>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">${Number(d?.total ?? 0).toLocaleString()} memberships</div>
      </div>
      <div class="toolbar">
        <input class="input search-input" id="premium-search" placeholder="Search name, @user or ID" value="${esc(state.filters.premiumSearch)}"/>
        <select class="select search-input" id="premium-status">
          <option value="all" ${state.filters.premiumStatus === 'all' ? 'selected' : ''}>All</option>
          <option value="active" ${state.filters.premiumStatus === 'active' ? 'selected' : ''}>Active</option>
          <option value="expired" ${state.filters.premiumStatus === 'expired' ? 'selected' : ''}>Expired</option>
          <option value="permanent" ${state.filters.premiumStatus === 'permanent' ? 'selected' : ''}>Lifetime</option>
        </select>
      </div>
      ${rows.length === 0 ? `
        <div class="empty-state">
          <h3>No premium members</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Telegram ID</th>
                <th>Plan</th>
                <th>Start</th>
                <th>Expiry</th>
                <th class="col-right">Days Left</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((m) => `
                <tr>
                  <td data-label="Member">
                    <div class="cell-primary">${esc([m.firstName, m.lastName].filter(Boolean).join(' ') || 'Telegram User')}</div>
                    <div class="cell-sub">${m.username ? '@' + esc(m.username) : 'No username'}</div>
                  </td>
                  <td data-label="Telegram ID" class="mono">${esc(m.userId)}</td>
                  <td data-label="Plan">${esc(m.planName)}</td>
                  <td data-label="Start" class="num">${esc(formatDate(m.startedAt))}</td>
                  <td data-label="Expiry" class="num">${m.expiresAt ? esc(formatDateTime(m.expiresAt)) : 'Lifetime'}</td>
                  <td data-label="Days Left" class="col-right num">${m.daysRemaining === null ? '∞' : Number(m.daysRemaining) + ' days'}</td>
                  <td data-label="Status"><span class="${m.status === 'active' && (m.daysRemaining === null || m.daysRemaining > 0) ? 'status-ok' : 'status-warn'}">${m.daysRemaining === null ? 'Lifetime' : m.daysRemaining > 0 ? 'Active' : 'Expired'}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderOwnerLinkAnalytics() {
  const d = state.data.ownerLinkAnalytics;
  if (state.loading && !d) return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  const rows = d?.rows || [];
  const totalViews = rows.reduce((sum, row) => sum + Number(row.views || 0), 0);
  const totalUnique = rows.reduce((sum, row) => sum + Number(row.uniqueViewers || 0), 0);
  const activeOpened = rows.filter((row) => Number(row.views || 0) > 0).length;
  return `
    <div class="page-header">
      <div>
        <h1>Link Analytics</h1>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <div class="kpi-label">Top Links</div>
        <div class="kpi-value">${Number(d?.total || 0).toLocaleString()}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Opens</div>
        <div class="kpi-value">${totalViews.toLocaleString()}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Viewers</div>
        <div class="kpi-value">${totalUnique.toLocaleString()}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Active</div>
        <div class="kpi-value">${activeOpened.toLocaleString()}</div>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div class="surface-title">Top Links</div>
      </div>
      ${rows.length === 0 ? `
        <div class="empty-state">
          <h3>No link opens yet</h3>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Link</th>
                <th>Type</th>
                <th class="col-right">Opens</th>
                <th class="col-right">Unique Viewers</th>
                <th>Top Viewers</th>
                <th>Last Opened</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td data-label="Link">
                    <div class="cell-primary">${esc(row.title || row.code)}</div>
                    <div class="cell-sub mono">${esc(row.code)} · ${esc(row.kind)}</div>
                  </td>
                  <td data-label="Type">${esc(row.type || row.kind)}</td>
                  <td data-label="Opens" class="col-right num">${Number(row.views || 0).toLocaleString()}</td>
                  <td data-label="Unique Viewers" class="col-right num">${Number(row.uniqueViewers || 0).toLocaleString()}</td>
                  <td data-label="Top Viewers">${(row.viewers || []).length ? (row.viewers || []).map((v) => `<div class="cell-sub"><strong>${esc([v.firstName, v.lastName].filter(Boolean).join(' ') || 'User')}</strong> ${v.username ? '@' + esc(v.username) : ''} · <span class="num">${Number(v.views || 0)} opens</span> <span class="mono">(${esc(v.userId)})</span></div>`).join('') : '—'}</td>
                  <td data-label="Last Opened" class="num">${esc(formatDateTime(row.lastOpened))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function renderActiveView() {
  switch (state.activeView) {
    case 'overview': return renderOverview();
    case 'setup': return renderSetupBots();
    case 'links': return renderLinks();
    case 'shorteners': return renderShorteners();
    case 'channels': return renderChannels();
    case 'plans': return renderPlans();
    case 'wallet': return renderWallet();
    case 'broadcasts': return renderBroadcasts();
    case 'users': return renderUserDirectory();
    case 'premium_members': return renderPremiumDirectory();
    case 'token': return renderTokenSettings();
    case 'owner_kpis': return renderOwnerKpis();
    case 'owner_bots': return renderOwnerBots();
    case 'owner_withdrawals': return renderOwnerWithdrawals();
    case 'owner_payments': return renderOwnerPayments();
    case 'owner_link_analytics': return renderOwnerLinkAnalytics();
    case 'owner_delivery': return renderOwnerDelivery();
    default: return renderOverview();
  }
}

function renderWorkspace() {
  const sections = getNavSections();
  const botLink = state.botUsername ? safeHttpsUrl(`https://t.me/${state.botUsername}`) : '';
  const displayName = state.user.firstName || state.user.username || `User ${state.user.userId}`;
  const avatarInitial = String(displayName).trim().charAt(0).toUpperCase() || 'F';

  appEl.innerHTML = `
    <div class="drawer-overlay ${state.mobileNavOpen ? 'open' : ''}" id="drawer-overlay"></div>
    <div class="workspace ${state.sidebarCollapsed ? 'sidebar-collapsed' : ''}">
      <aside class="sidebar ${state.mobileNavOpen ? 'open' : ''}">
        <div class="sidebar-brand">
          <span class="brand-mark">
            ${BRAND_LOGO_SVG}
            <span class="brand-stack">
              <span>Filestore-adv</span>
              <span class="brand-sub">${state.user.isOwner ? 'Owner Panel' : 'Creator Panel'}</span>
            </span>
          </span>
          <button type="button" class="btn btn-sm btn-ghost mobile-menu-btn" id="btn-close-nav">Close</button>
        </div>

        ${sections.map((sec) => `
          <div class="sidebar-section">
            <div class="sidebar-section-label">${esc(sec.title)}</div>
            <div class="nav-list">
              ${sec.items.map((item) => `
                <button type="button" class="nav-item ${state.activeView === item.id ? 'active' : ''}" data-nav="${item.id}">
                  <span class="nav-item-left">
                    ${NAV_ICONS[item.id] || ''}
                    <span>${esc(item.label)}</span>
                  </span>
                  ${item.count !== null && item.count !== undefined ? `<span class="nav-count">${item.count}</span>` : ''}
                </button>
              `).join('')}
            </div>
          </div>
        `).join('')}

        <div class="sidebar-footer">
          ${botLink ? `<a class="btn btn-sm" href="${esc(botLink)}" target="_blank" rel="noopener noreferrer">Open @${esc(state.botUsername)}</a>` : ''}
          <button type="button" class="btn btn-sm btn-danger sidebar-lock-btn" id="btn-sidebar-lock">
            ${HEADER_ICONS.logout}
            <span>Lock / Logout</span>
          </button>
          <div class="sidebar-copyright">FileStore Control Panel</div>
        </div>
      </aside>

      <div class="main-col">
        <header class="topbar">
          <div class="topbar-left">
            <button type="button" class="icon-btn" id="btn-open-nav" aria-label="Open menu" title="Toggle menu">
              ${HEADER_ICONS.dots}
            </button>
            <span class="brand-mark">${BRAND_LOGO_SVG}<span>Filestore-adv</span></span>
          </div>
          <div class="topbar-actions">
            <button type="button" class="icon-btn" id="btn-refresh" aria-label="Refresh view" title="Refresh">
              ${HEADER_ICONS.refresh}
            </button>
            <button type="button" class="icon-btn" id="btn-theme" aria-label="Toggle dark or light theme" title="${state.theme === 'dark' ? 'Switch to Light theme' : 'Switch to Dark theme'}">
              ${state.theme === 'dark' ? HEADER_ICONS.sun : HEADER_ICONS.moon}
            </button>
            <button type="button" class="account-pill" data-nav="token" title="Manage Access Token">
              <span class="account-avatar">${esc(avatarInitial)}</span>
              <span>${esc(displayName)}</span>
              <span class="account-pill-meta">· ${state.user.isOwner ? 'Owner' : 'Creator'}</span>
            </button>
          </div>
        </header>

        <main class="content">
          ${state.error ? `<div class="inline-error" style="margin-bottom:12px;">${esc(state.error)}</div>` : ''}
          ${renderActiveView()}
        </main>
      </div>
    </div>

    <nav class="mobile-bottom-nav" aria-label="Mobile Navigation">
      <button type="button" class="mobile-nav-btn ${state.activeView === 'overview' ? 'active' : ''}" data-nav="overview">
        ${NAV_ICONS.overview}<span>Home</span>
      </button>
      <button type="button" class="mobile-nav-btn ${state.activeView === 'setup' ? 'active' : ''}" data-nav="setup">
        ${NAV_ICONS.setup}<span>Bots</span>
      </button>
      <button type="button" class="mobile-nav-btn ${state.activeView === 'links' ? 'active' : ''}" data-nav="links">
        ${NAV_ICONS.links}<span>Links</span>
      </button>
      <button type="button" class="mobile-nav-btn ${state.activeView === 'wallet' ? 'active' : ''}" data-nav="wallet">
        ${NAV_ICONS.wallet}<span>Wallet</span>
      </button>
      <button type="button" class="mobile-nav-btn ${state.mobileNavOpen ? 'active' : ''}" id="btn-mobile-more">
        ${HEADER_ICONS.dots}<span>Menu</span>
      </button>
    </nav>
  `;

  bindWorkspaceEvents();
}

function bindWorkspaceEvents() {
  document.getElementById('btn-theme')?.addEventListener('click', toggleTheme);
  document.getElementById('btn-refresh')?.addEventListener('click', () => loadViewData(state.activeView));
  document.getElementById('btn-sidebar-lock')?.addEventListener('click', () => lockPanel());
  document.getElementById('overview-days-select')?.addEventListener('change', (e) => {
    state.filters.overviewDays = Number(e.target.value) === 30 ? 30 : 7;
    loadViewData('overview');
  });
  document.getElementById('btn-open-nav')?.addEventListener('click', () => {
    if (window.innerWidth <= 860) {
      state.mobileNavOpen = !state.mobileNavOpen;
    } else {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    }
    render();
  });
  document.getElementById('btn-mobile-more')?.addEventListener('click', () => {
    state.mobileNavOpen = !state.mobileNavOpen;
    render();
  });
  document.getElementById('btn-close-nav')?.addEventListener('click', () => { state.mobileNavOpen = false; render(); });
  document.getElementById('drawer-overlay')?.addEventListener('click', () => { state.mobileNavOpen = false; render(); });

  appEl.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => switchView(el.dataset.nav));
  });
  appEl.querySelectorAll('[data-refresh]').forEach((el) => {
    el.addEventListener('click', () => loadViewData(state.activeView));
  });
  appEl.querySelectorAll('[data-copy-url]').forEach((el) => {
    el.addEventListener('click', () => copyText(el.dataset.copyUrl, 'Copied to clipboard'));
  });

  // User and premium directory search/filter events
  const bindDirectorySearch = (inputId, view, buildUrl, saveValue) => {
    document.getElementById(inputId)?.addEventListener('input', (e) => {
      saveValue(e.target.value);
      clearTimeout(directorySearchTimer);
      const inputValue = e.target.value;
      directorySearchTimer = setTimeout(async () => {
        try {
          if (view === 'users') state.data.users = await api(buildUrl(inputValue));
          else state.data.premiumMembers = await api(buildUrl(inputValue));
          const focused = document.activeElement?.id === inputId;
          const cursor = focused ? document.getElementById(inputId)?.selectionStart : null;
          render();
          if (focused) {
            const next = document.getElementById(inputId);
            next?.focus();
            if (cursor !== null) next?.setSelectionRange(cursor, cursor);
          }
        } catch (err) { toast(err.message || 'Search failed.', true); }
      }, 300);
    });
  };
  bindDirectorySearch('users-search', 'users', (value) => {
    const params = new URLSearchParams({ q: value });
    if (state.filters.usersBotId) params.set('botId', state.filters.usersBotId);
    return `/api/panel/users?${params.toString()}`;
  }, (value) => { state.filters.usersSearch = value; });
  document.getElementById('btn-clear-user-bot-filter')?.addEventListener('click', () => {
    state.filters.usersBotId = '';
    state.filters.usersBotName = '';
    loadViewData('users');
  });

  // Owner All Delivery Bots search, filter, view, edit, and action events
  const loadBotsWithFilters = async (preserveInputFocus = false) => {
    const params = new URLSearchParams({
      q: state.filters.botsSearch.trim(),
      scope: state.filters.botsScope,
      status: state.filters.botsStatus,
    });
    const cursor = preserveInputFocus ? document.getElementById('bots-search')?.selectionStart : null;
    state.data.ownerBots = await api(`/api/panel/owner/bots?${params.toString()}`);
    render();
    if (preserveInputFocus) {
      const next = document.getElementById('bots-search');
      next?.focus();
      if (cursor !== null) next?.setSelectionRange(cursor, cursor);
    }
  };
  document.getElementById('bots-search')?.addEventListener('input', (e) => {
    state.filters.botsSearch = e.target.value;
    clearTimeout(directorySearchTimer);
    directorySearchTimer = setTimeout(() => {
      loadBotsWithFilters(true).catch((err) => toast(err.message || 'Search failed.', true));
    }, 300);
  });
  document.getElementById('bots-scope')?.addEventListener('change', (e) => {
    state.filters.botsScope = e.target.value;
    loadBotsWithFilters(false).catch((err) => toast(err.message || 'Filter failed.', true));
  });
  document.getElementById('bots-status')?.addEventListener('change', (e) => {
    state.filters.botsStatus = e.target.value;
    loadBotsWithFilters(false).catch((err) => toast(err.message || 'Filter failed.', true));
  });
  document.getElementById('btn-bots-back')?.addEventListener('click', () => {
    state.selectedBotId = null;
    state.data.ownerBotDetail = null;
    loadViewData('owner_bots');
  });
  appEl.querySelectorAll('[data-owner-slot-price]').forEach((el) => {
    el.addEventListener('click', () => {
      const cur = state.data.ownerBots?.botSlotSettings || { priceMinor: 9900, starsPrice: null };
      openModal({
        title: 'Extra Bot Slot Price',
        submitLabel: 'Save Price',
        bodyHtml: `
          <div class="form-grid">
            <div class="field">
              <label class="field-label">Extra Slot Price (INR)</label>
              <input class="input mono" name="price" type="number" min="1" step="0.01" value="${(Number(cur.priceMinor || 9900) / 100).toFixed(2)}" required />
            </div>
            <div class="field">
              <label class="field-label">Telegram Stars Price (XTR, optional)</label>
              <input class="input mono" name="starsPrice" type="number" min="0" step="1" placeholder="0 or blank to disable" value="${cur.starsPrice ? Number(cur.starsPrice) : ''}" />
            </div>
          </div>
        `,
        onSubmit: async ({ price, starsPrice }) => {
          const starsNum = starsPrice !== undefined && String(starsPrice).trim() !== '' ? Number(starsPrice) : 0;
          await api('/api/panel/owner/bot-slot-settings', {
            method: 'POST',
            body: { price, starsPrice: starsNum },
          });
          toast('Extra delivery bot slot price updated.');
          await loadViewData('owner_bots');
        },
      });
    });
  });

  appEl.querySelectorAll('[data-bot-view]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedBotId = Number(el.dataset.botView);
      state.data.ownerBotDetail = null;
      loadViewData('owner_bots');
    });
  });
  appEl.querySelectorAll('[data-bot-users]').forEach((el) => {
    el.addEventListener('click', () => {
      state.filters.usersBotId = el.dataset.botUsers;
      state.filters.usersBotName = el.dataset.botName || '';
      switchView('users');
    });
  });
  appEl.querySelectorAll('[data-bot-edit]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.botEdit);
      const bot = (state.data.ownerBotDetail?.bot?.id === id ? state.data.ownerBotDetail.bot : null)
        || (state.data.ownerBots?.rows || []).find((r) => Number(r.id) === id);
      if (!bot) return;
      openModal({
        title: `Edit @${bot.username} (#${bot.id})`,
        submitLabel: 'Save Changes',
        bodyHtml: `
          <div class="form-grid">
            <div class="field">
              <label class="field-label">Enabled</label>
              <select class="select" name="isEnabled">
                <option value="true" ${bot.isEnabled ? 'selected' : ''}>Enabled</option>
                <option value="false" ${!bot.isEnabled ? 'selected' : ''}>Disabled</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label">Priority (0–100000)</label>
              <input class="input mono" name="priority" type="number" min="0" max="100000" value="${Number(bot.priority ?? 10)}" required />
            </div>
            <div class="field">
              <label class="field-label">Role</label>
              <select class="select" name="role">
                <option value="">Keep current (${bot.role === 'primary' ? 'Primary' : 'Backup'})</option>
                ${bot.role !== 'primary' ? '<option value="primary">Promote to Primary</option>' : ''}
              </select>
            </div>
            <div class="field">
              <label class="field-label">Runtime Action</label>
              <select class="select" name="action">
                <option value="">No runtime change</option>
                <option value="restart">Restart Bot</option>
                <option value="resume">Resume / Start</option>
                <option value="pause">Pause Bot</option>
              </select>
            </div>
          </div>
        `,
        onSubmit: async (vals) => {
          const body = {
            isEnabled: vals.isEnabled === 'true',
            priority: Number(vals.priority),
          };
          if (vals.role === 'primary') body.role = 'primary';
          if (vals.action) body.action = vals.action;
          await api(`/api/panel/owner/bots/${id}`, { method: 'PATCH', body });
          toast(`Delivery bot @${bot.username} updated.`);
          await loadViewData('owner_bots');
        },
      });
    });
  });
  appEl.querySelectorAll('[data-bot-test]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.botTest;
      try {
        const res = await api(`/api/panel/owner/bots/${id}/test`, { method: 'POST' });
        const okCount = (res.checks || []).filter((c) => c.status === 'ok' || c.status === 'force_sub_admin_ok').length;
        toast(`@${res.bot?.username} reachable · ${okCount}/${(res.checks || []).length} channel checks passed`);
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-bot-action]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [id, action] = el.dataset.botAction.split(':');
      try {
        const body = action === 'primary' ? { role: 'primary' } : { action };
        await api(`/api/panel/owner/bots/${id}`, { method: 'PATCH', body });
        toast(`Bot #${id} ${action === 'primary' ? 'promoted to primary' : action + ' applied'}.`);
        await loadViewData('owner_bots');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-bot-remove]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.botRemove;
      const username = el.dataset.botName || `#${id}`;
      openModal({
        title: `Remove @${username}`,
        submitLabel: 'Remove Bot',
        bodyHtml: `<p>Stop and permanently remove <strong>@${esc(username)}</strong> (#${esc(id)})? Historical delivery logs remain intact.</p>`,
        onSubmit: async () => {
          await api(`/api/panel/owner/bots/${id}`, { method: 'DELETE' });
          toast(`Removed @${username}.`);
          state.selectedBotId = null;
          state.data.ownerBotDetail = null;
          await loadViewData('owner_bots');
        },
      });
    });
  });

  bindDirectorySearch('premium-search', 'premium_members', (value) => `/api/panel/premium-members?q=${encodeURIComponent(value)}&status=${encodeURIComponent(state.filters.premiumStatus)}`, (value) => { state.filters.premiumSearch = value; });
  document.getElementById('premium-status')?.addEventListener('change', async (e) => {
    state.filters.premiumStatus = e.target.value;
    try { state.data.premiumMembers = await api(`/api/panel/premium-members?q=${encodeURIComponent(state.filters.premiumSearch)}&status=${encodeURIComponent(state.filters.premiumStatus)}`); render(); }
    catch (err) { toast(err.message || 'Filter failed.', true); }
  });

  // Links view events
  appEl.querySelectorAll('[data-link-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      state.filters.linksTab = el.dataset.linkTab;
      render();
    });
  });
  const linkSearch = document.getElementById('links-search');
  if (linkSearch) {
    linkSearch.addEventListener('input', (e) => {
      state.filters.linksSearch = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const refreshed = document.getElementById('links-search');
      if (refreshed) { refreshed.focus(); refreshed.setSelectionRange(pos, pos); }
    });
  }
  appEl.querySelectorAll('[data-rename-link]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.renameLink;
      openModal({
        title: 'Rename Share Link',
        submitLabel: 'Save Title',
        bodyHtml: `<div class="field"><label class="field-label">New Title</label><input class="input" name="title" value="${esc(el.dataset.linkTitle || '')}" maxlength="120" required /></div>`,
        onSubmit: async ({ title }) => {
          await api(`/api/panel/links/share/${id}`, { method: 'PATCH', body: { title } });
          toast('Link renamed.');
          await loadViewData('links');
        },
      });
    });
  });
  appEl.querySelectorAll('[data-edit-paid-link]').forEach((el) => {
    el.addEventListener('click', () => {
      const [kind, id, minor, currency, ...titleParts] = el.dataset.editPaidLink.split(':');
      const title = titleParts.join(':');
      const currentPrice = (Number(minor || 0) / 100).toFixed(2);
      const isBatch = kind === 'paid_batch';
      openModal({
        title: isBatch ? 'Edit Paid Batch Link' : 'Edit Paid File Link',
        submitLabel: 'Save Changes',
        bodyHtml: `${isBatch ? `<div class="field"><label class="field-label">Link title</label><input class="input" name="title" value="${esc(title)}" maxlength="160" required /></div>` : ''}
          <div class="field"><label class="field-label">Price (${esc(currency || 'INR')})</label><input class="input" name="price" type="number" min="0.01" step="0.01" value="${currentPrice}" required /></div>`,
        onSubmit: async ({ title: nextTitle, price }) => {
          const priceMinor = Math.round(Number(price) * 100);
          const body = isBatch ? { title: nextTitle, priceMinor } : { priceMinor };
          await api(`/api/panel/links/${kind}/${id}`, { method: 'PATCH', body });
          toast('Link updated.');
          await loadViewData('links');
        },
      });
    });
  });
  appEl.querySelectorAll('[data-toggle-link]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [kind, id, en] = el.dataset.toggleLink.split(':');
      try {
        await api(`/api/panel/links/${kind}/${id}`, { method: 'PATCH', body: { isEnabled: en === '1' } });
        toast(en === '1' ? 'Link enabled.' : 'Link paused.');
        await loadViewData('links');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-delete-link]').forEach((el) => {
    el.addEventListener('click', () => {
      const [kind, id] = el.dataset.deleteLink.split(':');
      openModal({
        title: 'Delete Link',
        submitLabel: 'Delete',
        bodyHtml: `<p>Delete this link? Shared URLs will stop working.</p>`,
        onSubmit: async () => {
          await api(`/api/panel/links/${kind}/${id}`, { method: 'DELETE' });
          toast('Link deleted.');
          await loadViewData('links');
        },
      });
    });
  });

  document.getElementById('clean-unused-files-btn')?.addEventListener('click', () => {
    openModal({
      title: 'Clean Unused Files',
      submitLabel: 'Clean Files',
      bodyHtml: '<p>Remove all uploaded files not attached to active links?</p>',
      onSubmit: async () => {
        const res = await api('/api/panel/files/clean-unused', { method: 'POST' });
        toast(`Cleaned ${res.removedCount ?? 0} unused file(s).`);
        await loadViewData('links');
      },
    });
  });

  appEl.querySelectorAll('[data-delete-file]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.deleteFile;
      const name = el.dataset.fileName || id;
      openModal({
        title: 'Delete File',
        submitLabel: 'Delete',
        bodyHtml: `<p>Delete <strong>${esc(name)}</strong>?</p>`,
        onSubmit: async () => {
          await api(`/api/panel/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
          toast('File removed.');
          await loadViewData('links');
        },
      });
    });
  });

  // Setup & Delivery Bots events
  const openUnlockSlotModal = () => {
    const botsData = state.data.bots || {};
    const rawSlots = botsData.slots || {};
    const slots = {
      priceMinor: Number(rawSlots.priceMinor ?? 9900),
      usedSlots: Number(rawSlots.usedSlots ?? 1),
      totalSlots: Number(rawSlots.totalAllowed ?? (1 + Number(rawSlots.extraSlots ?? 0))),
      starsPrice: rawSlots.starsPrice ?? null,
    };
    const priceLabel = formatInrHero(slots.priceMinor || 9900);
    const walletAvail = Number(botsData.walletAvailableMinor || 0);
    const canWallet = walletAvail >= Number(slots.priceMinor || 0);
    const payMethods = botsData.paymentMethods || {};
    const starsUrl = payMethods.starsEnabled && botsData.mainBotUsername
      ? safeHttpsUrl(`https://t.me/${botsData.mainBotUsername}?start=botslot`)
      : '';

    closeModal();
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-modal-close="1">
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-header">
            <h3>Unlock +1 Bot Slot</h3>
            <button type="button" class="btn btn-sm btn-ghost" data-modal-close="1">Close</button>
          </div>
          <div class="modal-body" id="slot-checkout-body">
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">New Limit</span>
                <span class="kv-val mono">${Number(slots.totalSlots || 1)} → ${Number(slots.totalSlots || 1) + 1} bots</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Price</span>
                <span class="kv-val mono">${esc(priceLabel)} INR${slots.starsPrice ? ` · ${Number(slots.starsPrice)}★` : ''}</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Wallet</span>
                <span class="kv-val mono">${esc(formatInrHero(walletAvail))}</span>
              </div>
            </div>
            <div class="checkout-methods">
              ${canWallet
                ? `<button type="button" class="btn btn-primary" id="btn-slot-pay-wallet">Pay ${esc(priceLabel)} (Wallet)</button>`
                : ''}
              ${payMethods.fampayEnabled
                ? `<button type="button" class="btn ${canWallet ? '' : 'btn-primary'}" id="btn-slot-pay-upi">Pay ${esc(priceLabel)} (UPI QR)</button>`
                : ''}
              ${starsUrl
                ? `<a class="btn" href="${esc(starsUrl)}" target="_blank" rel="noopener noreferrer">Pay ${Number(slots.starsPrice)}★ in Telegram ↗</a>`
                : ''}
            </div>
            ${!canWallet && !payMethods.fampayEnabled && !starsUrl
              ? `<p class="status-warn">No gateway active and wallet balance is under ${esc(priceLabel)}.</p>`
              : ''}
            <div id="slot-upi-stage"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" data-modal-close="1">Close</button>
          </div>
        </div>
      </div>
    `;

    modalRoot.querySelectorAll('[data-modal-close]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target === el) closeModal();
      });
    });

    document.getElementById('btn-slot-pay-wallet')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api('/api/panel/bots/slots/checkout', { method: 'POST', body: { method: 'wallet' } });
        toast('Extra Delivery Bot slot unlocked! You can now connect another bot.');
        closeModal();
        await loadViewData('setup');
      } catch (err) {
        toast(err.message || 'Wallet payment failed.', true);
        btn.disabled = false;
      }
    });

    document.getElementById('btn-slot-pay-upi')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const stage = document.getElementById('slot-upi-stage');
      btn.disabled = true;
      btn.textContent = 'Generating UPI QR…';
      try {
        const res = await api('/api/panel/bots/slots/checkout', { method: 'POST', body: { method: 'fampay' } });
        const upiHref = safeUpiUrl(res.upiUri);
        stage.innerHTML = `
          <div class="checkout-qr-card">
            <img class="checkout-qr-img" src="${esc(res.qrDataUrl)}" alt="UPI QR Code" />
            <div class="checkout-qr-meta">
              <div class="cell-primary">Pay exact amount: <span class="mono">₹${esc(res.amountDisplay)}</span></div>
              <div class="cell-sub">UPI ID: <span class="mono">${esc(res.upiId)}</span> · Ref: <span class="mono">${esc(res.txnRef)}</span></div>
            </div>
            <div class="row-actions">
              ${upiHref ? `<a class="btn btn-sm btn-primary" href="${esc(upiHref)}">Open UPI App</a>` : ''}
              <button type="button" class="btn btn-sm" id="btn-copy-slot-upi">Copy UPI ID</button>
            </div>
            <div class="field" style="width:100%;">
              <label class="field-label" for="slot-utr-input">Already paid? Enter 12-digit UTR (or wait for auto-verification)</label>
              <div style="display:flex;gap:8px;">
                <input id="slot-utr-input" class="input mono" placeholder="12-digit UTR (optional)" maxlength="24" />
                <button type="button" class="btn btn-primary" id="btn-verify-slot-upi">Verify</button>
              </div>
            </div>
            <div class="cell-sub" id="slot-upi-status">Waiting for UPI payment confirmation (checking automatically)…</div>
          </div>
        `;
        btn.style.display = 'none';

        document.getElementById('btn-copy-slot-upi')?.addEventListener('click', () => {
          copyText(res.upiId || '', 'UPI ID copied.');
        });

        const handlePaid = async () => {
          if (slotPollTimer) {
            clearInterval(slotPollTimer);
            slotPollTimer = null;
          }
          toast('Payment verified! Extra Delivery Bot slot unlocked.');
          closeModal();
          await loadViewData('setup');
        };

        document.getElementById('btn-verify-slot-upi')?.addEventListener('click', async () => {
          const verifyBtn = document.getElementById('btn-verify-slot-upi');
          const statusEl = document.getElementById('slot-upi-status');
          const utr = document.getElementById('slot-utr-input')?.value?.trim() || '';
          verifyBtn.disabled = true;
          try {
            const check = await api(`/api/panel/bots/slots/checkout/${res.sessionId}/verify`, {
              method: 'POST',
              body: utr ? { utr } : {},
            });
            if (check.paid) {
              await handlePaid();
              return;
            }
            if (statusEl) statusEl.textContent = `Current status: ${check.status}. Still waiting for confirmation…`;
          } catch (err) {
            toast(err.message || 'Verification failed.', true);
          } finally {
            verifyBtn.disabled = false;
          }
        });

        if (slotPollTimer) clearInterval(slotPollTimer);
        slotPollTimer = setInterval(async () => {
          try {
            const check = await api(`/api/panel/bots/slots/checkout/${res.sessionId}/status`);
            if (check.paid) {
              await handlePaid();
            } else if (check.status === 'expired' || check.status === 'failed') {
              clearInterval(slotPollTimer);
              slotPollTimer = null;
              const statusEl = document.getElementById('slot-upi-status');
              if (statusEl) statusEl.textContent = `Session ${check.status}. Close and start a fresh checkout.`;
            }
          } catch {}
        }, 5000);
      } catch (err) {
        toast(err.message || 'Failed to start UPI checkout.', true);
        btn.disabled = false;
        btn.textContent = `Pay ${priceLabel} via UPI QR`;
      }
    });
  };

  const openConnectBotModal = () => openModal({
    title: 'Connect Delivery Bot',
    submitLabel: 'Connect Bot',
    bodyHtml: `
      <p>Requires your own Storage Channel (both bots Admin).</p>
      <div class="field">
        <label class="field-label">@BotFather Token</label>
        <input class="input mono" name="token" type="password" placeholder="123456789:ABCdefGHIjklMNO..." autocomplete="off" required />
      </div>
    `,
    onSubmit: async ({ token }) => {
      try {
        const res = await api('/api/panel/bots', { method: 'POST', body: { token } });
        if (res.warning) {
          toast(res.warning, false);
        } else {
          toast(`Delivery bot @${res.bot?.username} connected.`);
        }
        await loadViewData('setup');
      } catch (err) {
        if (err.code === 'BOT_SLOT_LIMIT_REACHED') {
          toast('Slot limit reached — unlock an extra slot.', true);
          openUnlockSlotModal();
          return false;
        }
        throw err;
      }
    },
  });
  document.getElementById('btn-add-creator-bot')?.addEventListener('click', openConnectBotModal);
  document.getElementById('btn-add-creator-bot-empty')?.addEventListener('click', openConnectBotModal);
  document.getElementById('btn-unlock-bot-slot')?.addEventListener('click', openUnlockSlotModal);
  document.getElementById('btn-unlock-bot-slot-inline')?.addEventListener('click', openUnlockSlotModal);

  appEl.querySelectorAll('[data-cbot-replace]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.cbotReplace;
      const oldName = el.dataset.cbotName || `#${id}`;
      openModal({
        title: `Change Bot (@${oldName})`,
        submitLabel: 'Replace Bot',
        bodyHtml: `
          <p>Replaces <strong>@${esc(oldName)}</strong> in place — all links stay active. Make the new bot Admin in your channels.</p>
          <div class="field">
            <label class="field-label">New @BotFather Token</label>
            <input class="input mono" name="token" type="password" placeholder="123456789:ABCdefGHIjklMNO..." autocomplete="off" required />
          </div>
        `,
        onSubmit: async ({ token }) => {
          const res = await api(`/api/panel/bots/${id}/replace`, { method: 'POST', body: { token } });
          if (res.warning) {
            toast(res.warning, false);
          } else {
            toast(`Bot switched to @${res.bot?.username}. All existing links remain active!`);
          }
          await loadViewData('setup');
        },
      });
    });
  });

  appEl.querySelectorAll('[data-cbot-start]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.cbotStart;
      const botName = el.dataset.cbotName || `#${id}`;
      let cfg;
      try {
        cfg = await api(`/api/panel/bots/${id}/start-message`);
      } catch (err) {
        toast(err.message || 'Could not load start message settings.', true);
        return;
      }

      let imageMode = cfg.imageMode || 'none'; // 'none' | 'upload' | 'url'
      let uploadedDataUrl = '';
      let previewUrl = safeImagePreviewUrl(cfg.imagePreviewUrl || '');
      let urlValue = cfg.imageUrl || '';
      let hasExistingUpload = cfg.imageMode === 'upload' && Boolean(previewUrl);

      closeModal();
      modalRoot.innerHTML = `
        <div class="modal-backdrop" data-modal-close="1">
          <div class="modal-box" role="dialog" aria-modal="true">
            <div class="modal-header">
              <h3>Custom /start · @${esc(botName)}</h3>
              <button type="button" class="btn btn-sm btn-ghost" data-modal-close="1">Close</button>
            </div>
            <form id="start-msg-form">
              <div class="modal-body">
                <div class="field">
                  <label class="field-label" for="start-msg-text">Start Message</label>
                  <textarea id="start-msg-text" class="textarea" name="startMessage" maxlength="4096" placeholder="Welcome {first_name}! Open a valid link or tap a command below.">${esc(cfg.startMessage || '')}</textarea>
                  <div class="start-msg-meta">
                    <span>Variables: <span class="mono">{first_name}</span>, <span class="mono">{username}</span>, <span class="mono">{bot_name}</span></span>
                    <span id="start-msg-counter" class="mono">0 / 4096</span>
                  </div>
                </div>

                <div class="field">
                  <label class="field-label">Start Image (optional)</label>
                  <div class="segmented" id="start-img-tabs">
                    <button type="button" class="seg-btn" data-img-mode="none">None</button>
                    <button type="button" class="seg-btn" data-img-mode="upload">Upload</button>
                    <button type="button" class="seg-btn" data-img-mode="url">Image URL</button>
                  </div>
                </div>

                <div class="field" id="start-img-upload-wrap" style="display:none;">
                  <input id="start-img-file" class="input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
                  <div class="cell-sub">PNG, JPG, WEBP, or GIF up to 2 MB.</div>
                </div>

                <div class="field" id="start-img-url-wrap" style="display:none;">
                  <input id="start-img-url" class="input mono" type="url" maxlength="1000" placeholder="https://example.com/banner.jpg" value="${esc(urlValue)}" />
                </div>

                <div class="start-preview-box" id="start-img-preview-box" style="display:none;">
                  <img class="start-preview-img" id="start-img-preview-el" alt="Start banner preview" />
                  <div class="start-preview-info">
                    <strong id="start-img-preview-title">Start Image</strong>
                    <span id="start-img-preview-sub"></span>
                    <div><button type="button" class="btn btn-sm btn-danger" id="btn-remove-start-img">Remove Image</button></div>
                  </div>
                </div>
              </div>
              <div class="modal-footer">
                ${cfg.hasCustomStartMessage ? '<button type="button" class="btn btn-danger" id="btn-reset-start-msg" style="margin-right:auto;">Reset Default</button>' : ''}
                <button type="button" class="btn" data-modal-close="1">Cancel</button>
                <button type="submit" class="btn btn-primary" id="btn-save-start-msg">Save Start Msg</button>
              </div>
            </form>
          </div>
        </div>
      `;

      const textEl = document.getElementById('start-msg-text');
      const counterEl = document.getElementById('start-msg-counter');
      const uploadWrap = document.getElementById('start-img-upload-wrap');
      const urlWrap = document.getElementById('start-img-url-wrap');
      const fileEl = document.getElementById('start-img-file');
      const urlEl = document.getElementById('start-img-url');
      const previewBox = document.getElementById('start-img-preview-box');
      const previewImg = document.getElementById('start-img-preview-el');
      const previewTitle = document.getElementById('start-img-preview-title');
      const previewSub = document.getElementById('start-img-preview-sub');

      const syncUi = () => {
        modalRoot.querySelectorAll('[data-img-mode]').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.imgMode === imageMode);
        });
        uploadWrap.style.display = imageMode === 'upload' ? '' : 'none';
        urlWrap.style.display = imageMode === 'url' ? '' : 'none';

        const activePreview = imageMode === 'upload'
          ? (uploadedDataUrl || (hasExistingUpload ? previewUrl : ''))
          : imageMode === 'url'
            ? safeImagePreviewUrl(urlEl.value)
            : '';

        if (activePreview) {
          previewBox.style.display = '';
          previewImg.src = activePreview;
          previewTitle.textContent = imageMode === 'upload'
            ? (uploadedDataUrl ? 'New Uploaded Image' : 'Saved Image')
            : 'Image URL Preview';
          previewSub.textContent = imageMode === 'upload'
            ? 'Sent with /start photo caption'
            : String(urlEl.value || '').slice(0, 60);
        } else {
          previewBox.style.display = 'none';
          previewImg.removeAttribute('src');
        }

        const hasImage = imageMode !== 'none' && Boolean(activePreview || (imageMode === 'url' && urlEl.value.trim()));
        const len = (textEl.value || '').length;
        const limit = hasImage ? 1024 : 4096;
        counterEl.textContent = hasImage ? `${len} / 1024 caption` : `${len} / 4096`;
        counterEl.className = len > limit ? 'mono status-warn' : 'mono';
      };

      previewImg.addEventListener('error', () => {
        if (imageMode === 'url') {
          previewSub.textContent = 'Preview could not load in browser (check direct https:// image link).';
        }
      });

      textEl.addEventListener('input', syncUi);
      urlEl.addEventListener('input', () => {
        urlValue = urlEl.value;
        syncUi();
      });

      modalRoot.querySelectorAll('[data-img-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          imageMode = btn.dataset.imgMode;
          syncUi();
        });
      });

      fileEl.addEventListener('change', () => {
        const file = fileEl.files?.[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
          toast('Image must be 2 MB or smaller.', true);
          fileEl.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const res = typeof reader.result === 'string' ? reader.result : '';
          if (!safeImagePreviewUrl(res)) {
            toast('Please choose a PNG, JPG, WEBP, or GIF image.', true);
            fileEl.value = '';
            return;
          }
          uploadedDataUrl = res;
          imageMode = 'upload';
          syncUi();
        };
        reader.readAsDataURL(file);
      });

      document.getElementById('btn-remove-start-img')?.addEventListener('click', () => {
        imageMode = 'none';
        uploadedDataUrl = '';
        previewUrl = '';
        hasExistingUpload = false;
        urlEl.value = '';
        fileEl.value = '';
        syncUi();
      });

      modalRoot.querySelectorAll('[data-modal-close]').forEach((node) => {
        node.addEventListener('click', (e) => {
          if (e.target === node) closeModal();
        });
      });

      document.getElementById('btn-reset-start-msg')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await api(`/api/panel/bots/${id}/start-message`, { method: 'DELETE' });
          toast(`Reset @${botName} to default /start message.`);
          closeModal();
          await loadViewData('setup');
        } catch (err) {
          toast(err.message || 'Reset failed.', true);
          btn.disabled = false;
        }
      });

      document.getElementById('start-msg-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const saveBtn = document.getElementById('btn-save-start-msg');
        const msgVal = textEl.value.trim();
        const body = { startMessage: msgVal };

        if (imageMode === 'none') {
          body.imageMode = 'none';
        } else if (imageMode === 'upload') {
          if (uploadedDataUrl) {
            body.imageMode = 'upload';
            body.imageDataUrl = uploadedDataUrl;
          } else if (hasExistingUpload) {
            body.imageMode = 'keep';
          } else {
            toast('Please choose an image file to upload, or switch image mode to None.', true);
            return;
          }
        } else if (imageMode === 'url') {
          const cleanUrl = urlEl.value.trim();
          if (!cleanUrl) {
            toast('Please enter an https:// image URL, or switch image mode to None.', true);
            return;
          }
          body.imageMode = 'url';
          body.imageUrl = cleanUrl;
        }

        saveBtn.disabled = true;
        try {
          await api(`/api/panel/bots/${id}/start-message`, { method: 'PUT', body });
          toast(
            !msgVal && body.imageMode === 'none'
              ? `Reset @${botName} to default /start message.`
              : `Custom /start saved for @${botName}!`,
          );
          closeModal();
          await loadViewData('setup');
        } catch (err) {
          toast(err.message || 'Could not save start message.', true);
          saveBtn.disabled = false;
        }
      });

      syncUi();
    });
  });

  appEl.querySelectorAll('[data-cbot-test]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        const res = await api(`/api/panel/bots/${el.dataset.cbotTest}/test`, { method: 'POST' });
        const okCount = (res.checks || []).filter((c) => c.status === 'ok' || c.status === 'force_sub_admin_ok').length;
        toast(`@${res.bot?.username} reachable · ${okCount}/${(res.checks || []).length} channel checks passed`);
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-cbot-action]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [id, action] = el.dataset.cbotAction.split(':');
      try {
        await api(`/api/panel/bots/${id}`, { method: 'PATCH', body: { action } });
        toast(`Bot #${id} updated.`);
        await loadViewData('setup');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-cbot-prio]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.cbotPrio;
      openModal({
        title: `Update Priority for Bot #${id}`,
        submitLabel: 'Save Priority',
        bodyHtml: `<div class="field"><label class="field-label">Priority (0–100000, lower runs first)</label><input class="input mono" name="priority" type="number" min="0" max="100000" value="${esc(el.dataset.cbotCurPrio || '10')}" required /></div>`,
        onSubmit: async ({ priority }) => {
          await api(`/api/panel/bots/${id}`, { method: 'PATCH', body: { priority: Number(priority) } });
          toast('Priority updated.');
          await loadViewData('setup');
        },
      });
    });
  });
  appEl.querySelectorAll('[data-cbot-del]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.cbotDel;
      const name = el.dataset.cbotName || `#${id}`;
      openModal({
        title: `Remove @${name}`,
        submitLabel: 'Remove Bot',
        bodyHtml: `<p>Stop and remove <strong>@${esc(name)}</strong> from your workspace?</p>`,
        onSubmit: async () => {
          await api(`/api/panel/bots/${id}`, { method: 'DELETE' });
          toast(`Removed @${name}.`);
          await loadViewData('setup');
        },
      });
    });
  });

  // Creator Broadcasts events
  document.getElementById('creator-broadcast-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const vals = Object.fromEntries(new FormData(form).entries());
      const res = await api('/api/panel/broadcasts', {
        method: 'POST',
        body: {
          deliveryBotId: Number(vals.deliveryBotId),
          messageText: vals.messageText,
          buttonText: vals.buttonText,
          buttonUrl: vals.buttonUrl,
        },
      });
      toast(`Broadcast #${res.id} queued for ${res.totalRecipients} recipient(s).`);
      await loadViewData('broadcasts');
    } catch (err) {
      toast(err.message || 'Broadcast failed.', true);
      submitBtn.disabled = false;
    }
  });
  appEl.querySelectorAll('[data-bc-act]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [id, action] = el.dataset.bcAct.split(':');
      try {
        await api(`/api/panel/broadcasts/${id}/${action}`, { method: 'POST' });
        toast(`Campaign #${id} ${action} applied.`);
        await loadViewData('broadcasts');
      } catch (err) { toast(err.message, true); }
    });
  });

  // Shorteners events
  document.getElementById('btn-toggle-cp')?.addEventListener('click', async () => {
    try {
      const next = !state.data.shorteners?.checkpointEnabled;
      await api('/api/panel/shorteners/checkpoint', { method: 'POST', body: { enabled: next } });
      toast(`Checkpoints turned ${next ? 'ON' : 'OFF'}.`);
      await loadViewData('shorteners');
    } catch (err) { toast(err.message, true); }
  });

  const openAddShortener = () => openModal({
    title: 'Add URL Shortener',
    submitLabel: 'Save Shortener',
    bodyHtml: `
      <div class="form-grid">
        <div class="field span-2">
          <label class="field-label">Base URL</label>
          <input class="input" name="baseUrl" placeholder="https://shrinkme.io" required />
        </div>
        <div class="field span-2">
          <label class="field-label">Custom API Endpoint (optional)</label>
          <input class="input mono" name="apiEndpoint" placeholder="Leave blank for default /api" />
        </div>
        <div class="field span-2">
          <label class="field-label">API Key</label>
          <input class="input mono" name="apiKey" type="password" placeholder="Paste provider API key" required />
        </div>
        <div class="field">
          <label class="field-label">Display Name (optional)</label>
          <input class="input" name="name" placeholder="Auto from domain" />
        </div>
        <div class="field">
          <label class="field-label">Unlock Duration (minutes)</label>
          <input class="input mono" name="durationMinutes" type="number" min="1" max="10080" value="1440" required />
        </div>
        <div class="field span-2">
          <label class="field-label">Rotation Priority (lower runs first)</label>
          <input class="input mono" name="priority" type="number" min="1" max="100000" value="100" required />
        </div>
      </div>
    `,
    onSubmit: async (vals) => {
      await api('/api/panel/shorteners', {
        method: 'POST',
        body: {
          name: vals.name,
          baseUrl: vals.baseUrl,
          apiEndpoint: vals.apiEndpoint || undefined,
          apiKey: vals.apiKey,
          durationMinutes: Number(vals.durationMinutes),
          priority: Number(vals.priority),
        },
      });
      toast('Shortener provider added.');
      await loadViewData('shorteners');
    },
  });
  document.getElementById('btn-add-shortener')?.addEventListener('click', openAddShortener);
  document.getElementById('btn-add-shortener-empty')?.addEventListener('click', openAddShortener);

  appEl.querySelectorAll('[data-test-short]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        const res = await api(`/api/panel/shorteners/${el.dataset.testShort}/test`, { method: 'POST' });
        toast(`API test passed${res.shortUrl ? `: ${res.shortUrl}` : '.'}`);
        await loadViewData('shorteners');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-toggle-short]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [id, en] = el.dataset.toggleShort.split(':');
      try {
        await api(`/api/panel/shorteners/${id}`, { method: 'PATCH', body: { isEnabled: en === '1' } });
        toast(en === '1' ? 'Shortener enabled.' : 'Shortener disabled.');
        await loadViewData('shorteners');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-edit-short]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.editShort);
      const p = (state.data.shorteners?.providers || []).find((row) => Number(row.id) === id);
      if (!p) return;
      openModal({
        title: `Edit ${p.name} (#${id})`,
        submitLabel: 'Save Changes',
        bodyHtml: `
          <div class="form-grid">
            <div class="field span-2"><label class="field-label">Display Name</label><input class="input" name="name" value="${esc(p.name)}" maxlength="60" required /></div>
            <div class="field span-2"><label class="field-label">Base URL</label><input class="input mono" name="baseUrl" value="${esc(p.baseUrl)}" required /></div>
            <div class="field span-2"><label class="field-label">API Endpoint (optional)</label><input class="input mono" name="apiEndpoint" value="${esc(p.apiEndpoint || '')}" placeholder="Leave blank for default /api" /></div>
            <div class="field span-2"><label class="field-label">New API Key (leave blank to keep existing)</label><input class="input mono" name="apiKey" type="password" placeholder="Keep current key" /></div>
            <div class="field"><label class="field-label">Duration (minutes)</label><input class="input mono" name="durationMinutes" type="number" min="1" max="10080" value="${Number(p.durationMinutes)}" required /></div>
            <div class="field"><label class="field-label">Priority</label><input class="input mono" name="priority" type="number" min="1" max="100000" value="${Number(p.priority)}" required /></div>
          </div>
        `,
        onSubmit: async (vals) => {
          const body = {
            name: vals.name,
            baseUrl: vals.baseUrl,
            apiEndpoint: vals.apiEndpoint,
            durationMinutes: Number(vals.durationMinutes),
            priority: Number(vals.priority),
          };
          if (vals.apiKey && vals.apiKey.trim()) body.apiKey = vals.apiKey.trim();
          await api(`/api/panel/shorteners/${id}`, { method: 'PATCH', body });
          toast('Shortener updated.');
          await loadViewData('shorteners');
        },
      });
    });
  });
  appEl.querySelectorAll('[data-del-short]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.delShort;
      openModal({
        title: 'Remove Shortener',
        submitLabel: 'Remove',
        bodyHtml: `<p>Remove shortener provider #${esc(id)}? Existing unlock sessions will remain valid until expiry.</p>`,
        onSubmit: async () => {
          await api(`/api/panel/shorteners/${id}`, { method: 'DELETE' });
          toast('Shortener removed.');
          await loadViewData('shorteners');
        },
      });
    });
  });

  // Channels events
  const mainHandle = state.data.channels?.mainBotUsername ? `@${state.data.channels.mainBotUsername}` : 'the Main Bot';
  const openAddStorage = () => openModal({
    title: 'Add Storage Channel',
    submitLabel: 'Save Channel',
    bodyHtml: `
      <p>Make <strong>${esc(mainHandle)}</strong> &amp; your Delivery Bot Admin (Post Messages) first.</p>
      <div class="field">
        <label class="field-label">Channel ID, @username, or t.me link</label>
        <input class="input mono" name="channelInput" placeholder="-1001234567890 or @mychannel" required />
      </div>
    `,
    onSubmit: async ({ channelInput }) => {
      const res = await api('/api/panel/channels/storage', { method: 'POST', body: { channelInput } });
      toast(`Storage channel "${res.channel?.title || 'channel'}" added.`);
      await loadViewData('channels');
    },
  });
  const openAddForceSub = () => openModal({
    title: 'Add Force-Sub Channel',
    submitLabel: 'Save Channel',
    bodyHtml: `
      <p>Make <strong>${esc(mainHandle)}</strong> &amp; your Delivery Bot Admin first.</p>
      <div class="form-grid">
        <div class="field span-2">
          <label class="field-label">Channel ID or @username</label>
          <input class="input mono" name="channelInput" placeholder="-1001234567890 or @mychannel" required />
        </div>
        <div class="field span-2">
          <label class="field-label">Join Link (optional for public)</label>
          <input class="input mono" name="joinUrl" placeholder="https://t.me/..." />
        </div>
      </div>
    `,
    onSubmit: async (vals) => {
      const res = await api('/api/panel/channels/force_sub', { method: 'POST', body: vals });
      toast(`Force-sub channel "${res.channel?.title || 'channel'}" added.`);
      await loadViewData('channels');
    },
  });
  document.getElementById('btn-add-storage')?.addEventListener('click', openAddStorage);
  document.getElementById('btn-add-storage-hdr')?.addEventListener('click', openAddStorage);
  document.getElementById('btn-add-storage-empty')?.addEventListener('click', openAddStorage);
  document.getElementById('btn-add-fsub')?.addEventListener('click', openAddForceSub);
  document.getElementById('btn-add-fsub-hdr')?.addEventListener('click', openAddForceSub);
  document.getElementById('btn-add-fsub-empty')?.addEventListener('click', openAddForceSub);

  document.getElementById('btn-toggle-fsub-global')?.addEventListener('click', async () => {
    try {
      const next = !state.data.channels?.forceSubEnabled;
      await api('/api/panel/channels/force-sub-global', { method: 'POST', body: { enabled: next } });
      toast(`Force-Sub turned ${next ? 'ON' : 'OFF'}.`);
      await loadViewData('channels');
    } catch (err) { toast(err.message, true); }
  });
  appEl.querySelectorAll('[data-storage-test]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        const res = await api(`/api/panel/channels/storage/${el.dataset.storageTest}/test`, { method: 'POST' });
        toast(`Verified storage access for ${res.title || el.dataset.storageTest}.`);
        await loadViewData('channels');
      } catch (err) { toast(err.message, true); await loadViewData('channels'); }
    });
  });
  appEl.querySelectorAll('[data-storage-primary]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        await api(`/api/panel/channels/storage/${el.dataset.storagePrimary}`, { method: 'PATCH', body: { isPrimary: true } });
        toast('Primary storage channel updated.');
        await loadViewData('channels');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-storage-toggle]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [id, en] = el.dataset.storageToggle.split(':');
      try {
        await api(`/api/panel/channels/storage/${id}`, { method: 'PATCH', body: { isEnabled: en === '1' } });
        toast('Storage channel updated.');
        await loadViewData('channels');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-storage-del]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        await api(`/api/panel/channels/storage/${el.dataset.storageDel}`, { method: 'DELETE' });
        toast('Storage channel removed.');
        await loadViewData('channels');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-fsub-test]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        const res = await api(`/api/panel/channels/force_sub/${el.dataset.fsubTest}/test`, { method: 'POST' });
        toast(`Verified force-sub access for ${res.title || el.dataset.fsubTest}.`);
        await loadViewData('channels');
      } catch (err) { toast(err.message, true); await loadViewData('channels'); }
    });
  });
  appEl.querySelectorAll('[data-fsub-toggle]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [id, en] = el.dataset.fsubToggle.split(':');
      try {
        await api(`/api/panel/channels/force_sub/${id}`, { method: 'PATCH', body: { isEnabled: en === '1' } });
        toast('Force-Sub channel updated.');
        await loadViewData('channels');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-fsub-del]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        await api(`/api/panel/channels/force_sub/${el.dataset.fsubDel}`, { method: 'DELETE' });
        toast('Force-Sub channel removed.');
        await loadViewData('channels');
      } catch (err) { toast(err.message, true); }
    });
  });

  // Plans events
  const openAddPlan = () => openModal({
    title: state.user?.isOwner ? 'Create Platform Premium Plan' : 'Create Creator Premium Plan',
    submitLabel: 'Create Plan',
    bodyHtml: `
      <div class="form-grid">
        <div class="field span-2"><label class="field-label">Plan Name</label><input class="input" name="name" placeholder="VIP Monthly" maxlength="60" required /></div>
        <div class="field"><label class="field-label">Price (INR)</label><input class="input mono" name="price" placeholder="99" required /></div>
        <div class="field"><label class="field-label">Duration (days)</label><input class="input mono" name="durationDays" type="number" min="1" max="3650" value="30" required /></div>
        <div class="field span-2"><label class="field-label">Telegram Stars Price (XTR, optional)</label><input class="input mono" name="starsPrice" type="number" min="0" max="100000000" placeholder="Leave blank if INR only" /></div>
      </div>
    `,
    onSubmit: async (vals) => {
      await api('/api/panel/plans', {
        method: 'POST',
        body: {
          name: vals.name,
          price: vals.price,
          currency: 'INR',
          durationDays: Number(vals.durationDays),
          starsPrice: vals.starsPrice !== '' ? Number(vals.starsPrice) : undefined,
        },
      });
      toast('Premium plan saved.');
      await loadViewData('plans');
    },
  });
  document.getElementById('btn-add-plan')?.addEventListener('click', openAddPlan);
  document.getElementById('btn-add-plan-empty')?.addEventListener('click', openAddPlan);

  appEl.querySelectorAll('[data-edit-plan]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.dataset.editPlan);
      const p = (state.data.plans?.plans || []).find((row) => Number(row.id) === id);
      if (!p) return;
      openModal({
        title: `Edit ${p.name}`,
        submitLabel: 'Save Plan',
        bodyHtml: `
          <div class="form-grid">
            <div class="field span-2"><label class="field-label">Plan Name</label><input class="input" name="name" value="${esc(p.name)}" maxlength="60" required /></div>
            <div class="field"><label class="field-label">Price (${esc(p.currency || 'INR')})</label><input class="input mono" name="price" value="${(Number(p.priceMinor || 0) / 100).toFixed(2)}" required /></div>
            <div class="field"><label class="field-label">Duration (days)</label><input class="input mono" name="durationDays" type="number" min="1" max="3650" value="${Number(p.durationDays)}" required /></div>
          </div>
        `,
        onSubmit: async (vals) => {
          await api(`/api/panel/plans/${id}`, {
            method: 'PATCH',
            body: { name: vals.name, price: vals.price, durationDays: Number(vals.durationDays) },
          });
          toast('Plan updated.');
          await loadViewData('plans');
        },
      });
    });
  });
  appEl.querySelectorAll('[data-plan-stars]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.planStars;
      openModal({
        title: `Telegram Stars Price (Plan #${id})`,
        submitLabel: 'Save Stars Price',
        bodyHtml: `
          <div class="field">
            <label class="field-label">Stars (XTR · enter 0 to remove)</label>
            <input class="input mono" name="stars" type="number" min="0" max="100000000" value="${esc(el.dataset.planCurStars || '0')}" required />
          </div>
        `,
        onSubmit: async ({ stars }) => {
          await api(`/api/panel/plans/${id}/stars`, { method: 'POST', body: { stars: Number(stars) } });
          toast('Telegram Stars price updated.');
          await loadViewData('plans');
        },
      });
    });
  });
  appEl.querySelectorAll('[data-toggle-plan]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [id, en] = el.dataset.togglePlan.split(':');
      try {
        await api(`/api/panel/plans/${id}`, { method: 'PATCH', body: { isEnabled: en === '1' } });
        toast('Plan updated.');
        await loadViewData('plans');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-del-plan]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.delPlan;
      openModal({
        title: 'Delete Plan',
        submitLabel: 'Delete Plan',
        bodyHtml: `<p>Delete plan #${esc(id)}? Existing active subscribers will keep their membership until expiry.</p>`,
        onSubmit: async () => {
          await api(`/api/panel/plans/${id}`, { method: 'DELETE' });
          toast('Plan deleted.');
          await loadViewData('plans');
        },
      });
    });
  });

  document.getElementById('btn-grant-premium')?.addEventListener('click', () => openModal({
    title: 'Grant Platform Premium',
    submitLabel: 'Grant Membership',
    bodyHtml: `
      <div class="form-grid">
        <div class="field"><label class="field-label">Telegram User ID</label><input class="input mono" name="userId" placeholder="123456789" required /></div>
        <div class="field"><label class="field-label">Plan ID</label><input class="input mono" name="planId" type="number" min="1" required /></div>
        <div class="field span-2"><label class="field-label">Override Days (optional)</label><input class="input mono" name="days" type="number" min="1" max="3650" placeholder="Leave blank for plan default" /></div>
      </div>
    `,
    onSubmit: async (vals) => {
      await api('/api/panel/owner/premium/grant', { method: 'POST', body: vals });
      toast('Premium membership granted.');
    },
  }));

  document.getElementById('btn-revoke-premium')?.addEventListener('click', () => openModal({
    title: 'Revoke Active Premium',
    submitLabel: 'Revoke Membership',
    bodyHtml: `<div class="field"><label class="field-label">Telegram User ID</label><input class="input mono" name="userId" placeholder="123456789" required /></div>`,
    onSubmit: async (vals) => {
      const res = await api('/api/panel/owner/premium/revoke', { method: 'POST', body: vals });
      toast(`Revoked ${res.revokedCount} active membership(s).`);
    },
  }));

  // Wallet events
  document.getElementById('btn-set-upi')?.addEventListener('click', () => openModal({
    title: 'Save Payout UPI ID',
    submitLabel: 'Save UPI ID',
    bodyHtml: `
      <div class="field">
        <label class="field-label">UPI Handle</label>
        <input class="input mono" name="upiId" value="${esc(state.data.wallet?.wallet?.upiId || '')}" placeholder="yourname@okaxis" required />
      </div>
    `,
    onSubmit: async ({ upiId }) => {
      await api('/api/panel/wallet/upi', { method: 'POST', body: { upiId } });
      toast('Payout UPI ID saved.');
      await loadViewData('wallet');
    },
  }));

  document.getElementById('btn-request-withdraw')?.addEventListener('click', () => {
    const w = state.data.wallet?.wallet;
    openModal({
      title: 'Request UPI Withdrawal',
      submitLabel: 'Submit Withdrawal',
      bodyHtml: `
        <p>Available balance: <strong class="mono">${esc(formatMoney(w?.availableMinor || 0, 'INR'))}</strong></p>
        <div class="field">
          <label class="field-label">Amount in INR (leave blank for full balance)</label>
          <input class="input mono" name="amount" placeholder="${((w?.availableMinor || 0) / 100).toFixed(2)}" />
        </div>
        <div class="field">
          <label class="field-label">Payout UPI ID</label>
          <input class="input mono" name="upiId" value="${esc(w?.upiId || '')}" placeholder="yourname@fam" required />
        </div>
      `,
      onSubmit: async (vals) => {
        await api('/api/panel/wallet/withdraw', { method: 'POST', body: vals });
        toast('Withdrawal request submitted.');
        await loadViewData('wallet');
      },
    });
  });

  // Token rotation event
  document.getElementById('btn-rotate-token')?.addEventListener('click', () => openModal({
    title: 'Regenerate Token',
    submitLabel: 'Generate New Token',
    bodyHtml: `<p>Immediately invalidates your current token everywhere.</p>`,
    onSubmit: async () => {
      const res = await api('/api/panel/token/regenerate', { method: 'POST' });
      state.token = res.token;
      state.user.tokenPrefix = res.tokenPrefix;
      state.user.rotatedAt = res.rotatedAt;
      state.freshRotatedToken = res.token;
      toast('New access token generated.');
      render();
    },
  }));

  // Owner Withdrawals events
  appEl.querySelectorAll('[data-wd-status]').forEach((el) => {
    el.addEventListener('click', () => {
      state.filters.withdrawalsStatus = el.dataset.wdStatus;
      loadViewData('owner_withdrawals');
    });
  });
  appEl.querySelectorAll('[data-wd-approve]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.wdApprove;
      openModal({
        title: `Approve Payout #${id}`,
        submitLabel: 'Mark Paid',
        bodyHtml: `
          <p>Confirm manual UPI transfer of <strong class="mono">${esc(el.dataset.wdAmt)}</strong> to <strong class="mono">${esc(el.dataset.wdUpi)}</strong>.</p>
          <div class="field"><label class="field-label">UTR / Payout Reference (optional)</label><input class="input mono" name="payoutReference" placeholder="UTR4192837465" /></div>
          <div class="field"><label class="field-label">Note (optional)</label><input class="input" name="adminNote" placeholder="Transferred via UPI" /></div>
        `,
        onSubmit: async (vals) => {
          await api(`/api/panel/owner/withdrawals/${id}/approve`, { method: 'POST', body: vals });
          toast(`Withdrawal #${id} marked paid.`);
          await loadViewData('owner_withdrawals');
        },
      });
    });
  });
  appEl.querySelectorAll('[data-wd-reject]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.wdReject;
      openModal({
        title: `Reject Payout #${id}`,
        submitLabel: 'Reject & Refund',
        bodyHtml: `
          <p>The locked amount will be refunded back to the creator's available wallet balance immediately.</p>
          <div class="field"><label class="field-label">Reason (optional)</label><input class="input" name="adminNote" placeholder="Invalid UPI handle" /></div>
        `,
        onSubmit: async (vals) => {
          await api(`/api/panel/owner/withdrawals/${id}/reject`, { method: 'POST', body: vals });
          toast(`Withdrawal #${id} rejected and refunded.`);
          await loadViewData('owner_withdrawals');
        },
      });
    });
  });

  // Owner Payments & Gateways events
  appEl.querySelectorAll('[data-pay-status]').forEach((el) => {
    el.addEventListener('click', () => {
      state.filters.paymentsStatus = el.dataset.payStatus;
      state.filters.paymentsSearch = '';
      loadViewData('owner_payments');
    });
  });
  document.getElementById('pay-search-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    state.filters.paymentsSearch = document.getElementById('pay-search-input')?.value || '';
    loadViewData('owner_payments');
  });
  appEl.querySelectorAll('[data-pay-reconcile]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        await api(`/api/panel/owner/payments/${el.dataset.payReconcile}/reconcile`, { method: 'POST' });
        toast(`Transaction #${el.dataset.payReconcile} reconciled.`);
        await loadViewData('owner_payments');
      } catch (err) { toast(err.message, true); }
    });
  });
  appEl.querySelectorAll('[data-gw-toggle]').forEach((el) => {
    el.addEventListener('click', async () => {
      const [gw, en] = el.dataset.gwToggle.split(':');
      try {
        await api(`/api/panel/owner/gateways/${gw}/toggle`, { method: 'POST', body: { enabled: en === '1' } });
        toast(`${gw} ${en === '1' ? 'enabled' : 'disabled'}.`);
        await loadViewData('owner_payments');
      } catch (err) { toast(err.message, true); }
    });
  });

  // Owner Delivery & Auto-Delete events
  document.getElementById('btn-set-autodel')?.addEventListener('click', () => openModal({
    title: 'Configure Global Auto-Delete',
    submitLabel: 'Save Policy',
    bodyHtml: `
      <div class="field">
        <label class="field-label">Delete Delay in Minutes (0 = OFF, 1–10080)</label>
        <input class="input mono" name="minutes" type="number" min="0" max="10080" value="${Number(state.data.ownerDashboard?.autoDeleteMinutes || 0)}" required />
      </div>
    `,
    onSubmit: async ({ minutes }) => {
      await api('/api/panel/owner/auto-delete', { method: 'POST', body: { minutes: Number(minutes) } });
      toast('Auto-delete policy updated.');
      await loadViewData('owner_delivery');
    },
  }));
  document.getElementById('btn-autodel-off')?.addEventListener('click', async () => {
    try {
      await api('/api/panel/owner/auto-delete', { method: 'POST', body: { minutes: 0 } });
      toast('Auto-delete turned OFF.');
      await loadViewData('owner_delivery');
    } catch (err) { toast(err.message, true); }
  });
  appEl.querySelectorAll('[data-retry-job]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        await api(`/api/panel/owner/jobs/${el.dataset.retryJob}/retry`, { method: 'POST' });
        toast(`Delivery job #${el.dataset.retryJob} requeued.`);
        await loadViewData('owner_delivery');
      } catch (err) { toast(err.message, true); }
    });
  });
}

function render() {
  if (!state.user || !state.token) {
    renderTokenGate();
  } else {
    renderWorkspace();
  }
}

(async function bootstrap() {
  document.documentElement.classList.add('dark');
  await loadMeta();
  render();
})();
