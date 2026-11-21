import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getOperationalHealth } from './admin/operational-health.js';
import { handlePanelApiRequest } from './web/api-router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'web', 'public');

const ASSET_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
});

async function serveStaticFile(res, relativeName, cacheControl = 'no-cache') {
  let decoded;
  try {
    decoded = decodeURIComponent(String(relativeName || ''));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  const safeName = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, safeName);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const body = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': ASSET_CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

export function startHttpServer(state, logger) {
  const startedAt = Date.now();
  const port = state.port !== undefined && state.port !== null && Number.isInteger(Number(state.port))
    ? Number(state.port)
    : 3000;

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

    if (urlPath.startsWith('/api/panel/')) {
      return handlePanelApiRequest(req, res, state, logger);
    }

    if (req.method === 'GET' && urlPath.startsWith('/assets/')) {
      const assetName = urlPath.slice('/assets/'.length);
      return serveStaticFile(res, assetName, 'no-cache');
    }

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/panel')) {
      const accept = String(req.headers.accept || '');
      if (accept.includes('application/json') && !accept.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(buildSummary()));
        return;
      }
      return serveStaticFile(res, 'index.html', 'no-store');
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
