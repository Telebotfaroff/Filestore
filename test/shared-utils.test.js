import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSecret,
  normalizeUpperCode,
  hashUpperCode,
  parsePositiveInt,
  parseTelegramUserId,
  parseMinorAmount,
  parseCurrencyCode,
  parseOptionalExpiryDays,
  formatMoney,
  formatRevenueSummary,
} from '../src/utils/validation.js';
import {
  truncateText,
  getCommandArgs,
  getCommandArgText,
  safeAnswer,
  renderView,
  validateStorageChannel,
  validateForceSubChannel,
  inspectBotChannelAccess,
} from '../src/bot/telegram-utils.js';

test('validation helpers normalize secrets, codes, IDs, currencies, and amounts', () => {
  assert.equal(normalizeSecret(`  "123:abc"  `), '123:abc');
  assert.equal(normalizeSecret(`'tok'`), 'tok');
  assert.equal(normalizeUpperCode('  ab_12  '), 'AB_12');
  assert.equal(hashUpperCode('ab_12'), hashUpperCode('AB_12'));
  assert.equal(hashUpperCode('ab_12').length, 64);

  assert.equal(parsePositiveInt('42'), 42);
  assert.throws(() => parsePositiveInt('0', 'Plan ID'), /Plan ID must be a positive integer/);
  assert.throws(() => parsePositiveInt('abc'), /positive integer/);

  assert.equal(parseTelegramUserId('1572773888'), '1572773888');
  assert.throws(() => parseTelegramUserId('0'), /out of range/);
  assert.throws(() => parseTelegramUserId('abc'), /numeric/);

  assert.equal(parseMinorAmount('19.99'), 1999);
  assert.equal(parseMinorAmount('0', { allowZero: true }), 0);
  assert.throws(() => parseMinorAmount('0'), /greater than zero/);
  assert.throws(() => parseMinorAmount('1.234'), /up to 2 decimals/);

  assert.equal(parseCurrencyCode('inr'), 'INR');
  assert.throws(() => parseCurrencyCode('US'), /3-letter code/);

  assert.equal(parseOptionalExpiryDays(''), null);
  assert.equal(parseOptionalExpiryDays(null), null);
  assert.ok(parseOptionalExpiryDays('7') instanceof Date);
  assert.throws(() => parseOptionalExpiryDays('0'), /1–3650/);

  assert.equal(formatMoney(12500, 'INR'), '125.00 INR');
  assert.equal(formatRevenueSummary({ INR: 12500, USD: 500 }), '125.00 INR · 5.00 USD');
  assert.equal(formatRevenueSummary({}), 'none');
});

test('telegram-utils parse commands, truncate safely, and handle renderView/safeAnswer', async () => {
  const ctx = { message: { text: '  /find   my   file  name  ' } };
  assert.deepEqual(getCommandArgs(ctx), ['my', 'file', 'name']);
  assert.equal(getCommandArgText(ctx), 'my file name');
  assert.deepEqual(getCommandArgs({}), []);

  assert.equal(truncateText('hello', 100), 'hello');
  const truncated = truncateText('a'.repeat(50), 30);
  assert.ok(truncated.length <= 30);
  assert.ok(truncated.endsWith('...(truncated)'));

  let answered = null;
  await safeAnswer({
    answerCbQuery: async (msg, opts) => { answered = { msg, opts }; },
  }, 'Done', true);
  assert.deepEqual(answered, { msg: 'Done', opts: { show_alert: true } });

  // Ignores errors silently
  await safeAnswer({ answerCbQuery: async () => { throw new Error('expired'); } }, 'ok');

  let replied = false;
  await renderView({ reply: async () => { replied = true; } }, 'hi', { inline_keyboard: [] }, false);
  assert.equal(replied, true);

  // Handles "message is not modified" without throwing
  const notModResult = await renderView(
    { editMessageText: async () => { throw new Error('400: Bad Request: message is not modified'); } },
    'hi',
    { inline_keyboard: [] },
    true,
  );
  assert.equal(notModResult, null);
});

test('validateStorageChannel, validateForceSubChannel, and inspectBotChannelAccess check Telegram permissions', async () => {
  const validCtx = {
    telegram: {
      getMe: async () => ({ id: 999 }),
      getChat: async () => ({ id: -1001, type: 'channel', title: 'Vault' }),
      getChatMember: async () => ({ status: 'administrator', can_post_messages: true }),
    },
  };
  const chat = await validateStorageChannel(validCtx, '-1001');
  assert.equal(chat.title, 'Vault');
  const fsChat = await validateForceSubChannel(validCtx, '-1001');
  assert.equal(fsChat.id, -1001);

  await assert.rejects(
    () => validateStorageChannel({
      telegram: {
        getMe: async () => ({ id: 999 }),
        getChat: async () => ({ id: 1, type: 'group' }),
      },
    }, '1'),
    /Only Telegram channels/,
  );

  await assert.rejects(
    () => validateStorageChannel({
      telegram: {
        getMe: async () => ({ id: 999 }),
        getChat: async () => ({ id: -1001, type: 'channel' }),
        getChatMember: async () => ({ status: 'administrator', can_post_messages: false }),
      },
    }, '-1001'),
    /permission to post/,
  );

  const pool = {
    query: async (sql) => {
      if (sql.includes('storage_channels')) {
        return { rows: [{ telegram_chat_id: -1001, title: 'Storage 1' }, { telegram_chat_id: -1002, title: 'Storage 2' }] };
      }
      return { rows: [{ telegram_chat_id: -1003, title: 'ForceSub 1' }] };
    },
  };
  const telegram = {
    getChatMember: async (chatId) => {
      if (chatId === -1001) return { status: 'administrator' };
      if (chatId === -1002) throw new Error('chat not found');
      return { status: 'member' };
    },
  };
  const inspection = await inspectBotChannelAccess(telegram, pool, 999);
  assert.deepEqual(inspection.storage, [
    { channel: 'Storage 1', status: 'ok' },
    { channel: 'Storage 2', status: 'error', message: 'chat not found' },
  ]);
  assert.deepEqual(inspection.forceSub, [
    { channel: 'ForceSub 1', status: 'force_sub_needs_admin' },
  ]);

  // Auto-retries -100 prefix if user enters positive channel digits
  const autoPrefixed = await validateStorageChannel({
    telegram: {
      getMe: async () => ({ id: 999, username: 'Filestore_advbot' }),
      getChat: async (id) => {
        if (String(id) === '1234567890') throw new Error('400: Bad Request: chat not found');
        if (id === -1001234567890) return { id: -1001234567890, type: 'channel', title: 'AutoPrefixed' };
        throw new Error('unexpected');
      },
      getChatMember: async () => ({ status: 'administrator', can_post_messages: true }),
    },
  }, '1234567890');
  assert.equal(autoPrefixed.id, -1001234567890);

  // Translates unrecoverable "chat not found" into actionable Main Bot admin instructions
  await assert.rejects(
    () => validateStorageChannel({
      telegram: {
        getMe: async () => ({ id: 999, username: 'Filestore_advbot' }),
        getChat: async () => { throw new Error('400: Bad Request: chat not found'); },
      },
    }, '-1009999999999'),
    /@Filestore_advbot as an Administrator.*Post Messages/,
  );
});
