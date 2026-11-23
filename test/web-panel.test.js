import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEB_TOKEN_PREFIX,
  generateRawAccessToken,
  hashAccessToken,
  isPlausibleAccessToken,
  getAccessTokenMetadata,
  issueOrRegenerateAccessToken,
  revokeAccessToken,
  verifyAccessToken,
} from '../src/web/token-repository.js';
import { registerWebTokenUi } from '../src/bot/web-token-ui.js';
import { startHttpServer } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Lightweight in-memory PostgreSQL pool stub supporting web_access_tokens,
 * users, and read-only queries needed by /api/panel/* routes.
 */
function createMockPanelPool() {
  const users = new Map();
  const tokens = new Map(); // telegram_user_id -> row

  return {
    users,
    tokens,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('INSERT INTO users')) {
        const [id, username, firstName] = params;
        if (!users.has(id)) {
          users.set(id, { telegram_id: id, username, first_name: firstName });
        }
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT telegram_user_id, token_prefix, created_at, rotated_at, last_used_at FROM web_access_tokens')) {
        const row = tokens.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      if (normalized.startsWith('INSERT INTO web_access_tokens')) {
        const [uid, tokenHash, tokenPrefix] = params;
        const now = new Date().toISOString();
        const isNew = !tokens.has(uid);
        const existing = tokens.get(uid);
        const row = {
          telegram_user_id: uid,
          token_hash: tokenHash,
          token_prefix: tokenPrefix,
          created_at: existing?.created_at ?? now,
          rotated_at: now,
          last_used_at: null,
          is_new: isNew,
        };
        tokens.set(uid, row);
        return { rows: [row], rowCount: 1 };
      }

      if (normalized.startsWith('DELETE FROM web_access_tokens')) {
        const existed = tokens.delete(params[0]);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }

      if (normalized.includes('FROM web_access_tokens t JOIN users u')) {
        const candidateHash = params[0];
        for (const row of tokens.values()) {
          if (row.token_hash === candidateHash) {
            const u = users.get(row.telegram_user_id) || {};
            return {
              rows: [{
                ...row,
                username: u.username ?? null,
                first_name: u.first_name ?? null,
              }],
              rowCount: 1,
            };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith('UPDATE web_access_tokens SET last_used_at')) {
        const row = tokens.get(params[0]);
        if (row) row.last_used_at = new Date().toISOString();
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      // Generic empty/default responses for dashboard, wallet, links, etc.
      if (normalized.includes('SELECT COUNT(*)::int AS total') || normalized.includes('COUNT(*)::int AS count')) {
        return { rows: [{ total: 0, count: 0 }], rowCount: 1 };
      }

      if (normalized.includes('FROM creator_wallets')) {
        return { rows: [], rowCount: 0 };
      }

      if (normalized.includes('INSERT INTO creator_wallets')) {
        return {
          rows: [{
            user_telegram_id: params[0],
            currency: 'INR',
            available_minor: 0,
            locked_minor: 0,
            total_earned_minor: 0,
            total_withdrawn_minor: 0,
            payout_upi_id: null,
            updated_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }

      if (normalized.includes('SELECT 1')) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }

      if (normalized.includes('delivery_pending')) {
        return {
          rows: [{
            delivery_pending: 0,
            delivery_processing: 0,
            delivery_failed: 0,
            deletions_due: 0,
            payment_recovery_pending: 0,
          }],
          rowCount: 1,
        };
      }

      return { rows: [], rowCount: 0 };
    },
  };
}

test('024_web_access_tokens.sql migration defines hashed web_access_tokens table', async () => {
  const migrationPath = path.resolve(__dirname, '../src/database/migrations/024_web_access_tokens.sql');
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS web_access_tokens/i);
  assert.match(sql, /telegram_user_id BIGINT PRIMARY KEY REFERENCES users\(telegram_id\) ON DELETE CASCADE/i);
  assert.match(sql, /token_hash TEXT NOT NULL UNIQUE/i);

  const routerSrc = await readFile(path.resolve(__dirname, '../src/web/api-router.js'), 'utf8');
  assert.doesNotMatch(routerSrc, /setting_value|setting_key/);
  assert.match(routerSrc, /SELECT value FROM app_settings WHERE key = 'checkpoint_enabled'/);
  const fileRoutesSrc = await readFile(path.resolve(__dirname, '../src/web/routes/file-routes.js'), 'utf8');
  assert.match(fileRoutesSrc, /FROM files WHERE status = 'active' AND uploaded_by = \$1/);
});

test('token-repository issues hashed tokens, rotates cleanly, and enforces fail-closed owner role', async () => {
  const pool = createMockPanelPool();
  const raw = generateRawAccessToken();
  assert.ok(raw.startsWith(WEB_TOKEN_PREFIX));
  assert.ok(isPlausibleAccessToken(raw));
  assert.equal(hashAccessToken(raw).length, 64);
  assert.equal(hashAccessToken(raw), hashAccessToken(raw));

  const ownerId = 1001;
  const creatorId = 2002;

  const ownerIssued = await issueOrRegenerateAccessToken(pool, ownerId, { username: 'boss', first_name: 'Owner' });
  const storedOwner = pool.tokens.get(ownerId);
  assert.ok(storedOwner, 'token row should be persisted');
  assert.notEqual(storedOwner.token_hash, ownerIssued.token, 'plaintext token must never be stored');
  assert.equal(storedOwner.token_hash, hashAccessToken(ownerIssued.token));

  const creatorIssued = await issueOrRegenerateAccessToken(pool, creatorId, { username: 'alice', first_name: 'Alice' });

  // Owner verified with adminIds
  const ownerAuth = await verifyAccessToken(pool, ownerIssued.token, [ownerId]);
  assert.equal(ownerAuth?.userId, ownerId);
  assert.equal(ownerAuth?.isOwner, true);
  assert.equal(ownerAuth?.role, 'owner');

  // Fail-closed when adminIds is empty
  const failClosed = await verifyAccessToken(pool, ownerIssued.token, []);
  assert.equal(failClosed?.isOwner, false);
  assert.equal(failClosed?.role, 'creator');

  // Creator verified as non-owner
  const creatorAuth = await verifyAccessToken(pool, creatorIssued.token, [ownerId]);
  assert.equal(creatorAuth?.userId, creatorId);
  assert.equal(creatorAuth?.isOwner, false);
  assert.equal(creatorAuth?.role, 'creator');

  // Rotation invalidates old token immediately
  const rotated = await issueOrRegenerateAccessToken(pool, creatorId, { username: 'alice', first_name: 'Alice' });
  assert.notEqual(rotated.token, creatorIssued.token);
  assert.equal(await verifyAccessToken(pool, creatorIssued.token, [ownerId]), null);
  assert.equal((await verifyAccessToken(pool, rotated.token, [ownerId]))?.userId, creatorId);

  // Revocation removes token
  const revoked = await revokeAccessToken(pool, creatorId);
  assert.equal(revoked, true);
  assert.equal(await getAccessTokenMetadata(pool, creatorId), null);
  assert.equal(await verifyAccessToken(pool, rotated.token, [ownerId]), null);
});

test('web-token-ui handles /token first issue, masked view, regenerate, and revoke', async () => {
  const pool = createMockPanelPool();
  const commands = new Map();
  const actions = new Map();
  const bot = {
    command(names, handler) {
      const list = Array.isArray(names) ? names : [names];
      for (const n of list) commands.set(n, handler);
    },
    action(name, handler) {
      actions.set(name, handler);
    },
  };

  registerWebTokenUi(bot, { appUrl: 'https://panel.example.com' }, { error() {} }, pool);
  assert.ok(commands.has('token'));
  assert.ok(commands.has('web'));
  assert.ok(commands.has('panel'));

  const sent = [];
  const makeCtx = (userId = 555) => ({
    from: { id: userId, username: 'creator555', first_name: 'Maya' },
    reply: async (text, extra) => { sent.push({ type: 'reply', text, extra }); },
    editMessageText: async (text, extra) => { sent.push({ type: 'edit', text, extra }); },
    answerCbQuery: async () => {},
  });

  // First /token auto-generates and reveals inside <tg-spoiler>
  await commands.get('token')(makeCtx(555));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /<tg-spoiler><code>fs_[A-Za-z0-9_-]+<\/code><\/tg-spoiler>/);

  // Second /token shows masked prefix only (does not re-reveal plaintext)
  await commands.get('token')(makeCtx(555));
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[1].text, /<tg-spoiler>/);
  assert.match(sent[1].text, /Active Token Issued/);

  // Regenerate issues a new token
  const firstHash = pool.tokens.get(555).token_hash;
  await actions.get('cc:webtok_regen_go')(makeCtx(555));
  assert.equal(sent.length, 3);
  assert.match(sent[2].text, /New Web Panel Token Generated/);
  assert.notEqual(pool.tokens.get(555).token_hash, firstHash);

  // Revoke removes the token
  await actions.get('cc:webtok_revoke_go')(makeCtx(555));
  assert.equal(sent.length, 4);
  assert.match(sent[3].text, /Token Revoked/);
  assert.equal(pool.tokens.has(555), false);
});

test('HTTP server serves Web Control Panel UI, blocks path traversal, and enforces token RBAC', async () => {
  const pool = createMockPanelPool();
  const ownerId = 9001;
  const creatorId = 9002;
  const ownerToken = (await issueOrRegenerateAccessToken(pool, ownerId, { first_name: 'Owner' })).token;
  const creatorToken = (await issueOrRegenerateAccessToken(pool, creatorId, { first_name: 'Creator' })).token;

  const logger = { info() {}, warn() {}, error() {} };
  const server = await startHttpServer({
    port: 0,
    nodeEnv: 'test',
    database: 'connected',
    telegram: 'connected',
    delivery: 'connected',
    botUsername: 'Filestore_testbot',
    pool,
    config: { adminIds: [ownerId] },
  }, logger);

  try {
    const addr = server.address();
    const base = `http://127.0.0.1:${addr.port}`;

    // 1. HTML landing page vs JSON Accept header
    const htmlRes = await fetch(`${base}/`, { headers: { Accept: 'text/html' } });
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /FileStore — Control Panel/);
    assert.match(html, /\/assets\/panel\.css/);
    assert.match(html, /\/assets\/app\.js/);

    const jsonRootRes = await fetch(`${base}/`, { headers: { Accept: 'application/json' } });
    assert.equal(jsonRootRes.status, 200);
    const rootJson = await jsonRootRes.json();
    assert.equal(rootJson.app, 'filestore');

    // 2. Static assets + path traversal blocking
    const cssRes = await fetch(`${base}/assets/panel.css`);
    assert.equal(cssRes.status, 200);
    const jsRes = await fetch(`${base}/assets/app.js`);
    assert.equal(jsRes.status, 200);

    const traversalRes = await fetch(`${base}/assets/%2e%2e%2fserver.js`);
    assert.equal(traversalRes.status, 403);

    // 3. Public metadata
    const metaRes = await fetch(`${base}/api/panel/meta`);
    assert.equal(metaRes.status, 200);
    const meta = await metaRes.json();
    assert.equal(meta.botUsername, 'Filestore_testbot');

    // 4. Auth endpoint rejects invalid token and accepts valid creator & owner tokens
    const badAuth = await fetch(`${base}/api/panel/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fs_invalid_token_value_12345678901234567890' }),
    });
    assert.equal(badAuth.status, 401);

    const creatorAuthRes = await fetch(`${base}/api/panel/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: creatorToken }),
    });
    assert.equal(creatorAuthRes.status, 200);
    const creatorAuthData = await creatorAuthRes.json();
    assert.equal(creatorAuthData.user.role, 'creator');
    assert.equal(creatorAuthData.user.isOwner, false);

    const ownerAuthRes = await fetch(`${base}/api/panel/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ownerToken }),
    });
    assert.equal(ownerAuthRes.status, 200);
    const ownerAuthData = await ownerAuthRes.json();
    assert.equal(ownerAuthData.user.role, 'owner');
    assert.equal(ownerAuthData.user.isOwner, true);

    // 5. Creator can access creator endpoints, CANNOT access owner endpoints (403)
    const unauthOverview = await fetch(`${base}/api/panel/overview`);
    assert.equal(unauthOverview.status, 401);

    const creatorOverview = await fetch(`${base}/api/panel/overview`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(creatorOverview.status, 200);
    const creatorOverviewJson = await creatorOverview.json();
    assert.equal(creatorOverviewJson.role, 'creator');
    assert.equal(creatorOverviewJson.ownerSummary, null);

    const creatorWallet = await fetch(`${base}/api/panel/wallet`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(creatorWallet.status, 200);

    const forbiddenDash = await fetch(`${base}/api/panel/owner/dashboard`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(forbiddenDash.status, 403);

    const forbiddenWds = await fetch(`${base}/api/panel/owner/withdrawals`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(forbiddenWds.status, 403);

    // 6. Creator token regeneration immediately invalidates old token
    const regenRes = await fetch(`${base}/api/panel/token/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(regenRes.status, 200);
    const regenJson = await regenRes.json();
    assert.ok(regenJson.token.startsWith('fs_'));
    assert.notEqual(regenJson.token, creatorToken);

    const oldTokenRetry = await fetch(`${base}/api/panel/overview`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    assert.equal(oldTokenRetry.status, 401);

    const newTokenRetry = await fetch(`${base}/api/panel/overview`, {
      headers: { Authorization: `Bearer ${regenJson.token}` },
    });
    assert.equal(newTokenRetry.status, 200);

    // 7. Owner can access /api/panel/owner/dashboard and /api/panel/owner/withdrawals
    const ownerDash = await fetch(`${base}/api/panel/owner/dashboard`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerDash.status, 200);
    const ownerDashJson = await ownerDash.json();
    assert.ok(ownerDashJson.stats);
    assert.ok(ownerDashJson.health);

    const ownerWds = await fetch(`${base}/api/panel/owner/withdrawals`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerWds.status, 200);
    const ownerWdsJson = await ownerWds.json();
    assert.equal(ownerWdsJson.status, 'pending');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
