import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  normalizeGmailAddress,
  normalizeAppPassword,
  normalizeUpiId,
  maskEmail,
  decodeMimeText,
  parseFamPayEmail,
  buildUpiPaymentUri,
  generateUpiQrBuffer,
  loadFamPayConfig,
  saveFamPayConfig,
  enableFamPay,
  createFamPayCheckout,
  verifyFamPaySession,
} from '../src/payments/fampay.js';
import { applyVerifiedPayment } from '../src/payments/fulfillment-repository.js';

const TEST_KEY = randomBytes(32).toString('base64');

test('FamPay input normalizers validate Gmail, App Password, UPI ID, and mask email', () => {
  assert.equal(normalizeGmailAddress('  User@Gmail.COM '), 'user@gmail.com');
  assert.throws(() => normalizeGmailAddress('invalid-email'), /valid Gmail/);

  assert.equal(normalizeAppPassword(' abcd efgh ijkl mnop '), 'abcdefghijklmnop');
  assert.throws(() => normalizeAppPassword('short'), /8–64 characters/);

  assert.equal(normalizeUpiId('  TestUser@FAM '), 'testuser@fam');
  assert.throws(() => normalizeUpiId('not-a-upi'), /valid UPI ID/);

  assert.equal(maskEmail('telebottg7@gmail.com'), 'tel***@gmail.com');
});

test('FamPay MIME decoder and email parser extract amount, 12-digit UTR, and ignore debits', () => {
  const htmlEmail = [
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<html><body><p>You have received =E2=82=B999.03 from Alice via UPI. Ref FS42 UTR: 412345678901</p></body></html>',
  ].join('\r\n');

  const decoded = decodeMimeText(htmlEmail);
  assert.match(decoded, /received ₹99\.03/);
  assert.match(decoded, /412345678901/);

  const parsed = parseFamPayEmail({
    from: 'FamPay <no-reply@fampay.in>',
    subject: 'Money Received via UPI',
    rawSource: htmlEmail,
    date: new Date(),
    messageId: '<msg-1@gmail.com>',
  });
  assert.equal(parsed.amountMinor, 9903);
  assert.equal(parsed.utr, '412345678901');
  assert.equal(parsed.txnRef, 'FS42');

  const debit = parseFamPayEmail({
    from: 'FamPay <no-reply@fampay.in>',
    subject: 'You paid ₹99.03',
    text: 'You paid ₹99.03 to Bob. UTR: 412345678902',
    date: new Date(),
  });
  assert.equal(debit, null);
});

test('FamPay URI builder and QR generator produce a valid UPI link and PNG QR buffer', async () => {
  const uri = buildUpiPaymentUri({
    upiId: 'merchant@fam',
    merchantName: 'FileStore',
    amountMinor: 9903,
    txnNote: 'Monthly FS15',
    txnRef: 'FS15',
  });
  assert.match(uri, /^upi:\/\/pay\?pa=merchant@fam&/);
  assert.match(uri, /am=99\.03/);
  assert.match(uri, /cu=INR/);
  assert.match(uri, /tr=FS15/);

  const buf = await generateUpiQrBuffer(uri);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 4).toString('hex'), '89504e47'); // PNG magic bytes
});

test('FamPay config save/load encrypts Gmail App Password and enables once complete', async () => {
  const state = {
    is_enabled: false,
    public_config: {},
    secret_ciphertext: null,
    setup_status: 'not_configured',
    last_test_status: 'unknown',
    last_test_error: null,
  };
  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes('SELECT is_enabled, public_config, secret_ciphertext')) {
        return { rowCount: 1, rows: [{ ...state }] };
      }
      if (sql.includes('SELECT secret_ciphertext FROM payment_methods')) {
        return { rowCount: 1, rows: [{ secret_ciphertext: state.secret_ciphertext }] };
      }
      if (sql.includes('UPDATE payment_methods') && sql.includes('secret_ciphertext')) {
        state.public_config = JSON.parse(args[1]);
        state.secret_ciphertext = args[2];
        state.setup_status = args[3];
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SET is_enabled = TRUE')) {
        state.is_enabled = true;
        state.setup_status = 'configured';
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  const config = { tokenEncryptionKey: TEST_KEY };
  const partial = await saveFamPayConfig(pool, config, {
    gmailEmail: 'owner@gmail.com',
    gmailAppPassword: 'abcd efgh ijkl mnop',
  }, 1001);
  assert.equal(partial.gmailEmail, 'owner@gmail.com');
  assert.equal(partial.hasAppPassword, true);
  assert.equal(partial.isConfigured, false);
  assert.ok(state.secret_ciphertext && !state.secret_ciphertext.includes('abcdefghijklmnop'));

  await assert.rejects(() => enableFamPay(pool, config, 1001), /Set FamPay UPI ID first/);

  const full = await saveFamPayConfig(pool, config, { upiId: 'owner@fam', merchantName: 'MyStore' }, 1001);
  assert.equal(full.isConfigured, true);
  assert.equal(full.upiId, 'owner@fam');
  assert.equal(full.gmailAppPassword, 'abcdefghijklmnop');

  const enabled = await enableFamPay(pool, config, 1001);
  assert.equal(enabled.isEnabled, true);
});

