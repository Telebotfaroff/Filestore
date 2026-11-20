import http from 'node:http';
import { getOperationalHealth } from './admin/operational-health.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderStatusPage(status) {
  const missingItems = status.missingEnv.length
    ? status.missingEnv.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join('')
    : '<li>None — all required variables configured</li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FileStore — Telegram File Indexing &amp; Delivery Platform</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #0b101b;
      color: #e2e8f0;
      line-height: 1.5;
    }
    main {
      max-width: 760px;
      margin: 48px auto;
      padding: 0 20px;
    }
    .card {
      background: #131b2e;
      border: 1px solid #24304a;
      border-radius: 10px;
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    h1 { margin: 0 0 8px; font-size: 1.5rem; color: #f8fafc; }
    h2 { margin: 0 0 12px; font-size: 1.05rem; color: #cbd5e1; }
    p { margin: 0 0 12px; color: #94a3b8; }
    dl {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 8px 16px;
      margin: 0;
      font-size: 0.95rem;
    }
    dt { color: #94a3b8; }
    dd { margin: 0; color: #f1f5f9; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    ul { margin: 8px 0 0; padding-left: 20px; color: #cbd5e1; }
    code {
      background: #1e293b;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 600;
      background: #1e293b;
      color: #38bdf8;
    }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>FileStore</h1>
      <p>Telegram file indexing, access control, payments, and delivery platform.</p>
      <span class="badge">${escapeHtml(status.mode)}</span>
    </div>
    <div class="card">
      <h2>Runtime Status</h2>
      <dl>
        <dt>HTTP Server</dt><dd>Listening on 0.0.0.0:${escapeHtml(status.port)}</dd>
        <dt>Database</dt><dd>${escapeHtml(status.database)}${status.databaseError ? ` (${escapeHtml(status.databaseError)})` : ''}</dd>
        <dt>Main Bot</dt><dd>${escapeHtml(status.telegram)}${status.botUsername ? ` (@${escapeHtml(status.botUsername)})` : ''}${status.telegramError ? ` (${escapeHtml(status.telegramError)})` : ''}</dd>
        <dt>Delivery Bots</dt><dd>${escapeHtml(status.delivery)}${status.deliveryError ? ` (${escapeHtml(status.deliveryError)})` : ''}</dd>
        <dt>Environment</dt><dd>${escapeHtml(status.nodeEnv)}</dd>
        <dt>Uptime</dt><dd>${escapeHtml(status.uptimeSeconds)}s</dd>
      </dl>
    </div>
    <div class="card">
      <h2>Configuration</h2>
      <p>Missing environment variables for live Telegram &amp; PostgreSQL operation:</p>
      <ul>${missingItems}</ul>
    </div>
    <div class="card">
      <h2>HTTP Endpoints</h2>
      <ul>
        <li><code>GET /</code> — Service overview</li>
        <li><code>GET /health</code> — JSON health probe</li>
        <li><code>GET /api/status</code> — Operational status JSON</li>
      </ul>
    </div>
  </main>
</body>
</html>`;
}

export function startHttpServer(state, logger) {
  const startedAt = Date.now();
  const port = Number(state.port) || 3000;

  function buildSummary() {
    return {
      status: 'ok',
      app: 'filestore',
      mode: state.database === 'connected' && state.telegram === 'connected' ? 'live' : 'standby',
      nodeEnv: state.nodeEnv,
      port,
      database: state.database,
      databaseError: state.databaseError ?? null,
      telegram: state.telegram,
      botUsername: state.botUsername ?? null,
      telegramError: state.telegramError ?? null,
      delivery: state.delivery ?? 'standby',
      deliveryError: state.deliveryError ?? null,
      missingEnv: state.missingEnv ?? [],
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/health') {
      const payload = buildSummary();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/status') {
      const summary = buildSummary();
      let operational = null;
      if (state.pool && !state.pool.isMock) {
        try {
          operational = await getOperationalHealth(state.pool);
        } catch (error) {
          operational = { status: 'error', error: error.message };
        }
      } else {
        operational = {
          status: 'mocked',
          latencyMs: 0,
          stats: {
            delivery_pending: 0,
            delivery_processing: 0,
            delivery_failed: 0,
            deletions_due: 0,
            payment_recovery_pending: 0,
          },
          warnings: [],
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...summary, operational }));
      return;
    }

    if (req.method === 'GET' && urlPath === '/') {
      const summary = buildSummary();
      const accept = String(req.headers.accept || '');
      if (accept.includes('application/json') && !accept.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(summary));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderStatusPage(summary));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      logger.info({ host: '0.0.0.0', port }, 'FileStore HTTP server listening');
      resolve(server);
    });
  });
}
