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
    links: null,
    shorteners: null,
    channels: null,
    plans: null,
    wallet: null,
    ownerDashboard: null,
    ownerWithdrawals: null,
    ownerPayments: null,
    users: null,
    premiumMembers: null,
    ownerLinkAnalytics: null,
  },
  filters: {
    linksTab: 'all',
    linksSearch: '',
    withdrawalsStatus: 'pending',
    paymentsStatus: 'all',
    paymentsSearch: '',
    usersSearch: '',
    premiumSearch: '',
    premiumStatus: 'all',
  },
  freshRotatedToken: null,
};

const appEl = document.getElementById('app');
const toastRoot = document.getElementById('toast-root');
const modalRoot = document.getElementById('modal-root');
let directorySearchTimer = null;

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

function formatMoney(minor, currency = 'INR') {
  const value = Number(minor || 0);
  const code = String(currency || 'INR').toUpperCase();
  if (code === 'XTR') return `${value} XTR`;
  return `${(value / 100).toFixed(2)} ${code}`;
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
      await onSubmit(Object.fromEntries(formData.entries()));
      closeModal();
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
    throw new Error(payload.error || `Request failed (${res.status})`);
  }
  return payload;
}

function lockPanel(notice = '') {
  state.token = '';
  state.user = null;
  state.freshRotatedToken = null;
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
      state.data.overview = await api('/api/panel/overview');
    } else if (view === 'links') {
      state.data.links = await api('/api/panel/links');
    } else if (view === 'shorteners') {
      state.data.shorteners = await api('/api/panel/shorteners');
    } else if (view === 'channels') {
      state.data.channels = await api('/api/panel/channels');
    } else if (view === 'plans') {
      state.data.plans = await api('/api/panel/plans');
    } else if (view === 'wallet') {
      state.data.wallet = await api('/api/panel/wallet');
    } else if (view === 'users') {
      const q = encodeURIComponent(state.filters.usersSearch.trim());
      state.data.users = await api(`/api/panel/users?q=${q}`);
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
  state.mobileNavOpen = false;
  if (view !== 'token') {
    loadViewData(view);
  } else {
    render();
  }
}