test('FamPay checkout allocates unused dynamic paise offset and prevents collision', async () => {
  const createdSessions = [];
  const client = {
    query: async (sql, args = []) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT expected_amount_minor FROM payment_sessions')) {
        return { rows: [{ expected_amount_minor: 9901 }] }; // 9901 already taken
      }
      if (sql.includes('INSERT INTO payment_sessions')) {
        const row = {
          id: 55,
          user_telegram_id: args[0],
          method: args[1],
          purpose: args[2],
          plan_id: args[3],
          expected_amount_minor: args[7],
          currency: args[8],
          status: 'pending',
          expires_at: args[9],
          created_at: new Date(),
        };
        createdSessions.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
    release() {},
  };

  const { encryptBotToken } = await import('../src/security/token-encryption.js');
  const encryptedSecret = encryptBotToken(JSON.stringify({ gmailAppPassword: 'abcdefghijklmnop' }), TEST_KEY);
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM payment_methods')) {
        return {
          rowCount: 1,
          rows: [{
            is_enabled: true,
            public_config: { gmailEmail: 'pay@gmail.com', upiId: 'shop@fam', merchantName: 'Shop' },
            secret_ciphertext: encryptedSecret,
            setup_status: 'configured',
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    connect: async () => client,
  };

  const checkout = await createFamPayCheckout(pool, { tokenEncryptionKey: TEST_KEY }, {
    userId: 888,
    purpose: 'premium',
    target: { planId: 2 },
    baseAmountMinor: 9900,
    currency: 'INR',
    label: 'Monthly (30d)',
    deliveryBotId: 77,
  });
  assert.equal(checkout.amountMinor, 9902); // skipped 9901!
  assert.equal(checkout.txnRef, 'FS55');
  assert.match(checkout.upiUri, /am=99\.02/);
  assert.equal(checkout.qrBuffer.slice(0, 4).toString('hex'), '89504e47');
});

test('FamPay verification + fulfillment matches IMAP email, enforces UTR check, and activates Premium', async () => {
  const { encryptBotToken } = await import('../src/security/token-encryption.js');
  const encryptedSecret = encryptBotToken(JSON.stringify({ gmailAppPassword: 'abcdefghijklmnop' }), TEST_KEY);

  const session = {
    id: 70,
    user_telegram_id: 9001,
    method: 'fampay',
    purpose: 'premium',
    plan_id: 3,
    file_id: null,
    batch_link_id: null,
    paid_link_id: null,
    expected_amount_minor: 9904,
    currency: 'INR',
    status: 'pending',
    expires_at: new Date(Date.now() + 600_000),
    created_at: new Date(Date.now() - 10_000),
    metadata: { txnRef: 'FS70', baseAmountMinor: 9900, paiseOffset: 4 },
  };

  let membershipGranted = false;
  let storedTx = null;

  const txClient = {
    query: async (sql, args = []) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM payment_sessions')) return { rowCount: 1, rows: [session] };
      if (sql.includes('FROM payment_transactions WHERE method = $1 AND external_transaction_id')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO payment_transactions')) {
        storedTx = {
          id: 301,
          user_telegram_id: args[0],
          method: args[1],
          external_transaction_id: args[2],
          utr: args[3],
          purpose: args[4],
          plan_id: args[5],
          file_id: args[6],
          batch_link_id: args[7],
          paid_link_id: args[8],
          amount_minor: args[9],
          currency: args[10],
          status: 'verified',
          session_id: args[11],
        };
        return { rowCount: 1, rows: [storedTx] };
      }
      if (sql.includes("UPDATE payment_sessions SET status = 'verified'")) {
        session.status = 'verified';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM payment_transactions WHERE id = $1')) return { rowCount: 1, rows: [storedTx] };
      if (sql.includes('FROM premium_plans')) {
        return { rowCount: 1, rows: [{ id: 3, name: 'Pro', price_minor: 9900, currency: 'INR', duration_days: 30 }] };
      }
      if (sql.includes('FROM premium_memberships')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO premium_memberships')) {
        membershipGranted = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE payment_transactions SET status='applied'")) {
        storedTx.status = 'applied';
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE payment_sessions SET status='applied'")) {
        session.status = 'applied';
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };

  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM payment_sessions WHERE id = $1')) return { rowCount: 1, rows: [session] };
      if (sql.includes('FROM payment_methods')) {
        return {
          rowCount: 1,
          rows: [{
            is_enabled: true,
            public_config: { gmailEmail: 'pay@gmail.com', upiId: 'shop@fam', merchantName: 'Shop' },
            secret_ciphertext: encryptedSecret,
            setup_status: 'configured',
          }],
        };
      }
      if (sql.includes('SELECT 1 FROM payment_transactions')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO payment_provider_events')) return { rows: [{ id: 501, processing_status: 'received' }] };
      if (sql.includes('UPDATE payment_provider_events')) return { rows: [{ id: 501, processing_status: 'processed' }] };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => txClient,
  };

  const fakeImapFactory = () => ({
    async connect() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [101]; },
    async *fetch() {
      yield {
        uid: 101,
        internalDate: new Date(),
        envelope: {
          from: [{ name: 'FamPay', address: 'no-reply@fampay.in' }],
          subject: 'You received ₹99.04',
          messageId: '<fp-101@fampay.in>',
        },
        source: Buffer.from('Content-Type: text/plain\r\n\r\nYou received ₹99.04 via UPI. UTR: 556677889900 Ref FS70'),
      };
    },
    async logout() {},
  });

  // Wrong UTR fails to match
  const wrongUtr = await verifyFamPaySession(pool, { tokenEncryptionKey: TEST_KEY }, 70, {
    userId: 9001,
    submittedUtr: '111122223333',
    imapClientFactory: fakeImapFactory,
  });
  assert.equal(wrongUtr.status, 'pending');
  assert.equal(membershipGranted, false);

  // Matching session + email verifies and activates Premium (including 9904 dynamic paise offset against 9900 plan!)
  const verified = await verifyFamPaySession(pool, { tokenEncryptionKey: TEST_KEY }, 70, {
    userId: 9001,
    submittedUtr: '556677889900',
    imapClientFactory: fakeImapFactory,
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.utr, '556677889900');
  assert.equal(membershipGranted, true);
  assert.equal(session.status, 'applied');
  assert.equal(storedTx.utr, '556677889900');

  // Verify applyVerifiedPayment idempotency on the applied transaction
  const repeat = await applyVerifiedPayment(pool, storedTx.id);
  assert.equal(repeat.alreadyApplied, true);
});

test('Main Bot FamPay setup UI and Delivery Bot /premium dual checkout (UPI QR + Stars) work end-to-end', async () => {
  const { registerControlCenter } = await import('../src/bot/control-center.js');
  const { createDeliveryBot } = await import('../src/delivery/bot.js');

  const fpRow = {
    is_enabled: false,
    public_config: {},
    secret_ciphertext: null,
    setup_status: 'not_configured',
    last_test_status: 'unknown',
    last_test_error: null,
  };
  const starsRow = {
    is_enabled: true,
    public_config: { stars_prices: { premium: { '1': 50 } } },
  };
  const plans = [
    { id: 1, name: 'Gold', price_minor: 9900, currency: 'INR', duration_days: 30, is_enabled: true },
  ];

  const txClient = {
    async query(sql, args = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT expected_amount_minor FROM payment_sessions')) return { rows: [] };
      if (sql.includes('INSERT INTO payment_sessions')) {
        return {
          rows: [{
            id: 91,
            user_telegram_id: args[0],
            method: args[1],
            purpose: args[2],
            plan_id: args[3],
            expected_amount_minor: args[7],
            currency: args[8],
            status: 'pending',
            expires_at: args[9],
            created_at: new Date(),
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };

  const pool = {
    async query(sql, args = []) {
      if (sql.includes('SELECT is_enabled, public_config, secret_ciphertext')) return { rowCount: 1, rows: [{ ...fpRow }] };
      if (sql.includes('SELECT secret_ciphertext FROM payment_methods')) return { rowCount: 1, rows: [{ secret_ciphertext: fpRow.secret_ciphertext }] };
      if (sql.includes('UPDATE payment_methods') && sql.includes('secret_ciphertext')) {
        fpRow.public_config = JSON.parse(args[1]);
        fpRow.secret_ciphertext = args[2];
        fpRow.setup_status = args[3];
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SET is_enabled = TRUE')) {
        fpRow.is_enabled = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("WHERE method=$1") || sql.includes("WHERE method = $1")) {
        if (args[0] === 'telegram_stars') return { rowCount: 1, rows: [{ ...starsRow }] };
        if (args[0] === 'fampay') return { rowCount: 1, rows: [{ ...fpRow }] };
      }
      if (sql.includes('FROM premium_plans WHERE id=$1')) return { rowCount: 1, rows: [plans[0]] };
      if (sql.includes('FROM premium_plans')) return { rowCount: 1, rows: plans };
      if (sql.includes('FROM payment_sessions')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => txClient,
  };

  // 1. Test Main Bot Control Center FamPay configuration
  const commands = [];
  const actions = [];
  const onHandlers = new Map();
  const fakeMainBot = {
    command(name, handler) { commands.push({ name, handler }); },
    action(pattern, handler) { actions.push({ pattern, handler }); },
    on(event, handler) { onHandlers.set(event, handler); },
  };
  const cfg = { tokenEncryptionKey: TEST_KEY, adminIds: [111] };
  registerControlCenter(fakeMainBot, cfg, { info() {}, warn() {}, error() {} }, pool);

  const findAction = (data) => {
    for (const a of actions) {
      if (typeof a.pattern === 'string' && a.pattern === data) return { handler: a.handler, match: [data] };
      if (a.pattern instanceof RegExp) {
        const m = data.match(a.pattern);
        if (m) return { handler: a.handler, match: m };
      }
    }
    return null;
  };

  let lastMainEdit = null;
  await findAction('cc:fampay_cfg').handler({
    from: { id: 111 },
    answerCbQuery: async () => {},
    editMessageText: async (text, opts) => { lastMainEdit = { text, opts }; },
  });
  assert.match(lastMainEdit.text, /FamPay UPI & Gmail Verification/);

  await findAction('cc:prompt:fampay_all').handler({
    from: { id: 111 },
    match: ['cc:prompt:fampay_all', 'fampay_all'],
    answerCbQuery: async () => {},
    editMessageText: async () => {},
  });

  let deletedSecretMsg = false;
  let savedReply = null;
  await onHandlers.get('text')({
    from: { id: 111 },
    message: { text: 'boss@gmail.com|abcd efgh ijkl mnop|boss@fam|BossStore' },
    deleteMessage: async () => { deletedSecretMsg = true; },
    reply: async (text, opts) => { savedReply = { text, opts }; },
  }, async () => {});

  assert.equal(deletedSecretMsg, true);
  assert.match(savedReply.text, /FamPay credentials saved!/);
  assert.match(savedReply.text, /boss@fam/);
  assert.equal(fpRow.public_config.gmailEmail, 'boss@gmail.com');
  assert.equal(fpRow.public_config.upiId, 'boss@fam');

  // Enable FamPay via button
  await findAction('cc:pay_en_fampay').handler({
    from: { id: 111 },
    answerCbQuery: async () => {},
    editMessageText: async () => {},
  });
  assert.equal(fpRow.is_enabled, true);

  // 2. Test Delivery Bot /premium offering both UPI QR & Telegram Stars
  const delivery = createDeliveryBot(cfg, { info() {}, warn() {}, error() {} }, pool, '123456:TESTTOKEN');
  delivery.bot.botInfo = { id: 555, username: 'TestDeliveryBot' };
  const replies = [];
  const photos = [];
  const edits = [];
  delivery.bot.context.reply = async function (text, extra) { replies.push({ text, extra }); };
  delivery.bot.context.replyWithPhoto = async function (photo, extra) { photos.push({ photo, extra }); };
  delivery.bot.context.editMessageText = async function (text, extra) { edits.push({ text, extra }); };
  delivery.bot.context.answerCbQuery = async function () {};

  await delivery.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 10, date: 1700000000, chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Buyer' }, text: '/premium', entities: [{ type: 'bot_command', offset: 0, length: 8 }] },
  });
  assert.equal(replies.length, 1);
  assert.match(replies[0].extra.reply_markup.inline_keyboard[0][0].text, /UPI 99\.00 INR \/ 50 ⭐/);

  await delivery.bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'cb1',
      from: { id: 222, first_name: 'Buyer' },
      message: { message_id: 11, date: 1700000001, chat: { id: 222, type: 'private' }, text: 'Choose a Premium plan' },
      data: 'fs_premium_1',
    },
  });
  assert.equal(edits.length, 1);
  const methodButtons = edits[0].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(methodButtons.includes('fs_prem_upi_1'));
  assert.ok(methodButtons.includes('fs_prem_stars_1'));

  await delivery.bot.handleUpdate({
    update_id: 3,
    callback_query: {
      id: 'cb2',
      from: { id: 222, first_name: 'Buyer' },
      message: { message_id: 11, date: 1700000002, chat: { id: 222, type: 'private' }, text: 'Choose method' },
      data: 'fs_prem_upi_1',
    },
  });
  assert.equal(photos.length, 1);
  assert.ok(Buffer.isBuffer(photos[0].photo.source));
  assert.match(photos[0].extra.caption, /99\.01 INR/);
  assert.match(photos[0].extra.caption, /boss@fam/);
});

test('Delivery Bot /paid and /batch support both FamPay UPI QR and Telegram Stars checkout', async () => {
  const { createDeliveryBot } = await import('../src/delivery/bot.js');
  const { encryptBotToken } = await import('../src/security/token-encryption.js');
  const encryptedSecret = encryptBotToken(JSON.stringify({ gmailAppPassword: 'abcdefghijklmnop' }), TEST_KEY);

  let nextSessionId = 200;
  const paidLink = {
    id: 12,
    public_code: 'PAID12',
    file_id: 77,
    file_code: 'FILE77',
    file_name: 'Course.pdf',
    price_minor: 4900,
    currency: 'INR',
    is_enabled: true,
    is_active: true,
    expires_at: null,
  };
  const batchLink = {
    id: 9,
    public_code: 'BATCH9',
    title: 'Mega Pack',
    price_minor: 14900,
    currency: 'INR',
    is_enabled: true,
    is_active: true,
    expires_at: null,
    item_count: 3,
  };

  const txClient = {
    async query(sql, args = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM paid_file_links')) return { rowCount: 1, rows: [paidLink] };
      if (sql.includes('FROM paid_batch_links')) return { rowCount: 1, rows: [batchLink] };
      if (sql.includes('SELECT expected_amount_minor FROM payment_sessions')) return { rows: [] };
      if (sql.includes('INSERT INTO payment_sessions')) {
        nextSessionId += 1;
        return {
          rows: [{
            id: nextSessionId,
            user_telegram_id: args[0],
            method: args[1],
            purpose: args[2],
            plan_id: args[3],
            file_id: args[4],
            paid_link_id: args[5],
            batch_link_id: args[6],
            expected_amount_minor: args[7],
            currency: args[8],
            status: 'pending',
            expires_at: args[9],
            created_at: new Date(),
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };

  const pool = {
    async query(sql, args = []) {
      if (sql.includes("WHERE method=$1") || sql.includes("WHERE method = $1")) {
        if (args[0] === 'telegram_stars') {
          return {
            rowCount: 1,
            rows: [{
              is_enabled: true,
              public_config: { stars_prices: { paid_file: { '12': 30 }, paid_batch: { '9': 95 } } },
            }],
          };
        }
        if (args[0] === 'fampay') {
          return {
            rowCount: 1,
            rows: [{
              is_enabled: true,
              public_config: { gmailEmail: 'pay@gmail.com', upiId: 'shop@fam', merchantName: 'Shop' },
              secret_ciphertext: encryptedSecret,
              setup_status: 'configured',
            }],
          };
        }
      }
      if (sql.includes('FROM paid_file_links pfl')) {
        return { rowCount: 1, rows: [paidLink] };
      }
      if (sql.includes('FROM paid_batch_links b')) {
        return { rowCount: 1, rows: [batchLink] };
      }
      if (sql.includes('FROM paid_file_entitlements') || sql.includes('FROM paid_file_requests') || sql.includes('FROM paid_batch_requests')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO paid_file_requests')) {
        return { rowCount: 1, rows: [{ id: 501, status: 'pending' }] };
      }
      if (sql.includes('INSERT INTO paid_batch_requests')) {
        return { rowCount: 1, rows: [{ id: 601, status: 'pending' }] };
      }
      if (sql.includes('INSERT INTO payment_sessions')) {
        nextSessionId += 1;
        return {
          rowCount: 1,
          rows: [{
            id: nextSessionId,
            user_telegram_id: args[0],
            method: args[1],
            purpose: args[2],
            expected_amount_minor: args[7],
            currency: args[8],
          }],
        };
      }
      if (sql.includes('FROM payment_sessions')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => txClient,
  };

  const cfg = { tokenEncryptionKey: TEST_KEY, adminIds: [111] };
  const delivery = createDeliveryBot(cfg, { info() {}, warn() {}, error() {} }, pool, '123456:TESTTOKEN');
  delivery.bot.botInfo = { id: 555, username: 'TestDeliveryBot' };
  const replies = [];
  const photos = [];
  const invoices = [];
  delivery.bot.context.reply = async function (text, extra) { replies.push({ text, extra }); };
  delivery.bot.context.replyWithPhoto = async function (photo, extra) { photos.push({ photo, extra }); };
  delivery.bot.context.answerCbQuery = async function () {};
  delivery.bot.telegram.sendInvoice = async (...args) => {
    invoices.push(args);
    return { message_id: 42 };
  };

  // /paid shows both UPI QR and Telegram Stars options
  await delivery.bot.handleUpdate({
    update_id: 10,
    message: { message_id: 20, date: 1700000010, chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Buyer' }, text: '/paid PAID12', entities: [{ type: 'bot_command', offset: 0, length: 5 }] },
  });
  const paidButtons = replies[0].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(paidButtons, ['fs_paid_upi_12', 'fs_paid_stars_12']);

  // Select UPI QR for paid file
  await delivery.bot.handleUpdate({
    update_id: 11,
    callback_query: {
      id: 'cb_paid_upi',
      from: { id: 222, first_name: 'Buyer' },
      message: { message_id: 21, date: 1700000011, chat: { id: 222, type: 'private' }, text: 'Unlock File' },
      data: 'fs_paid_upi_12',
    },
  });
  assert.equal(photos.length, 1);
  assert.match(photos[0].extra.caption, /49\.01 INR/);
  assert.match(photos[0].extra.caption, /shop@fam/);

  // /batch shows both UPI QR and Telegram Stars options
  await delivery.bot.handleUpdate({
    update_id: 12,
    message: { message_id: 22, date: 1700000012, chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Buyer' }, text: '/batch BATCH9', entities: [{ type: 'bot_command', offset: 0, length: 6 }] },
  });
  const batchButtons = replies[1].extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(batchButtons, ['fs_batch_upi_9', 'fs_batch_stars_9']);

  // Select Telegram Stars for batch -> invokes sendInvoice(chatId, object)
  await delivery.bot.handleUpdate({
    update_id: 13,
    callback_query: {
      id: 'cb_batch_stars',
      from: { id: 222, first_name: 'Buyer' },
      message: { message_id: 23, date: 1700000013, chat: { id: 222, type: 'private' }, text: 'Unlock Batch' },
      data: 'fs_batch_stars_9',
    },
  });
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0][0], 222);
  assert.equal(invoices[0][1].currency, 'XTR');
  assert.deepEqual(invoices[0][1].prices, [{ label: 'Unlock batch', amount: 95 }]);
});

