// Shared HTTP helpers for panel API routes.
import { gzipSync } from 'node:zlib';
import { isIP } from 'node:net';
const MAX_BODY_BYTES = 64 * 1024;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_FAILURES = 20;
const failedAuthAttempts = new Map();

function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const chain = forwarded.split(',').map((value) => value.trim()).filter(Boolean);
    // Reverse proxies append the address they observed; prefer the rightmost valid IP.
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (isIP(chain[i])) return chain[i];
    }
  }
  const remoteAddress = req.socket?.remoteAddress;
  return isIP(remoteAddress) ? remoteAddress : 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = failedAuthAttempts.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= now) {
    failedAuthAttempts.delete(ip);
    return false;
  }
  return entry.count >= AUTH_MAX_FAILURES;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  if (failedAuthAttempts.size >= 1000) {
    for (const [k, v] of failedAuthAttempts.entries()) {
      if (v.resetAt <= now) failedAuthAttempts.delete(k);
    }
    if (failedAuthAttempts.size >= 1000) {
      const oldestIp = failedAuthAttempts.keys().next().value;
      if (oldestIp !== undefined) failedAuthAttempts.delete(oldestIp);
    }
  }
  const entry = failedAuthAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    failedAuthAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearAuthFailures(ip) {
  failedAuthAttempts.delete(ip);
}

function sendJson(res, statusCode, payload) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Accept-Encoding',
  };
  if (raw.length >= 1024 && String(res.__acceptEncoding || '').toLowerCase().includes('gzip')) {
    const compressed = gzipSync(raw, { level: 5 });
    res.writeHead(statusCode, {
      ...baseHeaders,
      'Content-Encoding': 'gzip',
      'Content-Length': String(compressed.length),
    });
    res.end(compressed);
    return;
  }
  res.writeHead(statusCode, {
    ...baseHeaders,
    'Content-Length': String(raw.length),
  });
  res.end(raw);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Request payload too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('JSON object body expected.'), { statusCode: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON payload.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function extractBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice(7).trim();
}

export { MAX_BODY_BYTES, getClientIp, isRateLimited, recordAuthFailure, clearAuthFailures, sendJson, readJsonBody, extractBearerToken };
