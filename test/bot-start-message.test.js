import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  validateStartImageUrl,
  parseUploadedStartImage,
  renderStartMessageText,
  saveDeliveryBotStartConfig,
} from '../src/delivery/start-message-repository.js';
import { createDeliveryBot } from '../src/delivery/bot.js';
import { issueOrRegenerateAccessToken } from '../src/web/token-repository.js';
import { startHttpServer } from '../src/server.js';
import { cacheDeletePrefix } from '../src/utils/cache.js';

// Minimal valid 1x1 PNG bytes
const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const SAMPLE_PNG_DATA_URL = `data:image/png;base64,${SAMPLE_PNG_BASE64}`;

function normSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

test('031_delivery_bot_start_messages migration adds custom start message and image columns', async () => {
  const sql = await readFile(
    new URL('../src/database/migrations/031_delivery_bot_start_messages.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /ALTER TABLE delivery_bots/);
  assert.match(sql, /start_message TEXT/);
  assert.match(sql, /start_image_url TEXT/);
  assert.match(sql, /start_image_data BYTEA/);
  assert.match(sql, /start_image_mime TEXT/);
  assert.match(sql, /start_updated_at TIMESTAMPTZ/);
});

test('start image URL and upload validators block unsafe schemes, private IPs, and non-image payloads', () => {
  assert.equal(validateStartImageUrl(''), null);
  assert.equal(
    validateStartImageUrl('https://cdn.example.com/banners/welcome.png?v=1'),
    'https://cdn.example.com/banners/welcome.png?v=1',
  );

  for (const bad of [
    'http://cdn.example.com/a.png',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://localhost/a.png',
    'https://127.0.0.1/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/img.png',
    'https://192.168.1.10/img.png',
    'https://[::1]/img.png',
    'https://user:pass@example.com/a.png',
  ]) {
    assert.throws(() => validateStartImageUrl(bad));
  }

  const parsedPng = parseUploadedStartImage(SAMPLE_PNG_DATA_URL);
  assert.equal(parsedPng.mime, 'image/png');
  assert.ok(Buffer.isBuffer(parsedPng.buffer));

  // Spoofed SVG disguised as image/png must be rejected by magic bytes check
  const fakeSvgB64 = Buffer.from('<svg onload="alert(1)"></svg>', 'utf8').toString('base64');
  assert.throws(
    () => parseUploadedStartImage(`data:image/png;base64,${fakeSvgB64}`),
    /Only PNG, JPG, WEBP, or GIF/i,
  );
});

test('renderStartMessageText safely escapes HTML and substitutes placeholders', () => {
  const out = renderStartMessageText(
    'Hello {first_name} ({username}) on {bot_name}! <script>alert(1)</script> & enjoy!',
    { from: { first_name: 'A<b>C', username: 'alice_tg' } },
    { first_name: 'MyBot', username: 'MyDeliveryBot' },
  );
  assert.equal(
    out,
    'Hello A&lt;b&gt;C (@alice_tg) on MyBot! &lt;script&gt;alert(1)&lt;/script&gt; &amp; enjoy!',
  );
});

test('Delivery Bot /start renders custom text, optional uploaded/URL image, long-caption split, clone attribution, and default reset', async () => {
  cacheDeletePrefix('delivery-bots:');
  const botRecord = {
    id: 42,
    username: 'CreatorStartBot',
    owner_telegram_id: 5001,
    start_message: null,
    start_image_url: null,
    start_image_data: null,
    start_image_mime: null,
    start_updated_at: null,
  };

  const pool = {
    async query(sql, params = []) {
      const n = normSql(sql);
      if (n.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (n.includes('FROM delivery_bots') && n.includes('WHERE id = $1')) {
        if (Number(params[0]) !== botRecord.id) return { rows: [], rowCount: 0 };
        if (n.includes('owner_telegram_id = $2') && Number(params[1]) !== botRecord.owner_telegram_id) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ ...botRecord }], rowCount: 1 };
      }
      if (n.includes('UPDATE delivery_bots SET start_message = $2')) {
        if (Number(params[0]) !== botRecord.id) return { rows: [], rowCount: 0 };
        botRecord.start_message = params[1];
        botRecord.start_image_url = params[2];
        botRecord.start_image_data = params[3];
        botRecord.start_image_mime = params[4];
        botRecord.start_updated_at = new Date();
        return { rows: [{ ...botRecord }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const runtime = createDeliveryBot(
    { adminIds: [999], deliveryBotToken: '123456:TESTTOKEN' },
    { warn() {}, error() {}, info() {} },
    pool,
    '123456:TESTTOKEN',
    {
      deliveryBotId: 42,
      ownerTelegramId: 5001,
      includeGlobal: false,
      mainBotUsername: '@MainFileStoreBot',
    },
  );
  runtime.bot.botInfo = { id: 123456, is_bot: true, first_name: 'CreatorStart', username: 'CreatorStartBot' };

  const sentReplies = [];
  const sentPhotos = [];
  runtime.bot.context.reply = async (text, extra) => {
    sentReplies.push({ text, extra });
    return { message_id: sentReplies.length };
  };
  runtime.bot.context.replyWithPhoto = async (photo, extra) => {
    sentPhotos.push({ photo, extra });
    return { message_id: sentPhotos.length + 100 };
  };

  const assertCloneButton = (extra) => {
    const btn = extra?.reply_markup?.inline_keyboard?.[0]?.[0];
    assert.deepEqual(btn, {
      text: '🤖 Create Clone',
      url: 'https://t.me/MainFileStoreBot?start=clone',
    });
  };

  const sendStartUpdate = (userId = 777) => runtime.bot.handleUpdate({
    update_id: Math.floor(Math.random() * 100000),
    message: {
      message_id: 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'Riya', username: 'riya_dev' },
      text: '/start',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });

  // 1. Default message when no custom start configured includes clone note & button
  await sendStartUpdate();
  assert.equal(sentReplies.length, 1);
  assert.equal(sentPhotos.length, 0);
  assert.match(sentReplies[0].text, /Welcome to FileStore Delivery/);
  assert.match(sentReplies[0].text, /This bot is cloned from @MainFileStoreBot/);
  assertCloneButton(sentReplies[0].extra);

  // 2. Text-only custom /start message includes clone note & button
  await saveDeliveryBotStartConfig(pool, 42, 5001, {
    startMessage: 'Hi {first_name}! Welcome to {bot_name}.',
    imageMode: 'none',
  });
  await sendStartUpdate();
  assert.equal(sentReplies.length, 2);
  assert.equal(
    sentReplies[1].text,
    'Hi Riya! Welcome to CreatorStart.\n\n🤖 <i>This bot is cloned from @MainFileStoreBot</i>',
  );
  assertCloneButton(sentReplies[1].extra);

  // 3. Uploaded image + caption <= 1024 chars includes clone note & button
  await saveDeliveryBotStartConfig(pool, 42, 5001, {
    startMessage: 'Welcome {username}!',
    imageMode: 'upload',
    imageDataUrl: SAMPLE_PNG_DATA_URL,
  });
  await sendStartUpdate();
  assert.equal(sentPhotos.length, 1);
  assert.ok(Buffer.isBuffer(sentPhotos[0].photo.source));
  assert.equal(
    sentPhotos[0].extra.caption,
    'Welcome @riya_dev!\n\n🤖 <i>This bot is cloned from @MainFileStoreBot</i>',
  );
  assertCloneButton(sentPhotos[0].extra);
  assert.equal(sentReplies.length, 2);

  // 4. Long message (> 1024 chars) + URL image splits cleanly into photo + text with clone note & button
  const longText = 'A'.repeat(1100);
  await saveDeliveryBotStartConfig(pool, 42, 5001, {
    startMessage: longText,
    imageMode: 'url',
    imageUrl: 'https://cdn.example.com/banner.jpg',
  });
  await sendStartUpdate();
  assert.equal(sentPhotos.length, 2);
  assert.equal(sentPhotos[1].photo, 'https://cdn.example.com/banner.jpg');
  assert.equal(sentPhotos[1].extra, undefined);
  assert.equal(sentReplies.length, 3);
  assert.equal(
    sentReplies[2].text,
    `${longText}\n\n🤖 <i>This bot is cloned from @MainFileStoreBot</i>`,
  );
  assertCloneButton(sentReplies[2].extra);

  // 5. Reset returns to default FileStore welcome message with clone note & button
  await saveDeliveryBotStartConfig(pool, 42, 5001, { clear: true });
  await sendStartUpdate();
  assert.equal(sentReplies.length, 4);
  assert.match(sentReplies[3].text, /Welcome to FileStore Delivery/);
  assert.match(sentReplies[3].text, /This bot is cloned from @MainFileStoreBot/);
  assertCloneButton(sentReplies[3].extra);

  // 6. Owner Mode default /start resolves mainBotUsername lazily from notifyTelegram when omitted in botMeta
  const ownerRuntime = createDeliveryBot(
    {
      adminIds: [999],
      deliveryBotToken: '123456:TESTTOKEN',
      notifyTelegram: { getMe: async () => ({ username: 'NotifyMainBot' }) },
    },
    { warn() {}, error() {}, info() {} },
    pool,
    '123456:TESTTOKEN',
    { deliveryBotId: null, ownerTelegramId: null, includeGlobal: true },
  );
  ownerRuntime.bot.botInfo = { id: 123456, is_bot: true, first_name: 'OwnerBot', username: 'OwnerDeliveryBot' };
  const ownerReplies = [];
  ownerRuntime.bot.context.reply = async (text, extra) => {
    ownerReplies.push({ text, extra });
    return { message_id: ownerReplies.length };
  };
  await ownerRuntime.bot.handleUpdate({
    update_id: Math.floor(Math.random() * 100000),
    message: {
      message_id: 11,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 999, type: 'private' },
      from: { id: 999, is_bot: false, first_name: 'Owner', username: 'owner_user' },
      text: '/start',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });
  assert.equal(ownerReplies.length, 1);
  assert.match(ownerReplies[0].text, /Owner Mode/);
  assert.match(ownerReplies[0].text, /This bot is cloned from @NotifyMainBot/);
  assert.deepEqual(ownerReplies[0].extra?.reply_markup?.inline_keyboard?.[0]?.[0], {
    text: '🤖 Create Clone',
    url: 'https://t.me/NotifyMainBot?start=clone',
  });
});

test('Web Panel API enforces ownership, validates custom start images, and updates bot metadata', async () => {
  cacheDeletePrefix('delivery-bots:');
  const ownerId = 1;
  const creatorA = 61001;
  const creatorB = 61002;
  const tokens = new Map();
  const bots = [
    {
      id: 11,
      telegram_bot_id: 911001,
      username: 'CreatorABot',
      role: 'primary',
      priority: 10,
      is_enabled: true,
      runtime_status: 'running',
      last_health_at: new Date().toISOString(),
      last_error: null,
      created_by: creatorA,
      owner_telegram_id: creatorA,
      start_message: null,
      start_image_url: null,
      start_image_data: null,
      start_image_mime: null,
      start_updated_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const pool = {
    async query(sql, params = []) {
      const n = normSql(sql);
      if (n.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (n.includes('INSERT INTO web_access_tokens')) {
        const uid = Number(params[0]);
        const rec = {
          telegram_user_id: uid,
          token_hash: params[1],
          token_prefix: params[2],
          created_at: new Date(),
          rotated_at: new Date(),
          last_used_at: null,
          is_new: true,
          username: uid === ownerId ? 'owner' : `creator_${uid}`,
          first_name: uid === ownerId ? 'Owner' : `Creator${uid}`,
        };
        tokens.set(params[1], rec);
        return { rows: [rec], rowCount: 1 };
      }
      if (n.includes('FROM web_access_tokens t') && n.includes('t.token_hash = $1')) {
        const hit = tokens.get(params[0]);
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (n.includes('UPDATE web_access_tokens SET last_used_at')) return { rows: [], rowCount: 1 };
      if (n.includes('FROM delivery_bots') && n.includes('WHERE id = $1')) {
        const id = Number(params[0]);
        const bot = bots.find((b) => b.id === id);
        if (!bot) return { rows: [], rowCount: 0 };
        if (n.includes('owner_telegram_id IS NULL') && bot.owner_telegram_id !== null) return { rows: [], rowCount: 0 };
        if (n.includes('owner_telegram_id = $2') && Number(params[1]) !== bot.owner_telegram_id) return { rows: [], rowCount: 0 };
        return { rows: [{ ...bot }], rowCount: 1 };
      }
      if (n.includes('UPDATE delivery_bots SET start_message = $2')) {
        const id = Number(params[0]);
        const bot = bots.find((b) => b.id === id);
        if (!bot) return { rows: [], rowCount: 0 };
        if (n.includes('owner_telegram_id = $6') && Number(params[5]) !== bot.owner_telegram_id) return { rows: [], rowCount: 0 };
        bot.start_message = params[1];
        bot.start_image_url = params[2];
        bot.start_image_data = params[3];
        bot.start_image_mime = params[4];
        bot.start_updated_at = new Date().toISOString();
        return { rows: [{ ...bot }], rowCount: 1 };
      }
      if (n.includes('FROM delivery_bots d')) {
        const uid = params.length ? Number(params[0]) : null;
        const rows = (uid === null ? bots : bots.filter((b) => b.owner_telegram_id === uid)).map((b) => ({
          ...b,
          has_start_image_upload: Boolean(b.start_image_data),
          total_users: 0,
          active_users_7d: 0,
          total_interactions: 0,
        }));
        return { rows, rowCount: rows.length };
      }
      if (n.includes('FROM storage_channels')) return { rows: [{ id: 1, is_enabled: true }], rowCount: 1 };
      if (n.includes('SELECT value FROM app_settings')) return { rows: [], rowCount: 0 };
      if (n.includes('SELECT extra_bot_slots FROM user_creator_settings')) return { rows: [{ extra_bot_slots: 0 }], rowCount: 1 };
      if (n.includes('SELECT COUNT(*)::int AS used FROM delivery_bots')) return { rows: [{ used: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  const ownerToken = (await issueOrRegenerateAccessToken(pool, ownerId, { first_name: 'Owner' })).token;
  const tokenA = (await issueOrRegenerateAccessToken(pool, creatorA, { first_name: 'Alice' })).token;
  const tokenB = (await issueOrRegenerateAccessToken(pool, creatorB, { first_name: 'Bob' })).token;

  const server = await startHttpServer({
    port: 0,
    nodeEnv: 'test',
    database: 'connected',
    telegram: 'connected',
    delivery: 'connected',
    botUsername: 'MainBot',
    pool,
    config: { adminIds: [ownerId], tokenEncryptionKey: randomBytes(32).toString('base64') },
  }, { info() {}, warn() {}, error() {} });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const hOwner = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };
    const hA = { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' };
    const hB = { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' };

    // Cross-creator read/write/delete blocked (404)
    const crossGet = await fetch(`${base}/api/panel/bots/11/start-message`, { headers: hB });
    assert.equal(crossGet.status, 404);
    const crossPut = await fetch(`${base}/api/panel/bots/11/start-message`, {
      method: 'PUT',
      headers: hB,
      body: JSON.stringify({ startMessage: 'Hacked' }),
    });
    assert.equal(crossPut.status, 404);

    // Invalid URL rejected with 400
    const badUrl = await fetch(`${base}/api/panel/bots/11/start-message`, {
      method: 'PUT',
      headers: hA,
      body: JSON.stringify({ startMessage: 'Hi', imageMode: 'url', imageUrl: 'http://127.0.0.1/x.png' }),
    });
    assert.equal(badUrl.status, 400);

    // Creator A saves custom message + uploaded PNG
    const saveRes = await fetch(`${base}/api/panel/bots/11/start-message`, {
      method: 'PUT',
      headers: hA,
      body: JSON.stringify({
        startMessage: 'Welcome {first_name}!',
        imageMode: 'upload',
        imageDataUrl: SAMPLE_PNG_DATA_URL,
      }),
    });
    assert.equal(saveRes.status, 200);
    const saveJson = await saveRes.json();
    assert.equal(saveJson.hasCustomStartMessage, true);
    assert.equal(saveJson.hasStartImage, true);
    assert.equal(saveJson.imageMode, 'upload');
    assert.equal(saveJson.imagePreviewUrl, SAMPLE_PNG_DATA_URL);

    // Creator A list bots reflects Custom /start status without sending raw binary
    const listRes = await fetch(`${base}/api/panel/bots`, { headers: hA });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.bots[0].hasCustomStartMessage, true);
    assert.equal(listJson.bots[0].hasStartImage, true);
    assert.equal(listJson.bots[0].startImageType, 'upload');

    // Keep uploaded image while updating text only
    const textUpdateRes = await fetch(`${base}/api/panel/bots/11/start-message`, {
      method: 'PUT',
      headers: hA,
      body: JSON.stringify({
        startMessage: 'Updated welcome {username}',
        imageMode: 'keep',
      }),
    });
    assert.equal(textUpdateRes.status, 200);
    const textUpdateJson = await textUpdateRes.json();
    assert.equal(textUpdateJson.startMessage, 'Updated welcome {username}');
    assert.equal(textUpdateJson.imageMode, 'upload');

    // Owner can reset bot start message if needed
    const ownerReset = await fetch(`${base}/api/panel/owner/bots/11/start-message`, {
      method: 'DELETE',
      headers: hOwner,
    });
    assert.equal(ownerReset.status, 200);
    const resetJson = await ownerReset.json();
    assert.equal(resetJson.hasCustomStartMessage, false);
    assert.equal(resetJson.imageMode, 'none');

    // Frontend UI checks
    const appJs = await readFile(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
    assert.match(appJs, /data-cbot-start=/);
    assert.match(appJs, /Start Msg/);
    assert.match(appJs, /id="start-msg-form"/);
    assert.match(appJs, /safeImagePreviewUrl/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
