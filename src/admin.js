import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
    isOwner: Number(session.userId) === config.ownerId,
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

  const authorize = async (req, res) => {
    const admin = await getAdmin(req);
    if (!admin) {
      res.status(401).json({ ok: false, error: 'authentication_required' });
      return null;
    }
    return admin;
  };
  const parsePage = (value) => {
    const parsed = Number(value || 1);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100000) : 1;
  };
  const parseLimit = (value) => {
    const parsed = Number(value || 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 25) : 10;
  };
  const escapeRegex = (value) => value.replace(/[.*+?^$()|[\\]\\\\]/g, '\\$&');
  const queryText = (value) => String(value || '').trim().slice(0, 80);
  const pagination = (page, limit, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

  app.get('/admin/api/users', async (req, res) => {
    try {
      if (!await authorize(req, res)) return;
      const page = parsePage(req.query.page), limit = parseLimit(req.query.limit), q = queryText(req.query.q);
      const filter = q ? { $or: [
        { username: { $regex: escapeRegex(q), $options: 'i' } },
        { firstName: { $regex: escapeRegex(q), $options: 'i' } },
        { lastName: { $regex: escapeRegex(q), $options: 'i' } },
        ...( /^\d+$/.test(q) ? [{ userId: Number(q) }] : []),
      ] } : {};
      const [total, users] = await Promise.all([
        collection('users').countDocuments(filter),
        collection('users').find(filter, { projection: { userId: 1, firstName: 1, lastName: 1, username: 1, createdAt: 1, lastSeenAt: 1, premiumUntil: 1 } }).sort({ lastSeenAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      const ids = users.map((user) => user.userId);
      const banned = ids.length ? await collection('bans').find({ userId: { $in: ids } }, { projection: { userId: 1 } }).toArray() : [];
      const bannedIds = new Set(banned.map((item) => Number(item.userId)));
      const now = new Date();
      return res.json({ ok: true, pagination: pagination(page, limit, total), users: users.map((user) => ({
        userId: user.userId, firstName: user.firstName || '', lastName: user.lastName || '', username: user.username || '',
        createdAt: user.createdAt || null, lastSeenAt: user.lastSeenAt || null,
        premiumUntil: user.premiumUntil || null, premium: Boolean(user.premiumUntil && user.premiumUntil > now), banned: bannedIds.has(Number(user.userId)), isAdmin: config.adminIds.includes(Number(user.userId)),
      })) });
    } catch (error) {
      console.error('[admin] User listing failed:', error.message);
      return res.status(500).json({ ok: false, error: 'users_unavailable' });
    }
  });

  app.post('/admin/api/users/:userId/:action(ban|unban)', requireSameOrigin, async (req, res) => {
    try {
      const admin = await authorize(req, res);
      if (!admin) return;
      if (!admin.isOwner) return res.status(403).json({ ok: false, error: 'owner_only_action' });
      const userId = Number(req.params.userId);
      if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ ok: false, error: 'invalid_user_id' });
      if (config.adminIds.includes(userId)) return res.status(400).json({ ok: false, error: 'cannot_change_admin_access' });
      if (req.params.action === 'ban') {
        await collection('bans').updateOne({ userId }, { $set: { userId, bannedAt: new Date(), bannedBy: admin.userId } }, { upsert: true });
      } else {
        await collection('bans').deleteOne({ userId });
      }
      return res.json({ ok: true, userId, banned: req.params.action === 'ban' });
    } catch (error) {
      console.error('[admin] User moderation failed:', error.message);
      return res.status(500).json({ ok: false, error: 'user_moderation_failed' });
    }
  });

  const listContent = async (req, res, kind) => {
    const page = parsePage(req.query.page), limit = parseLimit(req.query.limit), q = queryText(req.query.q);
    const regex = q ? { $regex: escapeRegex(q), $options: 'i' } : null;
    let filter = {};
    if (kind === 'files') {
      if (q) filter = { $or: [
        { fileName: regex }, { fileType: regex },
        ...( /^\d+$/.test(q) ? [{ ownerId: Number(q) }] : []),
      ] };
      const [total, docs] = await Promise.all([
        collection('files').countDocuments(filter),
        collection('files').find(filter, { projection: { tokenHash: 1, fileName: 1, fileType: 1, mimeType: 1, fileSize: 1, ownerId: 1, createdAt: 1, expiresAt: 1, downloads: 1, revokedAt: 1 } }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      return res.json({ ok: true, kind, pagination: pagination(page, limit, total), items: docs.map((d) => ({
        id: String(d._id), label: d.fileName || d.fileType || 'File', fileType: d.fileType || 'unknown', mimeType: d.mimeType || '',
        fileSize: d.fileSize || 0, ownerId: d.ownerId, createdAt: d.createdAt || null, expiresAt: d.expiresAt || null,
        downloads: d.downloads || 0, revoked: Boolean(d.revokedAt), tokenHint: String(d.tokenHash || '').slice(-8),
      })) });
    }
    if (kind === 'batches') {
      if (q) filter = { $or: [
        { tokenHash: regex },
        ...( /^\d+$/.test(q) ? [{ ownerId: Number(q) }] : []),
      ] };
      const [total, docs] = await Promise.all([
        collection('batches').countDocuments(filter),
        collection('batches').find(filter, { projection: { ownerId: 1, fileIds: 1, createdAt: 1, expiresAt: 1, downloads: 1, passwordHash: 1, revokedAt: 1 } }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      return res.json({ ok: true, kind, pagination: pagination(page, limit, total), items: docs.map((d) => ({
        id: String(d._id), label: 'Batch', ownerId: d.ownerId, fileCount: Array.isArray(d.fileIds) ? d.fileIds.length : 0,
        createdAt: d.createdAt || null, expiresAt: d.expiresAt || null, downloads: d.downloads || 0,
        passwordProtected: Boolean(d.passwordHash), revoked: Boolean(d.revokedAt),
      })) });
    }
    if (kind === 'posts') {
      if (q) filter = { $or: [
        { title: regex },
        ...( /^\d+$/.test(q) ? [{ ownerId: Number(q) }, { channelId: Number(q) }] : []),
      ] };
      const [total, docs] = await Promise.all([
        collection('posts').countDocuments(filter),
        collection('posts').find(filter, { projection: { title: 1, ownerId: 1, channelId: 1, stars: 1, videoCount: 1, createdAt: 1, revokedAt: 1, paidUsers: 1 } }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      return res.json({ ok: true, kind, pagination: pagination(page, limit, total), items: docs.map((d) => ({
        id: String(d._id), label: d.title || 'Untitled post', ownerId: d.ownerId, channelId: d.channelId,
        stars: d.stars || 0, videoCount: d.videoCount || (Array.isArray(d.fileTokenHashes) ? d.fileTokenHashes.length : 0),
        createdAt: d.createdAt || null, paidUsers: Array.isArray(d.paidUsers) ? d.paidUsers.length : 0, revoked: Boolean(d.revokedAt),
      })) });
    }
    return res.status(404).json({ ok: false, error: 'unknown_content_type' });
  };

  for (const kind of ['files', 'batches', 'posts']) {
    app.get('/admin/api/' + kind, async (req, res) => {
      try {
        if (!await authorize(req, res)) return;
        return await listContent(req, res, kind);
      } catch (error) {
        console.error('[admin] ' + kind + ' listing failed:', error.message);
        return res.status(500).json({ ok: false, error: 'content_unavailable' });
      }
    });
  }

  app.post('/admin/api/:kind(files|batches|posts)/:id/revoke', requireSameOrigin, async (req, res) => {
    try {
      const admin = await authorize(req, res);
      if (!admin) return;
      const collections = { files: 'files', batches: 'batches', posts: 'posts' };
      const { kind, id } = req.params;
      if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(400).json({ ok: false, error: 'invalid_content_id' });
      const { ObjectId } = await import('mongodb');
      const result = await collection(collections[kind]).updateOne(
        { _id: new ObjectId(id), revokedAt: { $exists: false } },
        { $set: { revokedAt: new Date(), revokedBy: admin.userId } },
      );
      if (!result.matchedCount) return res.status(404).json({ ok: false, error: 'content_not_found_or_already_revoked' });
      return res.json({ ok: true, kind, id, revoked: true });
    } catch (error) {
      console.error('[admin] Content revocation failed:', error.message);
      return res.status(500).json({ ok: false, error: 'content_revocation_failed' });
    }
  });

}
