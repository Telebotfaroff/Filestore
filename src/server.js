import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import { getOperationalHealth } from './admin/operational-health.js';
import { handlePanelApiRequest } from './web/api-router.js';

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'web', 'public');
const STATIC_CACHE = new Map();

const ASSET_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
});

const COMPRESSIBLE_EXTS = new Set(['.html', '.css', '.js', '.json', '.svg']);

async function loadStaticAsset(resolved) {
  const fileStat = await stat(resolved);
  const cachedEntry = STATIC_CACHE.get(resolved);
  if (cachedEntry && cachedEntry.mtimeMs === fileStat.mtimeMs && cachedEntry.size === fileStat.size) {
    return cachedEntry;
  }
  const raw = await readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const contentType = ASSET_CONTENT_TYPES[ext] || 'application/octet-stream';
  const etag = `"${createHash('sha1').update(raw).digest('base64url').slice(0, 16)}"`;
  let br = null;
  let gz = null;
  if (COMPRESSIBLE_EXTS.has(ext) && raw.length >= 512) {
    [br, gz] = await Promise.all([
      brotliCompressAsync(raw, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      }).catch(() => null),
      gzipAsync(raw, { level: 6 }).catch(() => null),
    ]);
  }
  const entry = { mtimeMs: fileStat.mtimeMs, size: fileStat.size, raw, br, gz, etag, contentType };
  STATIC_CACHE.set(resolved, entry);
  return entry;
}

async function serveStaticFile(req, res, relativeName, cacheControl = 'public, max-age=300, must-revalidate') {
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
    const asset = await loadStaticAsset(resolved);
    const baseHeaders = {
      'Content-Type': asset.contentType,
      'Cache-Control': cacheControl,
      'ETag': asset.etag,
      'Vary': 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    const ifNoneMatch = String(req.headers['if-none-match'] || '').trim();
    if (ifNoneMatch && (ifNoneMatch === asset.etag || ifNoneMatch === `W/${asset.etag}`)) {
      res.writeHead(304, baseHeaders);
      res.end();
      return;
    }
    const acceptEncoding = String(req.headers['accept-encoding'] || '').toLowerCase();
    if (asset.br && acceptEncoding.includes('br')) {
      res.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'br', 'Content-Length': String(asset.br.length) });
      res.end(asset.br);
      return;
    }
    if (asset.gz && acceptEncoding.includes('gzip')) {
      res.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Content-Length': String(asset.gz.length) });
      res.end(asset.gz);
      return;
    }
    res.writeHead(200, { ...baseHeaders, 'Content-Length': String(asset.raw.length) });
    res.end(asset.raw);
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
      return serveStaticFile(req, res, assetName, 'public, max-age=300, must-revalidate');
    }

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/panel')) {
      const accept = String(req.headers.accept || '');
      if (accept.includes('application/json') && !accept.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(buildSummary()));
        return;
      }
      return serveStaticFile(req, res, 'index.html', 'no-cache');
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
