import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collection } from './database.js';
import { config } from './config.js';

const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const TELEGRAM_AUTH_MAX_AGE_SECONDS = 5 * 60;
const pagePath = fileURLToPath(new URL('../public/admin/index.html', import.meta.url));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyTelegramLogin(payload, botToken) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { hash, auth_date: authDateRaw, id: idRaw } = payload;
  if (typeof hash !== 'string' || !/^\d+$/.test(String(authDateRaw || '')) || !/^\d+$/.test(String(idRaw || ''))) return null;

  const authDate = Number(authDateRaw);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > TELEGRAM_AUTH_MAX_AGE_SECONDS) return null;

  const checkString = Object.keys(payload)
    .filter((key) => key !== 'hash' && payload[key] !== undefined && payload[key] !== null)
    .sort()
    .map((key) => key + '=' + String(payload[key]))
    .join('\n');
  const secretKey = createHash('sha256').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(checkString).digest('hex');
  if (!safeEqualHex(hash, expectedHash)) return null;

  const userId = Number(idRaw);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return {
    userId,
    firstName: String(payload.first_name || '').slice(0, 128),
    lastName: String(payload.last_name || '').slice(0, 128),
    username: String(payload.username || '').slice(0, 64),
    photoUrl: String(payload.photo_url || '').slice(0, 2048),
    authDate,
  };
}

function requestIsSameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'filestore_admin=' + encodeURIComponent(token) + '; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(ADMIN_SESSION_MS / 1000) + secure);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'filestore_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0' + secure);
}

async function getAdmin(req) {
  const token = readCookie(req, 'filestore_admin');
  if (!token || token.length < 40 || token.length > 200) return null;
  const session = await collection('adminSessions').findOne({
    tokenHash: sha256(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session || !config.adminIds.includes(Number(session.userId))) return null;
  return {
    userId: Number(session.userId),
    firstName: session.firstName || '',
    lastName: session.lastName || '',
    username: session.username || '',
    photoUrl: session.photoUrl || '',
    expiresAt: session.expiresAt,
  };
}

function requireSameOrigin(req, res, next) {
  if (!requestIsSameOrigin(req)) return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
  return next();
}

export function registerAdminRoutes(app, bot) {
  app.get('/admin', (_req, res) => res.sendFile(pagePath));
  app.get('/admin/', (_req, res) => res.sendFile(pagePath));

  app.get('/admin/api/config', async (_req, res) => {
    try {
      const me = await bot.telegram.getMe();
      return res.json({ ok: true, botUsername: me.username });
    } catch {
      return res.status(503).json({ ok: false, error: 'bot_identity_unavailable' });
    }
  });

  app.post('/admin/api/auth/telegram', requireSameOrigin, async (req, res) => {
    const identity = verifyTelegramLogin(req.body, config.botToken);
    if (!identity) return res.status(401).json({ ok: false, error: 'invalid_or_expired_telegram_login' });
    if (!config.adminIds.includes(identity.userId)) {
      return res.status(403).json({ ok: false, error: 'telegram_account_not_admin' });
    }

    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ADMIN_SESSION_MS);
    await collection('adminSessions').insertOne({
      tokenHash: sha256(token),
      userId: identity.userId,
      firstName: identity.firstName,
      lastName: identity.lastName,
      username: identity.username,
      photoUrl: identity.photoUrl,
      createdAt,
      lastSeenAt: createdAt,
      expiresAt,
    });
    setSessionCookie(res, token);
    return res.json({ ok: true, user: { userId: identity.userId, firstName: identity.firstName, lastName: identity.lastName, username: identity.username, photoUrl: identity.photoUrl }, expiresAt });
  });

  app.get('/admin/api/me', async (req, res) => {
    try {
      const admin = await getAdmin(req);
      if (!admin) return res.status(401).json({ ok: false, error: 'authentication_required' });
      return res.json({ ok: true, user: admin });
    } catch (error) {
      console.error('[admin] Session lookup failed:', error.message);
      return res.status(500).json({ ok: false, error: 'session_lookup_failed' });
    }
  });

  app.post('/admin/api/logout', requireSameOrigin, async (req, res) => {
    try {
      const token = readCookie(req, 'filestore_admin');
      if (token) await collection('adminSessions').deleteOne({ tokenHash: sha256(token) });
      clearSessionCookie(res);
      return res.json({ ok: true });
    } catch (error) {
      console.error('[admin] Logout failed:', error.message);
      return res.status(500).json({ ok: false, error: 'logout_failed' });
    }
  });

  app.get('/admin/api/overview', async (req, res) => {
    try {
      const admin = await getAdmin(req);
      if (!admin) return res.status(401).json({ ok: false, error: 'authentication_required' });
      const now = new Date();
      const [users, files, batches, posts, bans, payments, premiumUsers, revenue, recentUsers, recentPayments] = await Promise.all([
        collection('users').countDocuments(),
        collection('files').countDocuments(),
        collection('batches').countDocuments(),
        collection('posts').countDocuments(),
        collection('bans').countDocuments(),
        collection('payments').countDocuments({ status: 'processed' }),
        collection('users').countDocuments({ premiumUntil: { $gt: now } }),
        collection('payments').aggregate([
          { $match: { status: 'processed', currency: 'XTR' } },
          { $group: { _id: null, totalStars: { $sum: '$totalAmount' } } },
        ]).toArray(),
        collection('users').find({}, { projection: { userId: 1, firstName: 1, lastName: 1, username: 1, createdAt: 1, lastSeenAt: 1, premiumUntil: 1, isBanned: 1 } }).sort({ lastSeenAt: -1 }).limit(8).toArray(),
        collection('payments').find({ status: 'processed' }, { projection: { userId: 1, currency: 1, totalAmount: 1, createdAt: 1, processedAt: 1, payload: 1 } }).sort({ processedAt: -1, createdAt: -1 }).limit(8).toArray(),
      ]);
      return res.json({
        ok: true,
        stats: { users, files, batches, posts, bans, payments, premiumUsers, totalStars: revenue[0]?.totalStars || 0 },
        recentUsers: recentUsers.map((user) => ({ userId: user.userId, firstName: user.firstName || '', lastName: user.lastName || '', username: user.username || '', createdAt: user.createdAt || null, lastSeenAt: user.lastSeenAt || null, premium: Boolean(user.premiumUntil && user.premiumUntil > now), banned: Boolean(user.isBanned) })),
        recentPayments: recentPayments.map((payment) => ({ userId: payment.userId, currency: payment.currency, totalAmount: payment.totalAmount, createdAt: payment.processedAt || payment.createdAt || null, payload: payment.payload || '' })),
        serverTime: now,
      });
    } catch (error) {
      console.error('[admin] Overview failed:', error.message);
      return res.status(500).json({ ok: false, error: 'overview_unavailable' });
    }
  });
}
