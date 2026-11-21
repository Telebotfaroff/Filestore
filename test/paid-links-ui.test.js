import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parsePaidPriceInput } from '../src/bot/paid-links-ui.js';
import { registerControlCenter, buildMainMenuKeyboard } from '../src/bot/control-center.js';
import { registerPaidFileAdminCommands } from '../src/paid-files/admin-commands.js';
import { registerPaidBatchAdminCommands } from '../src/paid-files/batch-admin-commands.js';
import { createDeliveryBot } from '../src/delivery/bot.js';
import { hashUpperCode } from '../src/utils/validation.js';

function createFakeBot() {
  const commands = [];
  const actions = [];
  const onHandlers = new Map();
  return {
    command(name, handler) { commands.push({ name, handler }); },
    action(pattern, handler) { actions.push({ pattern, handler }); },
    on(event, handler) {
      const key = Array.isArray(event) ? event.join(',') : event;
      const list = onHandlers.get(key) ?? [];
      list.push(handler);
      onHandlers.set(key, list);
    },
    commands,
    actions,
    onHandlers,
  };
}

function findCommands(bot, cmdName) {
  return bot.commands
    .filter((entry) => (typeof entry.name === 'string' && entry.name === cmdName) || (entry.name instanceof RegExp && entry.name.test(cmdName)))
    .map((entry) => entry.handler);
}

function findAction(bot, data) {
  for (const entry of bot.actions) {
    if (typeof entry.pattern === 'string' && entry.pattern === data) return { handler: entry.handler, match: [data] };
    if (entry.pattern instanceof RegExp) {
      const m = data.match(entry.pattern);
      if (m) return { handler: entry.handler, match: m };
    }
  }
  return null;
}

async function runMiddlewareChain(handlers, ctx) {
  let idx = 0;
  async function next() {
    if (idx < handlers.length) {
      const h = handlers[idx++];
      return h(ctx, next);
    }
  }
  return next();
}