const NAV_ICONS = {
  overview: '<svg class="nav-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  links: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  shorteners: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  channels: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  plans: '<svg class="nav-icon" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  wallet: '<svg class="nav-icon" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M16 12h2"/></svg>',
  token: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
  owner_kpis: '<svg class="nav-icon" viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
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
    { id: 'links', label: 'Share & Paid Links', count: totalLinks },
    { id: 'shorteners', label: 'Shorteners', count: ov ? ov.counts?.totalShorteners : null },
    { id: 'channels', label: 'Channels', count: totalChannels },
    { id: 'plans', label: state.user?.isOwner ? 'Platform Plans' : 'My Premium Plans', count: ov ? ov.counts?.plans : null },
    { id: 'wallet', label: 'Wallet & Payouts', count: null },
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
        <span class="brand-mark"><span class="brand-glyph">FS</span><span>FileStore</span></span>
        <div class="topbar-actions">
          <button type="button" class="btn btn-sm" id="btn-theme">${state.theme === 'dark' ? 'Light Theme' : 'Dark Theme'}</button>
          ${botLink ? `<a class="btn btn-sm btn-primary" href="${esc(botLink)}" target="_blank" rel="noopener noreferrer">Open Telegram Bot</a>` : ''}
        </div>
      </header>
      <main class="gate-main">
        <div class="gate-grid">
          <section class="gate-intro">
            <h1>Token-authenticated control panel for FileStore</h1>
            <p class="gate-lead">
              Manage your share links, paid links, shorteners, channels, premium plans, and UPI payouts directly from your browser. Platform owners automatically unlock full operational controls.
            </p>
            <div class="step-list">
              <div class="step-item">
                <span class="step-num">01.</span>
                <div>
                  <div class="step-title">Generate your unique token in Telegram</div>
                  <div class="step-desc">Open ${botHandle} and send <span class="mono">/token</span> or tap Web Panel Token in your menu.</div>
                </div>
              </div>
              <div class="step-item">
                <span class="step-num">02.</span>
                <div>
                  <div class="step-title">Paste your token to unlock</div>
                  <div class="step-desc">No email, password, or signup required. Your token maps directly to your Creator or Owner role.</div>
                </div>
              </div>
              <div class="step-item">
                <span class="step-num">03.</span>
                <div>
                  <div class="step-title">Rotate or revoke anytime</div>
                  <div class="step-desc">Regenerating your token in Telegram or inside the panel invalidates all previous tokens immediately.</div>
                </div>
              </div>
            </div>
          </section>

          <section class="gate-panel">
            <h2>Enter Access Token</h2>
            <p class="gate-panel-sub">Paste the unique <span class="mono">fs_…</span> token generated by the bot.</p>
            <form id="token-auth-form" class="gate-form">
              <div class="field">
                <label class="field-label" for="token-input">Unique Access Token</label>
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
              <button type="submit" class="btn btn-primary" id="btn-unlock">Unlock Control Panel</button>
            </form>
            <div class="gate-footnote">
              Tokens are stored as one-way cryptographic hashes on the server and kept strictly in browser memory for this session. Closing or reloading the page locks the panel automatically.
            </div>
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

function renderOverview() {
  const d = state.data.overview;
  if (state.loading && !d) {
    return `<div class="surface"><div class="surface-body">${renderSkeletonRows(5)}</div></div>`;
  }
  if (!d) {
    return `<div class="surface"><div class="empty-state"><h3>Could not load overview</h3><p>${esc(state.error || 'Try refreshing the panel.')}</p><button class="btn btn-primary" data-refresh="1">Retry</button></div></div>`;
  }

  const totalLinks = (d.counts.shareLinks || 0) + (d.counts.paidLinks || 0);
  const ownerRow = d.ownerSummary
    ? `
      <div class="surface">
        <div class="surface-header">
          <div>
            <div class="surface-title">Platform Owner Summary</div>
            <div class="surface-meta">Live totals across all creators and buyers</div>
          </div>
          <button class="btn btn-sm btn-primary" data-nav="owner_withdrawals">Open Withdrawals (${d.ownerSummary.pendingWithdrawals})</button>
        </div>
        <div class="kpi-grid" style="border:none; border-radius:0; margin-bottom:0;">
          <div class="kpi-cell">
            <div class="kpi-label">Tracked Users</div>
            <div class="kpi-value">${d.ownerSummary.trackedUsers}</div>
          </div>
          <div class="kpi-cell">
            <div class="kpi-label">Active Premium</div>
            <div class="kpi-value">${d.ownerSummary.activePremium}</div>
          </div>
          <div class="kpi-cell">
            <div class="kpi-label">Applied Payments</div>
            <div class="kpi-value">${d.ownerSummary.paymentsApplied}</div>
          </div>
          <div class="kpi-cell">
            <div class="kpi-label">Recorded Revenue</div>
            <div class="kpi-value" style="font-size:18px;">${esc(formatRevenue(d.ownerSummary.revenueByCurrency))}</div>
          </div>
        </div>
      </div>
    `
    : '';

  return `
    <div class="page-header">
      <div>
        <h1>${d.isOwner ? 'Platform & Creator Overview' : 'Creator Overview'}</h1>
        <p class="page-sub">
          ${esc(state.user.firstName || state.user.username || `User ${state.user.userId}`)}
          · ${d.isOwner ? 'Platform Owner' : 'Creator'}
          · Delivery Bot ${d.deliveryBotUsername ? '@' + esc(d.deliveryBotUsername) : 'Shared default'}
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" data-nav="wallet">Wallet & Payouts</button>
        <button class="btn btn-primary" data-nav="links">Manage Links</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <div class="kpi-label">Available Balance</div>
        <div class="kpi-value">${esc(formatMoney(d.wallet.availableMinor, 'INR'))}</div>
        <div class="kpi-sub">Locked: ${esc(formatMoney(d.wallet.lockedMinor, 'INR'))}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Indexed Files</div>
        <div class="kpi-value">${d.counts.files}</div>
        <div class="kpi-sub">Upload media directly in Telegram</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Active Links</div>
        <div class="kpi-value">${totalLinks}</div>
        <div class="kpi-sub">${d.counts.shareLinks} free · ${d.counts.paidLinks} paid</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Shorteners</div>
        <div class="kpi-value">${d.counts.activeShorteners}/${d.counts.totalShorteners}</div>
        <div class="kpi-sub">Checkpoints: ${d.toggles.checkpointEnabled ? 'Enabled' : 'Off'}</div>
      </div>
    </div>

    ${ownerRow}

    <div class="two-col">
      <div class="surface">
        <div class="surface-header">
          <div>
            <div class="surface-title">Configuration Summary</div>
            <div class="surface-meta">Active routing & monetization controls</div>
          </div>
        </div>
        <div class="surface-body">
          <div class="kv-list">
            <div class="kv-row">
              <span class="kv-key">Storage Channels</span>
              <span class="kv-val num">${d.counts.storageChannels > 0 ? `${d.counts.storageChannels} connected` : 'Platform shared fallback'}</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Force-Sub Channels</span>
              <span class="kv-val">${d.counts.forceSubChannels} configured · <span class="${d.toggles.forceSubEnabled ? 'status-ok' : 'status-muted'}">${d.toggles.forceSubEnabled ? 'Active' : 'Off'}</span></span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Shortener Checkpoints</span>
              <span class="kv-val"><span class="${d.toggles.checkpointEnabled ? 'status-ok' : 'status-muted'}">${d.toggles.checkpointEnabled ? 'Active' : 'Off'}</span></span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Premium Plans</span>
              <span class="kv-val num">${d.counts.plans} configured</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Payout UPI ID</span>
              <span class="kv-val mono">${d.wallet.upiId ? esc(d.wallet.upiId) : 'Not configured'}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="surface">
        <div class="surface-header">
          <div>
            <div class="surface-title">Quick Actions</div>
            <div class="surface-meta">Direct shortcuts across your workspace</div>
          </div>
        </div>
        <div class="surface-body">
          <div class="shortcut-grid">
            <button type="button" class="shortcut-btn" data-nav="links">
              <span>Manage Share & Paid Links</span><span class="mono">→</span>
            </button>
            <button type="button" class="shortcut-btn" data-nav="shorteners">
              <span>Add or Rotate Shorteners</span><span class="mono">→</span>
            </button>
            <button type="button" class="shortcut-btn" data-nav="channels">
              <span>Storage & Force-Sub Channels</span><span class="mono">→</span>
            </button>
            <button type="button" class="shortcut-btn" data-nav="plans">
              <span>${d.isOwner ? 'Platform Premium Plans' : 'Creator Premium Plans'}</span><span class="mono">→</span>
            </button>
            <button type="button" class="shortcut-btn" data-nav="wallet">
              <span>Set UPI ID & Request Payout</span><span class="mono">→</span>
            </button>
            <button type="button" class="shortcut-btn" data-nav="token">
              <span>Inspect or Rotate Token</span><span class="mono">→</span>
            </button>
          </div>
        </div>
      </div>
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

  return `
    <div class="page-header">
      <div>
        <h1>My Links</h1>
        <p class="page-sub">Manage your generated links. Free and paid links are organized separately.</p>
      </div>
    </div>

    <div class="surface">
      <div class="toolbar">
        <div class="segmented" role="tablist">
          <button class="seg-btn ${tab === 'all' ? 'active' : ''}" data-link-tab="all">All (${all.length})</button>
          <button class="seg-btn ${tab === 'share' ? 'active' : ''}" data-link-tab="share">Free Links (${share.length})</button>
          <button class="seg-btn ${tab === 'paid' ? 'active' : ''}" data-link-tab="paid">Paid Links (${paidF.length + paidB.length})</button>
        </div>
        <input id="links-search" class="input search-input" type="search" placeholder="Search title or code…" value="${esc(state.filters.linksSearch)}" />
      </div>

      ${filtered.length === 0 ? `
        <div class="empty-state">
          <h3>No links found</h3>
          <p>Send media in the Telegram bot using /link, /Batch, or /plink to create free or paid links — they appear here immediately.</p>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Title & Code</th>
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
                  <td data-label="Title & Code">
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
      `}
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
        <p class="page-sub">Configure multiple shortener providers with automatic priority rotation and checkpoint duration.</p>
      </div>
      <div class="page-actions">
        <button class="btn" id="btn-toggle-cp">${cpOn ? 'Turn Checkpoints Off' : 'Turn Checkpoints On'}</button>
        <button class="btn btn-primary" id="btn-add-shortener">Add Shortener</button>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Configured Providers</div>
          <div class="surface-meta">
            Checkpoints: <span class="${cpOn ? 'status-ok' : 'status-muted'}">${cpOn ? 'Enabled' : 'Off'}</span> · ${providers.length} provider(s)
          </div>
        </div>
      </div>

      ${providers.length === 0 ? `
        <div class="empty-state">
          <h3>No URL shorteners added yet</h3>
          <p>Connect one or more shorteners (e.g. ShrinkMe, GPLinks, ShrinkEarn) to monetize free share links with rotating checkpoints.</p>
          <button class="btn btn-primary" id="btn-add-shortener-empty">Add First Shortener</button>
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
                <th>Status</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${providers.map((p) => `
                <tr>
                  <td data-label="Provider"><div><div class="cell-primary">${esc(p.name)}</div><div class="cell-sub mono">#${p.id}</div></div></td>
                  <td data-label="Base URL" class="mono" style="font-size:12.5px;">${esc(p.baseUrl)}</td>
                  <td data-label="Duration" class="col-right mono">${p.durationMinutes} min</td>
                  <td data-label="Priority" class="col-right mono">${p.priority}</td>
                  <td data-label="Status"><span class="${p.isEnabled ? 'status-ok' : 'status-muted'}">${p.isEnabled ? 'Enabled' : 'Disabled'}</span></td>
                  <td data-label="Actions" class="col-right">
                    <div class="row-actions">
                      <button class="btn btn-sm" data-toggle-short="${p.id}:${p.isEnabled ? '0' : '1'}">${p.isEnabled ? 'Disable' : 'Enable'}</button>
                      <button class="btn btn-sm" data-edit-short="${p.id}" data-short-prio="${p.priority}" data-short-dur="${p.durationMinutes}">Edit</button>
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

  return `
    <div class="page-header">
      <div>
        <h1>Storage & Force-Sub Channels</h1>
        <p class="page-sub">Manage your connected Telegram storage channels and subscription gates. Add new channels directly via the bot so Telegram permissions can be verified live.</p>
      </div>
      <div class="page-actions">
        <button class="btn" id="btn-toggle-fsub-global">${fsubOn ? 'Turn Force-Sub Off' : 'Turn Force-Sub On'}</button>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Storage Channels</div>
          <div class="surface-meta">${storage.length} configured · Add new channels in Telegram with /storage_add</div>
        </div>
      </div>
      ${storage.length === 0 ? `
        <div class="empty-state">
          <h3>Using platform shared storage fallback</h3>
          <p>To host files in your own private Telegram channel, add the bot as Administrator in your channel and run /storage_add in Telegram.</p>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Chat ID</th>
                <th>Role</th>
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
                  <td data-label="Status"><span class="${c.isEnabled ? 'status-ok' : 'status-muted'}">${c.isEnabled ? 'Enabled' : 'Disabled'}</span></td>
                  <td data-label="Actions" class="col-right">
                    <div class="row-actions">
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
          <div class="surface-title">Force-Sub Channels</div>
          <div class="surface-meta">Force-Sub gate: <span class="${fsubOn ? 'status-ok' : 'status-muted'}">${fsubOn ? 'Enabled' : 'Off'}</span> · Add channels in Telegram with /force_sub_add</div>
        </div>
      </div>
      ${fsub.length === 0 ? `
        <div class="empty-state">
          <h3>No force-sub channels configured</h3>
          <p>Require subscribers to join your Telegram channel before unlocking your shared files by adding a channel via /force_sub_add in the bot.</p>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Join Link</th>
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
                    <td data-label="Status"><span class="${c.isEnabled ? 'status-ok' : 'status-muted'}">${c.isEnabled ? 'Enabled' : 'Disabled'}</span></td>
                    <td data-label="Actions" class="col-right">
                      <div class="row-actions">
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
        <h1>${isOwner ? 'Platform Premium Plans & Grants' : 'My Premium Membership Plans'}</h1>
        <p class="page-sub">
          ${isOwner
            ? 'Manage platform-wide ad-free plans and manually grant or revoke user memberships.'
            : 'Offer custom VIP tiers so buyers skip your URL shorteners. Payments settle into your creator wallet.'}
        </p>
      </div>
      <div class="page-actions">
        ${isOwner ? `<button class="btn" id="btn-grant-premium">Grant Premium</button><button class="btn" id="btn-revoke-premium">Revoke Premium</button>` : ''}
        ${d?.checkoutLink ? `<button class="btn" data-copy-url="${esc(d.checkoutLink)}">Copy Checkout Link</button>` : ''}
        <button class="btn btn-primary" id="btn-add-plan">Create Plan</button>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">${isOwner ? 'Platform Plans' : 'Your Creator Plans'}</div>
          <div class="surface-meta">${plans.length} plan(s) · Premium bypasses free URL-shortener checkpoints only</div>
        </div>
      </div>

      ${plans.length === 0 ? `
        <div class="empty-state">
          <h3>No Premium plans yet</h3>
          <p>Create your first membership tier so subscribers can pay once and skip shortener ads automatically.</p>
          <button class="btn btn-primary" id="btn-add-plan-empty">Create First Plan</button>
        </div>
      ` : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Plan Name</th>
                <th class="col-right">Price</th>
                <th class="col-right">Duration</th>
                <th>Status</th>
                <th class="col-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${plans.map((p) => `
                <tr>
                  <td data-label="Plan Name"><div><div class="cell-primary">${esc(p.name)}</div><div class="cell-sub mono">Plan #${p.id}</div></div></td>
                  <td data-label="Price" class="col-right mono">${esc(formatMoney(p.priceMinor, p.currency))}</td>
                  <td data-label="Duration" class="col-right mono">${p.durationDays} days</td>
                  <td data-label="Status"><span class="${p.isEnabled ? 'status-ok' : 'status-muted'}">${p.isEnabled ? 'Active' : 'Paused'}</span></td>
                  <td data-label="Actions" class="col-right">
                    <div class="row-actions">
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
        <h1>Wallet & UPI Payouts</h1>
        <p class="page-sub">Track earnings from your paid links and Creator Premium plans, and withdraw directly to your UPI ID.</p>
      </div>
      <div class="page-actions">
        <button class="btn" id="btn-set-upi">${w.upiId ? 'Update UPI ID' : 'Set Payout UPI ID'}</button>
        <button class="btn btn-primary" id="btn-request-withdraw" ${w.availableMinor < (d?.minWithdrawalMinor || 100) ? 'disabled' : ''}>Request Withdrawal</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <div class="kpi-label">Available Balance</div>
        <div class="kpi-value">${esc(formatMoney(w.availableMinor, 'INR'))}</div>
        <div class="kpi-sub">Min payout: ${esc(formatMoney(d?.minWithdrawalMinor || 100, 'INR'))}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Pending Payout Lock</div>
        <div class="kpi-value">${esc(formatMoney(w.lockedMinor, 'INR'))}</div>
        <div class="kpi-sub">Awaiting manual UPI transfer</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Total Earned</div>
        <div class="kpi-value">${esc(formatMoney(w.totalEarnedMinor, 'INR'))}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Total Withdrawn</div>
        <div class="kpi-value">${esc(formatMoney(w.totalWithdrawnMinor, 'INR'))}</div>
        <div class="kpi-sub mono">${w.upiId ? esc(w.upiId) : 'No UPI saved'}</div>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Withdrawal History</div>
          <div class="surface-meta">Manual transfers processed by the platform owner</div>
        </div>
      </div>
      ${withdrawals.length === 0 ? `
        <div class="empty-state">
          <h3>No withdrawals requested yet</h3>
          <p>Save your UPI ID and request a payout anytime your available balance reaches ₹1.00 INR.</p>
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
        <div>
          <div class="surface-title">Recent Earnings & Ledger</div>
          <div class="surface-meta">Atomic wallet credits, holds, payouts, and refunds</div>
        </div>
      </div>
      ${ledger.length === 0 ? `
        <div class="empty-state">
          <h3>No wallet entries yet</h3>
          <p>Earnings from paid links (/plink) and your Creator Premium plans will be recorded here automatically.</p>
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
        <p class="page-sub">Your unique token authenticates you directly to this Web Control Panel without a password or signup.</p>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Active Token Status</div>
          <div class="surface-meta">Stored as a one-way SHA-256 hash on the server</div>
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
            <span class="kv-key">Workspace Role</span>
            <span class="kv-val">${state.user.isOwner ? 'Platform Owner' : 'Creator'}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Token Prefix</span>
            <span class="kv-val mono">${esc(state.user.tokenPrefix)}••••••••</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Last Rotated</span>
            <span class="kv-val num">${esc(formatDateTime(state.user.rotatedAt))}</span>
          </div>
        </div>

        ${state.freshRotatedToken ? `
          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-hairline);">
            <div class="field-label">New Unique Token (shown once — save it safely)</div>
            <div class="token-reveal">${esc(state.freshRotatedToken)}</div>
            <button class="btn btn-primary btn-sm" data-copy-url="${esc(state.freshRotatedToken)}">Copy New Token</button>
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
        <h1>Platform KPIs & Health</h1>
        <p class="page-sub">Live operational metrics across storage, delivery, premium memberships, and verified payments.</p>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <div class="kpi-label">Tracked Users</div>
        <div class="kpi-value">${s.trackedUsers}</div>
        <div class="kpi-sub">Active Premium: ${s.activePremium}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Indexed Files</div>
        <div class="kpi-value">${s.activeFiles}</div>
        <div class="kpi-sub">Paid links: ${s.paidFileLinks} · Batches: ${s.paidBatchLinks}</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Recorded Revenue</div>
        <div class="kpi-value" style="font-size:18px;">${esc(formatRevenue(s.revenueByCurrency))}</div>
        <div class="kpi-sub">${s.paymentsApplied} applied transactions</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-label">Database Latency</div>
        <div class="kpi-value">${h.latencyMs} ms</div>
        <div class="kpi-sub"><span class="${h.warnings?.length ? 'status-warn' : 'status-ok'}">${h.warnings?.length ? `${h.warnings.length} warning(s)` : 'Nominal'}</span></div>
      </div>
    </div>

    <div class="two-col">
      <div class="surface">
        <div class="surface-header"><div class="surface-title">Operational Counters</div></div>
        <div class="surface-body">
          <div class="kv-list">
            <div class="kv-row"><span class="kv-key">Delivery Pending / Processing</span><span class="kv-val mono">${h.stats.delivery_pending} / ${h.stats.delivery_processing}</span></div>
            <div class="kv-row"><span class="kv-key">Delivery Failed</span><span class="kv-val mono ${h.stats.delivery_failed > 0 ? 'status-danger' : ''}">${h.stats.delivery_failed}</span></div>
            <div class="kv-row"><span class="kv-key">Auto-Delete Due</span><span class="kv-val mono">${h.stats.deletions_due}</span></div>
            <div class="kv-row"><span class="kv-key">Payment Recovery Pending</span><span class="kv-val mono ${h.stats.payment_recovery_pending > 0 ? 'status-warn' : ''}">${h.stats.payment_recovery_pending}</span></div>
          </div>
        </div>
      </div>

      <div class="surface">
        <div class="surface-header"><div class="surface-title">Active Warnings</div></div>
        <div class="surface-body">
          ${h.warnings?.length ? `
            <div class="kv-list">
              ${h.warnings.map((w) => `<div class="kv-row"><span class="status-warn">${esc(w)}</span></div>`).join('')}
            </div>
          ` : `<p>All background queues and payment recovery checks are healthy.</p>`}
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
        <h1>Creator Withdrawals Queue</h1>
        <p class="page-sub">Transfer funds manually to the creator's UPI ID, then approve with UTR or reject to refund their wallet automatically.</p>
      </div>
    </div>

    <div class="surface">
      <div class="toolbar">
        <div class="segmented">
          ${['pending', 'paid', 'rejected', 'all'].map((st) => `
            <button class="seg-btn ${currentStatus === st ? 'active' : ''}" data-wd-status="${st}">${st[0].toUpperCase() + st.slice(1)}</button>
          `).join('')}
        </div>
        <span class="surface-meta num">${d?.total || 0} request(s)</span>
      </div>

      ${rows.length === 0 ? `
        <div class="empty-state">
          <h3>No ${esc(currentStatus)} withdrawal requests</h3>
          <p>When creators submit UPI withdrawal requests from /me or their web wallet, they will appear here for manual payout approval.</p>
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
                        <button class="btn btn-sm btn-primary" data-wd-approve="${w.id}" data-wd-upi="${esc(w.upiId)}" data-wd-amt="${esc(formatMoney(w.amountMinor, w.currency))}">Approve Paid</button>
                        <button class="btn btn-sm btn-danger" data-wd-reject="${w.id}">Reject</button>
                      </div>
                    ` : `<span class="status-muted">Processed</span>`}
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
        <h1>Payments & Gateways</h1>
        <p class="page-sub">Toggle active checkout gateways, search payment records, and reconcile verified transactions.</p>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Payment Gateways</div>
          <div class="surface-meta">Owner payout accounts for Premium plans and creator monetization</div>
        </div>
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
                <td data-label="Last Test" class="cell-sub">${esc(m.lastTestStatus || 'Not tested')}${m.lastTestError ? ' · ' + esc(m.lastTestError) : ''}</td>
                <td data-label="Actions" class="col-right">
                  ${(m.method === 'fampay' || m.method === 'telegram_stars') ? `
                    <button class="btn btn-sm" data-gw-toggle="${esc(m.method)}:${m.isEnabled ? '0' : '1'}">${m.isEnabled ? 'Disable' : 'Enable'}</button>
                  ` : `<span class="status-muted">Unavailable</span>`}
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
          <input id="pay-search-input" class="input search-input" type="search" placeholder="Search tx ID, user, or UTR…" value="${esc(state.filters.paymentsSearch)}" />
          <button class="btn btn-sm" type="submit">Search</button>
        </form>
      </div>

      ${rows.length === 0 ? `
        <div class="empty-state">
          <h3>No matching transactions</h3>
          <p>Completed FamPay UPI and Telegram Stars payments will appear here automatically.</p>
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
        <h1>Delivery Queue & Auto-Delete</h1>
        <p class="page-sub">Configure global message auto-delete timing and retry failed delivery jobs.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" id="btn-set-autodel">Configure Auto-Delete</button>
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Global Auto-Delete Policy</div>
          <div class="surface-meta">
            Current policy: <span class="${mins > 0 ? 'status-ok' : 'status-muted'}">${mins > 0 ? `Delete after ${mins} minute(s)` : 'Disabled'}</span>
          </div>
        </div>
        ${mins > 0 ? `<button class="btn btn-sm" id="btn-autodel-off">Turn Off</button>` : ''}
      </div>
    </div>

    <div class="surface">
      <div class="surface-header">
        <div>
          <div class="surface-title">Recent Delivery Jobs</div>
          <div class="surface-meta">Latest 15 queued and processed deliveries</div>
        </div>
      </div>
      ${jobs.length === 0 ? `
        <div class="empty-state">
          <h3>No delivery jobs recorded yet</h3>
          <p>When users request shared or paid files through your Delivery Bot, job statuses appear here.</p>
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

function renderUserDirectory() {
  const d=state.data.users;
  if(state.loading&&!d)return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  const rows=d?.rows||[];
  return `<div class="page-head"><div><h1>${state.user?.isOwner?'All Platform Users':'My Bot Users'}</h1><p class="page-subtitle">Telegram users tracked by your bot workspace.</p></div></div>
    <div class="surface"><div class="surface-header"><div class="surface-title">${d?.total??0} users</div><div class="input-row"><input class="input" id="users-search" placeholder="Search name, username or ID" value="${esc(state.filters.usersSearch)}"/></div></div>
    <div class="table-wrap"><table><thead><tr><th>User</th><th>Telegram ID</th><th>Joined</th><th>Last seen</th><th>Bots</th><th>Premium</th><th>Interactions</th><th>Status</th></tr></thead><tbody>
    ${rows.length?rows.map(u=>`<tr><td><strong>${esc([u.firstName,u.lastName].filter(Boolean).join(' ')||'Telegram User')}</strong><div class="cell-sub">${u.username?'@'+esc(u.username):'No username'}</div></td><td class="mono">${esc(u.userId)}</td><td>${esc(formatDate(u.joinedAt))}</td><td>${esc(formatDateTime(u.lastSeenAt))}</td><td>${esc((u.botNames||[]).join(', ')||'—')}</td><td><span class="${u.premiumActive?'status-ok':'status-muted'}">${u.premiumActive?'Premium':'Free'}</span></td><td class="num">${Number(u.interactions||0).toLocaleString()}</td><td><span class="${u.isBlocked?'status-danger':'status-ok'}">${u.isBlocked?'Blocked':'Active'}</span></td></tr>`).join(''):`<tr><td colspan="8"><div class="empty-state"><h3>No users found</h3><p>Users will appear as they interact with your bots.</p></div></td></tr>`}
    </tbody></table></div></div>`;
}
function renderPremiumDirectory() {
  const d=state.data.premiumMembers;
  if(state.loading&&!d)return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  const rows=d?.rows||[];
  return `<div class="page-head"><div><h1>${state.user?.isOwner?'Platform Premium Members':'My Premium Members'}</h1><p class="page-subtitle">Subscriptions, expiry dates and remaining days.</p></div></div>
    <div class="surface"><div class="surface-header"><div class="surface-title">${d?.total??0} memberships</div><div class="input-row"><input class="input" id="premium-search" placeholder="Search name, username or ID" value="${esc(state.filters.premiumSearch)}"/><select class="select" id="premium-status"><option value="all" ${state.filters.premiumStatus==='all'?'selected':''}>All</option><option value="active" ${state.filters.premiumStatus==='active'?'selected':''}>Active</option><option value="expired" ${state.filters.premiumStatus==='expired'?'selected':''}>Expired</option><option value="permanent" ${state.filters.premiumStatus==='permanent'?'selected':''}>Lifetime</option></select></div></div>
    <div class="table-wrap"><table><thead><tr><th>Member</th><th>Telegram ID</th><th>Plan</th><th>Start</th><th>Expiry</th><th>Days left</th><th>Status</th></tr></thead><tbody>
    ${rows.length?rows.map(m=>`<tr><td><strong>${esc([m.firstName,m.lastName].filter(Boolean).join(' ')||'Telegram User')}</strong><div class="cell-sub">${m.username?'@'+esc(m.username):'No username'}</div></td><td class="mono">${esc(m.userId)}</td><td>${esc(m.planName)}</td><td>${esc(formatDate(m.startedAt))}</td><td>${m.expiresAt?esc(formatDateTime(m.expiresAt)):'Lifetime'}</td><td class="num">${m.daysRemaining===null?'∞':Number(m.daysRemaining)+' days'}</td><td><span class="${m.status==='active'&& (m.daysRemaining===null||m.daysRemaining>0)?'status-ok':'status-warn'}">${m.daysRemaining===null?'Lifetime':m.daysRemaining>0?'Active':'Expired'}</span></td></tr>`).join(''):`<tr><td colspan="7"><div class="empty-state"><h3>No premium members</h3><p>Premium memberships will appear here.</p></div></td></tr>`}
    </tbody></table></div></div>`;
}

function renderOwnerLinkAnalytics() {
  const d=state.data.ownerLinkAnalytics;
  if(state.loading&&!d)return `<div class="surface">${renderSkeletonRows(6)}</div>`;
  const rows=d?.rows||[];
  const totalViews=rows.reduce((sum,row)=>sum+Number(row.views||0),0);
  return `<div class="page-header"><div><h1>Link Analytics</h1><p class="page-sub">Most opened links across the platform, with viewer-level open counts.</p></div></div>
    <div class="stats-grid"><div class="stat-card"><div class="stat-label">Top 100 Links</div><div class="stat-value">${(d?.total||0).toLocaleString()}</div></div><div class="stat-card"><div class="stat-label">Recorded Opens (Top 100)</div><div class="stat-value">${totalViews.toLocaleString()}</div></div></div>
    <div class="surface"><div class="surface-header"><div><div class="surface-title">Top Opened Links</div><div class="surface-meta">Sorted by recorded opens</div></div></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Link</th><th>Type</th><th class="col-right">Opens</th><th class="col-right">Unique viewers</th><th>Top viewers · opens</th><th>Last opened</th></tr></thead><tbody>
    ${rows.length?rows.map(row=>`<tr><td><div class="cell-primary">${esc(row.title||row.code)}</div><div class="cell-sub mono">${esc(row.code)} · ${esc(row.kind)}</div></td><td>${esc(row.type||row.kind)}</td><td class="col-right num">${Number(row.views||0).toLocaleString()}</td><td class="col-right num">${Number(row.uniqueViewers||0).toLocaleString()}</td><td>${(row.viewers||[]).length?(row.viewers||[]).map(v=>`<div class="cell-sub"><strong>${esc([v.firstName,v.lastName].filter(Boolean).join(' ')||'User')}</strong> ${v.username?'@'+esc(v.username):''} · <span class="num">${Number(v.views||0)} opens</span><br><span class="mono">${esc(v.userId)}</span></div>`).join(''):'—'}</td><td>${esc(formatDateTime(row.lastOpened))}</td></tr>`).join(''):`<tr><td colspan="6"><div class="empty-state"><h3>No link opens yet</h3><p>Open counts will appear after users open links through the delivery bot.</p></div></td></tr>`}
    </tbody></table></div></div>`;
}

function renderActiveView() {
  switch (state.activeView) {
    case 'overview': return renderOverview();
    case 'links': return renderLinks();
    case 'shorteners': return renderShorteners();
    case 'channels': return renderChannels();
    case 'plans': return renderPlans();
    case 'wallet': return renderWallet();
    case 'users': return renderUserDirectory();
    case 'premium_members': return renderPremiumDirectory();
    case 'token': return renderTokenSettings();
    case 'owner_kpis': return renderOwnerKpis();
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

  appEl.innerHTML = `
    <div class="drawer-overlay ${state.mobileNavOpen ? 'open' : ''}" id="drawer-overlay"></div>
    <div class="workspace ${state.sidebarCollapsed ? 'sidebar-collapsed' : ''}">
      <aside class="sidebar ${state.mobileNavOpen ? 'open' : ''}">
        <div class="sidebar-brand">
          <span class="brand-mark"><span class="brand-glyph">FS</span><span>Filestore-adv</span></span>
          <button type="button" class="btn btn-sm btn-ghost mobile-menu-btn" id="btn-close-nav">Close</button>
        </div>

        <div class="sidebar-account">
          <div class="account-name">${esc(state.user.firstName || state.user.username || `User ${state.user.userId}`)}</div>
          <div class="account-meta">${state.user.isOwner ? 'Platform Owner' : 'Creator Workspace'} · <span class="mono">${esc(state.user.tokenPrefix)}…</span></div>
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
        </div>
      </aside>

      <div class="main-col">
        <header class="topbar">
          <div class="topbar-left">
            <button type="button" class="icon-btn" id="btn-open-nav" aria-label="Open menu" title="Toggle menu">
              ${HEADER_ICONS.dots}
            </button>
            <span class="brand-mark"><span class="brand-glyph">FS</span><span>Filestore-adv</span></span>
          </div>
          <div class="topbar-actions">
            <button type="button" class="icon-btn" id="btn-refresh" aria-label="Refresh view" title="Refresh">
              ${HEADER_ICONS.refresh}
            </button>
            <button type="button" class="icon-btn" id="btn-theme" aria-label="Toggle dark or light theme" title="${state.theme === 'dark' ? 'Switch to Light theme' : 'Switch to Dark theme'}">
              ${state.theme === 'dark' ? HEADER_ICONS.sun : HEADER_ICONS.moon}
            </button>
          </div>
        </header>

        <main class="content">
          ${state.error ? `<div class="inline-error" style="margin-bottom:18px;">${esc(state.error)}</div>` : ''}
          ${renderActiveView()}
        </main>
      </div>
    </div>
  `;

  bindWorkspaceEvents();
}

function bindWorkspaceEvents() {
  document.getElementById('btn-theme')?.addEventListener('click', toggleTheme);
  document.getElementById('btn-refresh')?.addEventListener('click', () => loadViewData(state.activeView));
  document.getElementById('btn-sidebar-lock')?.addEventListener('click', () => lockPanel());
  document.getElementById('btn-open-nav')?.addEventListener('click', () => {
    if (window.innerWidth <= 860) {
      state.mobileNavOpen = !state.mobileNavOpen;
    } else {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    }
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
  bindDirectorySearch('users-search', 'users', (value) => `/api/panel/users?q=${encodeURIComponent(value)}`, (value) => { state.filters.usersSearch = value; });
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
        title: 'Delete Link Permanently',
        submitLabel: 'Delete Link',
        bodyHtml: `<p>Are you sure you want to permanently delete this link? Existing shared URLs will immediately stop working.</p>`,
        onSubmit: async () => {
          await api(`/api/panel/links/${kind}/${id}`, { method: 'DELETE' });
          toast('Link deleted.');
          await loadViewData('links');
        },
      });
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
      const id = el.dataset.editShort;
      openModal({
        title: `Edit Shortener #${id}`,
        submitLabel: 'Save Changes',
        bodyHtml: `
          <div class="form-grid">
            <div class="field"><label class="field-label">Duration (minutes)</label><input class="input mono" name="durationMinutes" type="number" min="1" max="10080" value="${esc(el.dataset.shortDur)}" required /></div>
            <div class="field"><label class="field-label">Priority</label><input class="input mono" name="priority" type="number" min="1" max="100000" value="${esc(el.dataset.shortPrio)}" required /></div>
          </div>
        `,
        onSubmit: async (vals) => {
          await api(`/api/panel/shorteners/${id}`, {
            method: 'PATCH',
            body: { durationMinutes: Number(vals.durationMinutes), priority: Number(vals.priority) },
          });
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
  document.getElementById('btn-toggle-fsub-global')?.addEventListener('click', async () => {
    try {
      const next = !state.data.channels?.forceSubEnabled;
      await api('/api/panel/channels/force-sub-global', { method: 'POST', body: { enabled: next } });
      toast(`Force-Sub turned ${next ? 'ON' : 'OFF'}.`);
      await loadViewData('channels');
    } catch (err) { toast(err.message, true); }
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
      </div>
    `,
    onSubmit: async (vals) => {
      await api('/api/panel/plans', {
        method: 'POST',
        body: { name: vals.name, price: vals.price, currency: 'INR', durationDays: Number(vals.durationDays) },
      });
      toast('Premium plan saved.');
      await loadViewData('plans');
    },
  });
  document.getElementById('btn-add-plan')?.addEventListener('click', openAddPlan);
  document.getElementById('btn-add-plan-empty')?.addEventListener('click', openAddPlan);

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
    title: 'Regenerate Access Token',
    submitLabel: 'Generate New Token',
    bodyHtml: `<p>Generating a new token immediately invalidates your current token everywhere. Your browser session will switch to the new token automatically.</p>`,
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