function createPaidWorkflowMockPool() {
  const files = new Map();
  const paidLinks = new Map();
  const paidBatches = new Map();
  const paidBatchItems = new Map();
  const starsState = {
    is_enabled: true,
    public_config: { stars_prices: { premium: {}, paid_file: {}, paid_batch: {} } },
    setup_status: 'configured',
    last_test_status: 'ok',
    last_test_error: null,
  };
  let nextFileId = 1;
  let nextIngestId = 1;
  let nextPaidLinkId = 1;
  let nextPaidBatchId = 1;

  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };

      if (sql.includes('INSERT INTO files')) {
        const id = nextFileId++;
        const row = {
          id,
          file_code: params[0],
          file_name: params[1],
          file_type: params[2],
          mime_type: params[3],
          file_size: params[4],
          telegram_file_id: params[5],
          telegram_file_unique_id: params[6],
          status: 'active',
          created_by: params[7],
        };
        files.set(row.file_code, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO storage_messages') || sql.includes('UPDATE file_ingest_requests')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('FROM files WHERE file_code = $1')) {
        const f = files.get(params[0]);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (sql.includes('FROM files WHERE file_code = ANY($1::text[])')) {
        const rows = params[0].map((code) => files.get(code)).filter(Boolean);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('INSERT INTO paid_file_links')) {
        const id = nextPaidLinkId++;
        const row = {
          id,
          public_code: params[0],
          public_code_hash: params[1],
          file_id: params[2],
          price_minor: params[3],
          currency: params[4],
          expires_at: params[5],
          created_by: params[6],
          is_enabled: true,
          created_at: new Date(),
        };
        paidLinks.set(id, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO paid_batch_links')) {
        const id = nextPaidBatchId++;
        const row = {
          id,
          public_code: params[0],
          public_code_hash: params[1],
          title: params[2],
          price_minor: params[3],
          currency: params[4],
          expires_at: params[5],
          created_by: params[6],
          is_enabled: true,
          created_at: new Date(),
        };
        paidBatches.set(id, row);
        paidBatchItems.set(id, []);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO paid_batch_items')) {
        const arr = paidBatchItems.get(params[0]) ?? [];
        arr.push({ file_id: params[1], position: params[2] });
        paidBatchItems.set(params[0], arr);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const pool = {
    files,
    paidLinks,
    paidBatches,
    paidBatchItems,
    starsState,
    async connect() { return client; },
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO file_ingest_requests')) {
        return { rows: [{ id: nextIngestId++ }], rowCount: 1 };
      }
      if (sql.includes('UPDATE file_ingest_requests')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('WHERE telegram_file_unique_id = $1')) {
        const f = [...files.values()].find((x) => x.telegram_file_unique_id === params[0]);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (sql.includes('FROM storage_channels') && sql.includes("role = 'primary'")) {
        return {
          rows: [{ id: 10, telegram_chat_id: -100999888, title: 'Main Storage', is_enabled: true, last_test_status: 'ok' }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM files f LEFT JOIN storage_messages')) {
        const f = files.get(params[0]);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (sql.includes("FROM files WHERE status = 'active'")) {
        const rows = [...files.values()].slice(0, params[0] ?? 10);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM delivery_bots')) {
        return { rows: [{ username: 'FilesDeliveryBot' }], rowCount: 1 };
      }
      if (sql.includes('SELECT is_enabled, public_config FROM payment_methods')) {
        return { rows: [{ is_enabled: starsState.is_enabled, public_config: starsState.public_config }], rowCount: 1 };
      }
      if (sql.includes('SELECT is_enabled, public_config, setup_status')) {
        return { rows: [{ ...starsState }], rowCount: 1 };
      }
      if (sql.includes('SET public_config = $2::jsonb')) {
        starsState.public_config = JSON.parse(argsOr(params, 1));
        starsState.setup_status = params[2];
        starsState.is_enabled = params[3];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function argsOr(params, i) {
  return params[i];
}

test('parsePaidPriceInput parses fiat, dual INR+Stars, Stars-only, and expiry formats', () => {
  assert.deepEqual(parsePaidPriceInput('149'), { priceMinor: 14900, currency: 'INR', starsPrice: null, expiresAt: null });
  assert.deepEqual(parsePaidPriceInput('49.50 USD'), { priceMinor: 4950, currency: 'USD', starsPrice: null, expiresAt: null });
  assert.deepEqual(parsePaidPriceInput('50 stars'), { priceMinor: 50, currency: 'XTR', starsPrice: 50, expiresAt: null });
  assert.deepEqual(parsePaidPriceInput('75⭐'), { priceMinor: 75, currency: 'XTR', starsPrice: 75, expiresAt: null });
  assert.deepEqual(parsePaidPriceInput('0|40'), { priceMinor: 40, currency: 'XTR', starsPrice: 40, expiresAt: null });

  const dual = parsePaidPriceInput('149|50|30');
  assert.equal(dual.priceMinor, 14900);
  assert.equal(dual.currency, 'INR');
  assert.equal(dual.starsPrice, 50);
  assert.ok(dual.expiresAt instanceof Date);

  assert.throws(() => parsePaidPriceInput('0'), /greater than 0/i);
  assert.throws(() => parsePaidPriceInput('99|bad'), /non-negative integer/i);
  assert.throws(() => parsePaidPriceInput('149|50|99999'), /1–3650/);
});

test('legacy paid_link_create and batch_link_create commands and prompts are completely removed', async () => {
  const bot = createFakeBot();
  const pool = createPaidWorkflowMockPool();
  registerPaidFileAdminCommands(bot, pool, { error() {}, warn() {} });
  registerPaidBatchAdminCommands(bot, pool, { error() {}, warn() {} });
  registerControlCenter(bot, { deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  assert.equal(findCommands(bot, 'paid_link_create').length, 0);
  assert.equal(findCommands(bot, 'batch_link_create').length, 0);

  for (const legacyAction of ['cc:prompt:paid_link_create', 'cc:prompt:batch_link_create']) {
    const act = findAction(bot, legacyAction);
    assert.ok(act);
    let answered = null;
    await act.handler({
      from: { id: 1 },
      match: act.match,
      answerCbQuery: async (msg, alert) => { answered = { msg, alert }; },
      editMessageText: async () => { throw new Error('Should not render legacy prompt'); },
    });
    assert.deepEqual(answered, { msg: 'Unknown prompt.', alert: { show_alert: true } });
  }

  // Main menu includes /plink button within Telegram's 64-byte callback_data limit
  const menuButtons = buildMainMenuKeyboard().inline_keyboard.flat();
  const plinkBtn = menuButtons.find((b) => b.callback_data === 'cc:plink');
  assert.ok(plinkBtn);
  for (const btn of menuButtons) {
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64);
  }
});

test('/plink Single workflow accepts sent media, prompts for price, and generates paid_<CODE> deep link', async () => {
  const bot = createFakeBot();
  const pool = createPaidWorkflowMockPool();
  registerControlCenter(bot, { deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  // Step 1: Run /plink -> shows Single and Batch options
  const plinkCmd = findCommands(bot, 'plink')[0];
  assert.ok(plinkCmd);
  const replies = [];
  await plinkCmd({
    from: { id: 1 },
    reply: async (text, options) => { replies.push({ text, options }); },
  });
  assert.match(replies[0].text, /Create Paid Link/);
  const buttons = replies[0].options.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'cc:plink_single'));
  assert.ok(buttons.some((b) => b.callback_data === 'cc:plink_batch'));

  // Step 2: Select Single -> asks user to send media
  const singleAction = findAction(bot, 'cc:plink_single');
  let edited;
  await singleAction.handler({
    from: { id: 1 },
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Send or forward ANY media file/);

  // Step 3: User sends a video -> indexed & prompted for price
  const mediaHandlers = bot.onHandlers.get('video,document,photo,audio,voice,video_note,animation');
  assert.ok(mediaHandlers?.length >= 1);
  let nextStorageMsgId = 900;
  await runMiddlewareChain(mediaHandlers, {
    from: { id: 1 },
    message: {
      message_id: 101,
      chat: { id: 1 },
      video: { file_id: 'tg_vid_1', file_unique_id: 'uniq_vid_1', file_name: 'Course_Intro.mp4', mime_type: 'video/mp4', file_size: 12000 },
    },
    telegram: {
      copyMessage: async () => ({ message_id: nextStorageMsgId++ }),
    },
    reply: async (text, options) => { replies.push({ text, options }); },
  });
  assert.equal(pool.files.size, 1);
  assert.match(replies.at(-1).text, /Set Single Paid Link Price/);
  assert.match(replies.at(-1).text, /Course_Intro\.mp4/);

  // Step 4: User sends dual INR+Stars price "149|50"
  const textHandlers = bot.onHandlers.get('text');
  await runMiddlewareChain(textHandlers, {
    from: { id: 1 },
    message: { text: '149|50' },
    reply: async (text, options) => { replies.push({ text, options }); },
  });

  assert.equal(pool.paidLinks.size, 1);
  const createdLink = [...pool.paidLinks.values()][0];
  assert.equal(createdLink.price_minor, 14900);
  assert.equal(createdLink.currency, 'INR');
  assert.equal(pool.starsState.public_config.stars_prices.paid_file[String(createdLink.id)], 50);

  const finalReply = replies.at(-1);
  assert.match(finalReply.text, /Paid Single Link Created/);
  assert.match(finalReply.text, new RegExp(`https://t\\.me/FilesDeliveryBot\\?start=paid_${createdLink.public_code}`));
  assert.match(finalReply.text, new RegExp(`/paid ${createdLink.public_code}`));
});

test('/plink Batch workflow collects media, sets title and price, creates pbatch_<CODE> link, and /done still delegates when inactive', async () => {
  const bot = createFakeBot();
  const pool = createPaidWorkflowMockPool();
  registerControlCenter(bot, { deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  // Select Batch option
  const batchAction = findAction(bot, 'cc:plink_batch');
  let edited;
  await batchAction.handler({
    from: { id: 2 },
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Create Batch Paid Link/);
  assert.match(edited.text, /Send or forward 2 to 20 media files/);

  // Send 2 media files
  const mediaHandlers = bot.onHandlers.get('video,document,photo,audio,voice,video_note,animation');
  const replies = [];
  let storageMsg = 500;
  for (let i = 1; i <= 2; i++) {
    await runMiddlewareChain(mediaHandlers, {
      from: { id: 2 },
      message: {
        message_id: 200 + i,
        chat: { id: 2 },
        document: { file_id: `doc_${i}`, file_unique_id: `uniq_doc_${i}`, file_name: `Pack_${i}.pdf`, mime_type: 'application/pdf', file_size: 2048 * i },
      },
      telegram: { copyMessage: async () => ({ message_id: storageMsg++ }) },
      reply: async (text, options) => { replies.push({ text, options }); },
    });
  }
  assert.equal(pool.files.size, 2);
  assert.match(replies.at(-1).text, /Added \(2\/20\): Pack_2\.pdf/);

  // Finish media step using /done command -> moves to title prompt
  const doneHandlers = findCommands(bot, 'done');
  assert.ok(doneHandlers.length >= 2);
  await runMiddlewareChain(doneHandlers, {
    from: { id: 2 },
    reply: async (text, options) => { replies.push({ text, options }); },
  });
  assert.match(replies.at(-1).text, /Batch Paid Link Title \(Step 2\/3/);

  // Send custom title -> moves to price prompt
  const textHandlers = bot.onHandlers.get('text');
  await runMiddlewareChain(textHandlers, {
    from: { id: 2 },
    message: { text: 'VIP Study Pack' },
    reply: async (text, options) => { replies.push({ text, options }); },
  });
  assert.match(replies.at(-1).text, /Set Batch Paid Link Price \(Step 3\/3\)/);
  assert.match(replies.at(-1).text, /Title: VIP Study Pack/);

  // Send Stars-only price "80 stars"
  await runMiddlewareChain(textHandlers, {
    from: { id: 2 },
    message: { text: '80 stars' },
    reply: async (text, options) => { replies.push({ text, options }); },
  });

  assert.equal(pool.paidBatches.size, 1);
  const createdBatch = [...pool.paidBatches.values()][0];
  assert.equal(createdBatch.title, 'VIP Study Pack');
  assert.equal(createdBatch.price_minor, 80);
  assert.equal(createdBatch.currency, 'XTR');
  assert.equal(pool.paidBatchItems.get(createdBatch.id).length, 2);
  assert.equal(pool.starsState.public_config.stars_prices.paid_batch[String(createdBatch.id)], 80);

  const finalReply = replies.at(-1);
  assert.match(finalReply.text, /Paid Batch Link Created/);
  assert.match(finalReply.text, new RegExp(`https://t\\.me/FilesDeliveryBot\\?start=pbatch_${createdBatch.public_code}`));
  assert.match(finalReply.text, new RegExp(`/batch ${createdBatch.public_code}`));

  // After finishing /plink batch, /done for another user delegates cleanly to share-links-ui without error
  const shareReplies = [];
  await runMiddlewareChain(doneHandlers, {
    from: { id: 99 },
    reply: async (text, options) => { shareReplies.push({ text, options }); },
  });
  assert.match(shareReplies[0].text, /No active \/Batch collection session/);
});

test('Delivery Bot /start paid_<CODE> and /start pbatch_<CODE> handle checkout and immediate unlocked delivery', async () => {
  const paidCode = 'A1B2C3D4E5';
  const batchCode = 'F1E2D3C4B5';
  let alreadyPaid = false;
  const queuedFileIds = [];

  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM paid_file_links WHERE public_code_hash = $1')) {
        return { rows: [{ id: 10, file_id: 501, price_minor: 14900, currency: 'INR' }], rowCount: 1 };
      }
      if (sql.includes('FROM paid_file_purchases')) {
        return alreadyPaid ? { rows: [{ id: 1, status: 'paid' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM paid_batch_links WHERE public_code_hash = $1')) {
        return { rows: [{ id: 20, title: 'VIP Study Pack', price_minor: 19900, currency: 'INR' }], rowCount: 1 };
      }
      if (sql.includes('FROM paid_batch_purchases')) {
        return alreadyPaid ? { rows: [{ id: 2, status: 'paid' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO delivery_jobs')) return { rows: [{ id: 777 }], rowCount: 1 };
      if (sql.includes('INSERT INTO delivery_items')) {
        queuedFileIds.push(params[1]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const pool = {
    async connect() { return client; },
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM force_sub_channels') || sql.includes("key = 'force_sub_enabled'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM paid_file_links pfl')) {
        return {
          rows: [{
            id: 10,
            public_code: paidCode,
            file_id: 501,
            price_minor: 14900,
            currency: 'INR',
            is_enabled: true,
            expires_at: null,
            file_code: 'FILE501',
            file_name: 'Lecture_1.mp4',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM paid_batch_links b JOIN paid_batch_items') && sql.includes('GROUP BY b.id')) {
        return {
          rows: [{
            id: 20,
            public_code: batchCode,
            title: 'VIP Study Pack',
            price_minor: 19900,
            currency: 'INR',
            is_enabled: true,
            expires_at: null,
            item_count: 2,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM files f LEFT JOIN storage_messages')) {
        return {
          rows: [{ id: 501, file_code: 'FILE501', file_name: 'Lecture_1.mp4', telegram_message_id: 11, storage_chat_id: -1001, storage_channel_enabled: true }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM paid_batch_links b JOIN paid_batch_items i') && sql.includes('ORDER BY i.position')) {
        return {
          rows: [
            { id: 501, file_code: 'FILE501', file_name: 'Lecture_1.mp4', telegram_message_id: 11, storage_chat_id: -1001, storage_channel_enabled: true },
            { id: 502, file_code: 'FILE502', file_name: 'Lecture_2.mp4', telegram_message_id: 12, storage_chat_id: -1001, storage_channel_enabled: true },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('INSERT INTO payment_sessions')) {
        return { rows: [{ id: 88 }], rowCount: 1 };
      }
      if (sql.includes('FROM payment_methods WHERE method=$1')) {
        return { rows: [{ is_enabled: true, public_config: { stars_prices: { paid_file: { '10': 50 }, paid_batch: { '20': 90 } } } }], rowCount: 1 };
      }
      if (sql.includes('FROM payment_methods WHERE method = $1')) {
        return { rows: [{ is_enabled: false, public_config: {}, secret_ciphertext: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const config = { adminIds: [], deliveryBotToken: '123456:TESTTOKEN', tokenEncryptionKey: randomBytes(32).toString('base64') };
  const runtime = createDeliveryBot(config, { warn() {}, error() {}, info() {} }, pool, config.deliveryBotToken);
  const sentInvoices = [];
  const replies = [];
  runtime.bot.botInfo = { id: 123456, is_bot: true, first_name: 'Delivery', username: 'FilesDeliveryBot' };
  runtime.bot.context.reply = async (text, extra) => { replies.push({ text, extra }); return { message_id: 1 }; };
  runtime.bot.telegram.sendInvoice = async (chatId, payload) => { sentInvoices.push({ chatId, ...payload }); return { message_id: 2 }; };

  const makeStartUpdate = (payload, uid = 7001) => ({
    update_id: uid,
    message: {
      message_id: uid,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 555, type: 'private' },
      from: { id: 555, is_bot: false, first_name: 'Buyer' },
      text: `/start ${payload}`,
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });

  // Unpaid -> launches Stars invoice (since FamPay is disabled here and Stars price is configured)
  await runtime.bot.handleUpdate(makeStartUpdate(`paid_${paidCode}`, 1));
  await runtime.bot.handleUpdate(makeStartUpdate(`pbatch_${batchCode}`, 2));
  assert.equal(sentInvoices.length, 2);
  assert.equal(sentInvoices[0].currency, 'XTR');
  assert.equal(sentInvoices[0].prices[0].amount, 50);
  assert.equal(sentInvoices[1].prices[0].amount, 90);

  // Already paid -> queues immediate single & batch delivery jobs
  alreadyPaid = true;
  await runtime.bot.handleUpdate(makeStartUpdate(`paid_${paidCode}`, 3));
  await runtime.bot.handleUpdate(makeStartUpdate(`pbatch_${batchCode}`, 4));
  assert.deepEqual(queuedFileIds, [501, 501, 502]);
  assert.match(replies[0].text, /Paid access verified\. Delivery queued/);
  assert.match(replies[1].text, /Paid batch verified\. Delivery queued/);
});

test('Main Bot deletes normal share links, paid single links, and paid batch links via inline UI and commands', async () => {
  const bot = createFakeBot();
  const shareLinks = new Map([
    [1, { id: 1, link_code: 's_normal01', link_type: 'single', title: 'Normal Share', is_enabled: true, created_at: new Date(), updated_at: new Date(), items: [{ position: 1, file_id: 11, file_code: 'F1', file_name: 'One.mp4', file_type: 'video', file_size: 100, file_status: 'active' }] }],
  ]);
  const paidLinks = new Map([
    [5, { id: 5, public_code: 'PAIDCODE5', public_code_hash: hashUpperCode('PAIDCODE5'), file_id: 11, file_code: 'F1', file_name: 'One.mp4', file_type: 'video', file_size: 100, price_minor: 9900, currency: 'INR', is_enabled: true, expires_at: null, created_at: new Date(), purchase_count: 1 }],
  ]);
  const paidBatches = new Map([
    [8, { id: 8, public_code: 'BATCHCODE8', public_code_hash: hashUpperCode('BATCHCODE8'), title: 'Paid Bundle', price_minor: 19900, currency: 'INR', is_enabled: true, expires_at: null, created_at: new Date(), item_count: 2, purchase_count: 1 }],
  ]);
  const paidFilePurchases = new Set([5]);
  const paidBatchPurchases = new Set([8]);
  const paidBatchItems = new Set([8]);
  const starsState = {
    is_enabled: true,
    public_config: { stars_prices: { premium: {}, paid_file: { '5': 50 }, paid_batch: { '8': 90 } } },
    setup_status: 'configured',
    last_test_status: 'ok',
    last_test_error: null,
  };

  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id, public_code, file_id FROM paid_file_links WHERE')) {
        const match = [...paidLinks.values()].find((r) => (sql.includes('id = $1') ? r.id === Number(params[0]) : r.public_code_hash === params[0]));
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM paid_file_purchases WHERE paid_link_id = $1')) {
        paidFilePurchases.delete(Number(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM paid_file_links WHERE id = $1')) {
        const row = paidLinks.get(Number(params[0]));
        paidLinks.delete(Number(params[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('SELECT id, public_code, title FROM paid_batch_links WHERE')) {
        const match = [...paidBatches.values()].find((r) => (sql.includes('id = $1') ? r.id === Number(params[0]) : r.public_code_hash === params[0]));
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM paid_batch_purchases WHERE batch_link_id = $1')) {
        paidBatchPurchases.delete(Number(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM paid_batch_items WHERE batch_link_id = $1')) {
        paidBatchItems.delete(Number(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM paid_batch_links WHERE id = $1')) {
        const row = paidBatches.get(Number(params[0]));
        paidBatches.delete(Number(params[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const pool = {
    async connect() { return client; },
    async query(sql, params = []) {
      if (sql.includes('FROM delivery_bots')) return { rows: [{ username: 'FilesDeliveryBot' }], rowCount: 1 };
      if (sql.includes('SELECT COUNT(*)::int AS total FROM share_links')) return { rows: [{ total: shareLinks.size }], rowCount: 1 };
      if (sql.includes('FROM share_links sl')) {
        const rows = [...shareLinks.values()].map((l) => ({ ...l, item_count: l.items.length }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('DELETE FROM share_links WHERE')) {
        const match = [...shareLinks.values()].find((r) => (sql.includes('id = $1') ? r.id === Number(params[0]) : r.link_code === params[0]));
        if (match) shareLinks.delete(match.id);
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }
      if (sql.includes('FROM share_links WHERE')) {
        const match = [...shareLinks.values()].find((r) => (sql.includes('id = $1') ? r.id === Number(params[0]) : r.link_code === params[0]));
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }
      if (sql.includes('FROM share_link_items i')) {
        const row = shareLinks.get(Number(params[0]));
        return { rows: row?.items ?? [], rowCount: row?.items?.length ?? 0 };
      }
      if (sql.includes('FROM paid_file_links pfl') && sql.includes('ORDER BY pfl.created_at DESC')) {
        const rows = [...paidLinks.values()];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM paid_file_links pfl') && sql.includes('WHERE pfl.')) {
        const match = [...paidLinks.values()].find((r) => (sql.includes('pfl.id = $1') ? r.id === Number(params[0]) : r.public_code_hash === params[0]));
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }
      if (sql.includes('FROM paid_batch_links b') && sql.includes('ORDER BY b.created_at DESC')) {
        const rows = [...paidBatches.values()];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('FROM paid_batch_links b') && sql.includes('WHERE b.')) {
        const match = [...paidBatches.values()].find((r) => (sql.includes('b.id = $1') ? r.id === Number(params[0]) : r.public_code_hash === params[0]));
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }
      if (sql.includes('SELECT is_enabled, public_config, setup_status')) {
        return { rows: [{ ...starsState }], rowCount: 1 };
      }
      if (sql.includes('SELECT is_enabled, public_config FROM payment_methods')) {
        return { rows: [{ is_enabled: starsState.is_enabled, public_config: starsState.public_config }], rowCount: 1 };
      }
      if (sql.includes('SET public_config = $2::jsonb')) {
        starsState.public_config = JSON.parse(params[1]);
        starsState.setup_status = params[2];
        starsState.is_enabled = params[3];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  registerPaidFileAdminCommands(bot, pool, { error() {}, warn() {} });
  registerPaidBatchAdminCommands(bot, pool, { error() {}, warn() {} });
  registerControlCenter(bot, { deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  // 1. Normal share links list shows delete button and confirms deletion
  let edited;
  const linksView = findAction(bot, 'cc:links:0');
  await linksView.handler({
    from: { id: 1 },
    match: linksView.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:lnk_del:1'));

  const lnkDel = findAction(bot, 'cc:lnk_del:1');
  await lnkDel.handler({
    from: { id: 1 },
    match: lnkDel.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:lnk_del_ok:1'));

  const lnkDelOk = findAction(bot, 'cc:lnk_del_ok:1');
  await lnkDelOk.handler({
    from: { id: 1 },
    match: lnkDelOk.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.equal(shareLinks.size, 0);

  // 2. Paid single links list shows delete button -> confirmation -> deletes link, purchases, and Stars price
  const paidView = findAction(bot, 'cc:paid');
  await paidView.handler({
    from: { id: 1 },
    match: paidView.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  const paidBtns = edited.options.reply_markup.inline_keyboard.flat();
  assert.ok(paidBtns.some((b) => b.callback_data === 'cc:paid_view:5'));
  assert.ok(paidBtns.some((b) => b.callback_data === 'cc:paid_del:5'));

  const paidDel = findAction(bot, 'cc:paid_del:5');
  await paidDel.handler({
    from: { id: 1 },
    match: paidDel.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Confirm deletion/);
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:paid_del_ok:5'));

  const paidDelOk = findAction(bot, 'cc:paid_del_ok:5');
  await paidDelOk.handler({
    from: { id: 1 },
    match: paidDelOk.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.equal(paidLinks.size, 0);
  assert.equal(paidFilePurchases.has(5), false);
  assert.equal(starsState.public_config.stars_prices.paid_file['5'], undefined);

  // 3. Paid batch links list shows delete button -> confirmation -> deletes batch, items, purchases, and Stars price
  const batchView = findAction(bot, 'cc:batch');
  await batchView.handler({
    from: { id: 1 },
    match: batchView.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  const batchBtns = edited.options.reply_markup.inline_keyboard.flat();
  assert.ok(batchBtns.some((b) => b.callback_data === 'cc:batch_view:8'));
  assert.ok(batchBtns.some((b) => b.callback_data === 'cc:batch_del:8'));

  const batchDel = findAction(bot, 'cc:batch_del:8');
  await batchDel.handler({
    from: { id: 1 },
    match: batchDel.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Confirm deletion/);
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:batch_del_ok:8'));

  const batchDelOk = findAction(bot, 'cc:batch_del_ok:8');
  await batchDelOk.handler({
    from: { id: 1 },
    match: batchDelOk.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.equal(paidBatches.size, 0);
  assert.equal(paidBatchPurchases.has(8), false);
  assert.equal(paidBatchItems.has(8), false);
  assert.equal(starsState.public_config.stars_prices.paid_batch['8'], undefined);

  // 4. Slash commands /link_delete, /paid_link_delete, and /batch_link_delete work by code too
  shareLinks.set(2, { id: 2, link_code: 's_cmd02', link_type: 'single', title: 'Cmd Normal', is_enabled: true, items: [] });
  paidLinks.set(6, { id: 6, public_code: 'PAID6', public_code_hash: hashUpperCode('PAID6'), file_id: 11, price_minor: 5000, currency: 'INR' });
  paidBatches.set(9, { id: 9, public_code: 'BATCH9', public_code_hash: hashUpperCode('BATCH9'), title: 'Cmd Batch', price_minor: 8000, currency: 'INR' });

  const cmdReplies = [];
  await findCommands(bot, 'link_delete')[0]({
    from: { id: 1 },
    message: { text: '/link_delete s_cmd02' },
    reply: async (t) => cmdReplies.push(t),
  });
  await findCommands(bot, 'paid_link_delete')[0]({
    from: { id: 1 },
    message: { text: '/paid_link_delete PAID6' },
    reply: async (t) => cmdReplies.push(t),
  });
  await findCommands(bot, 'batch_link_delete')[0]({
    from: { id: 1 },
    message: { text: '/batch_link_delete BATCH9' },
    reply: async (t) => cmdReplies.push(t),
  });
  assert.equal(shareLinks.size, 0);
  assert.equal(paidLinks.size, 0);
  assert.equal(paidBatches.size, 0);
  assert.match(cmdReplies[0], /Deleted share link s_cmd02/);
  assert.match(cmdReplies[1], /Deleted paid link PAID6/);
  assert.match(cmdReplies[2], /Deleted paid batch link BATCH9/);
});
