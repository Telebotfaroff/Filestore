import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SHARE_BATCH_ITEMS,
  createShareLinkCode,
  buildShareableUrl,
  createSingleShareLink,
  createBatchShareLink,
  renameShareLink,
  renameIndexedFile,
  addItemToShareLink,
  removeItemFromShareLink,
} from '../src/storage/share-links-repository.js';
import { registerControlCenter } from '../src/bot/control-center.js';
import { createDeliveryBot } from '../src/delivery/bot.js';

function createFakeBot() {
  const commands = [];
  const actions = [];
  const onHandlers = new Map();
  return {
    command(name, handler) { commands.push({ name, handler }); },
    action(pattern, handler) { actions.push({ pattern, handler }); },
    on(event, handler) { onHandlers.set(Array.isArray(event) ? event.join(',') : event, handler); },
    commands,
    actions,
    onHandlers,
  };
}

function findCommand(bot, cmdName) {
  for (const entry of bot.commands) {
    if (typeof entry.name === 'string' && entry.name === cmdName) return entry.handler;
    if (entry.name instanceof RegExp && entry.name.test(cmdName)) return entry.handler;
  }
  return null;
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

test('shareable link helpers build valid Telegram deep links and enforce 20-item limit', async () => {
  assert.equal(MAX_SHARE_BATCH_ITEMS, 20);
  assert.match(createShareLinkCode('single'), /^s_[0-9a-f]{10}$/);
  assert.match(createShareLinkCode('batch'), /^b_[0-9a-f]{10}$/);
  assert.equal(buildShareableUrl('@MyDeliveryBot', 's_12345abcde'), 'https://t.me/MyDeliveryBot?start=s_12345abcde');
  assert.equal(buildShareableUrl(null, 's_12345abcde'), null);

  await assert.rejects(
    () => createBatchShareLink({}, [], 'Empty', 1),
    /at least 1 media file/i,
  );
  const twentyOne = Array.from({ length: 21 }, (_, i) => `CODE${i + 1}`);
  await assert.rejects(
    () => createBatchShareLink({}, twentyOne, 'Too big', 1),
    /up to 20 media items/i,
  );
});

test('repository creates single/batch links, renames links and files, and manages batch items', async () => {
  const files = new Map([
    ['CODE1', { id: 101, file_code: 'CODE1', file_name: 'Episode_1.mp4', file_type: 'video', file_size: 1024, status: 'active' }],
    ['CODE2', { id: 102, file_code: 'CODE2', file_name: 'Episode_2.mp4', file_type: 'video', file_size: 2048, status: 'active' }],
  ]);
  const links = new Map();
  const linkItems = new Map();
  let nextLinkId = 1;

  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('FROM files WHERE file_code = $1')) {
        const f = files.get(params[0]);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (sql.includes('FROM files WHERE id = $1')) {
        const f = [...files.values()].find((x) => x.id === params[0]);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO share_links')) {
        const id = nextLinkId++;
        const row = {
          id,
          link_code: params[0],
          link_type: sql.includes("'batch'") ? 'batch' : 'single',
          title: params[1],
          is_enabled: true,
          created_by: params[2],
          created_at: new Date(),
          updated_at: new Date(),
        };
        links.set(id, row);
        linkItems.set(id, []);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO share_link_items')) {
        const arr = linkItems.get(params[0]) ?? [];
        arr.push({ file_id: params[1], position: params[2] });
        linkItems.set(params[0], arr);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM share_links WHERE id = $1')) {
        const row = links.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('SELECT file_id, position FROM share_link_items')) {
        const rows = linkItems.get(params[0]) ?? [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('DELETE FROM share_link_items WHERE link_id = $1')) {
        linkItems.set(params[0], []);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE share_links SET link_type')) {
        const row = links.get(params[0]);
        if (row && params[1] > 1) row.link_type = 'batch';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE share_links SET updated_at')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const pool = {
    connect: async () => client,
    async query(sql, params = []) {
      if (sql.includes('UPDATE share_links SET title = $2')) {
        const row = links.get(params[0]);
        if (!row) return { rows: [], rowCount: 0 };
        row.title = params[1];
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('UPDATE files SET file_name = $2')) {
        const f = files.get(params[0]);
        if (!f) return { rows: [], rowCount: 0 };
        f.file_name = params[1];
        return { rows: [f], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const single = await createSingleShareLink(pool, 'code1', null, 42);
  assert.match(single.link_code, /^s_/);
  assert.equal(single.title, 'Episode_1.mp4');

  const batch = await createBatchShareLink(pool, ['CODE1', 'CODE2'], 'Season 1', 42);
  assert.match(batch.link_code, /^b_/);
  assert.equal(batch.itemCount, 2);

  const renamedLink = await renameShareLink(pool, batch.id, 'Season 1 HD');
  assert.equal(renamedLink.title, 'Season 1 HD');

  const renamedFile = await renameIndexedFile(pool, 'CODE1', 'Episode_01_Director_Cut.mp4');
  assert.equal(renamedFile.file_name, 'Episode_01_Director_Cut.mp4');

  const added = await addItemToShareLink(pool, single.id, 'CODE2');
  assert.equal(added.itemCount, 2);

  const removed = await removeItemFromShareLink(pool, batch.id, 101);
  assert.equal(removed.itemCount, 1);
  await assert.rejects(() => removeItemFromShareLink(pool, batch.id, 102), /at least 1 item/i);
});

test('Main Bot /link, /Batch, view generated link, edit and rename workflows work end-to-end', async () => {
  const bot = createFakeBot();
  const files = new Map([
    ['FILEA', { id: 11, file_code: 'FILEA', file_name: 'Alpha.mkv', file_type: 'video', file_size: 4096, status: 'active' }],
    ['FILEB', { id: 12, file_code: 'FILEB', file_name: 'Beta.pdf', file_type: 'document', file_size: 1024, status: 'active' }],
  ]);
  const links = new Map();
  const linkItems = new Map();
  let nextLinkId = 1;

  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('FROM files WHERE file_code = $1')) {
        const f = files.get(params[0]);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (sql.includes('FROM files WHERE id = $1')) {
        const f = [...files.values()].find((x) => x.id === params[0]);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO share_links')) {
        const id = nextLinkId++;
        const row = {
          id,
          link_code: params[0],
          link_type: sql.includes("'batch'") ? 'batch' : 'single',
          title: params[1],
          is_enabled: true,
          created_by: params[2],
          created_at: new Date(),
          updated_at: new Date(),
        };
        links.set(id, row);
        linkItems.set(id, []);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO share_link_items')) {
        const arr = linkItems.get(params[0]) ?? [];
        arr.push({ file_id: params[1], position: params[2] });
        linkItems.set(params[0], arr);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const pool = {
    connect: async () => client,
    async query(sql, params = []) {
      if (sql.includes('FROM delivery_bots')) return { rows: [{ username: 'FilesDeliveryBot' }], rowCount: 1 };
      if (sql.includes('FROM share_links WHERE id = $1')) {
        const row = links.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('FROM share_link_items i')) {
        const items = (linkItems.get(params[0]) ?? []).map((entry) => {
          const f = [...files.values()].find((x) => x.id === entry.file_id);
          return {
            position: entry.position,
            file_id: f.id,
            file_code: f.file_code,
            file_name: f.file_name,
            file_type: f.file_type,
            file_size: f.file_size,
            file_status: f.status,
          };
        });
        return { rows: items, rowCount: items.length };
      }
      if (sql.includes('UPDATE share_links SET title = $2')) {
        const row = links.get(params[0]);
        if (!row) return { rows: [], rowCount: 0 };
        row.title = params[1];
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('FROM files f LEFT JOIN storage_messages')) {
        const f = files.get(params[0]);
        return { rows: f ? [f] : [], rowCount: f ? 1 : 0 };
      }
      if (sql.includes('SELECT COUNT(*)::int AS total FROM share_links')) {
        return { rows: [{ total: links.size }], rowCount: 1 };
      }
      if (sql.includes('FROM share_links sl')) {
        const rows = [...links.values()].map((l) => ({
          ...l,
          item_count: (linkItems.get(l.id) ?? []).length,
        }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  registerControlCenter(bot, { deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  // 1. /link FILEA | Intro Video
  const linkCmd = findCommand(bot, 'link');
  assert.ok(linkCmd);
  const replies = [];
  await linkCmd({
    from: { id: 1 },
    message: { text: '/link FILEA | Intro Video' },
    reply: async (text, options) => { replies.push({ text, options }); },
  });
  assert.match(replies[0].text, /Single Media Share Link/);
  assert.match(replies[0].text, /Title: Intro Video/);
  assert.match(replies[0].text, /https:\/\/t\.me\/FilesDeliveryBot\?start=s_/);

  // 2. /Batch Starter Pack | FILEA,FILEB
  const batchCmd = findCommand(bot, 'Batch');
  assert.ok(batchCmd);
  await batchCmd({
    from: { id: 1 },
    message: { text: '/Batch Starter Pack | FILEA,FILEB' },
    reply: async (text, options) => { replies.push({ text, options }); },
  });
  assert.match(replies[1].text, /Batch Share Link \(2\/20 items\)/);
  assert.match(replies[1].text, /Title: Starter Pack/);
  assert.match(replies[1].text, /https:\/\/t\.me\/FilesDeliveryBot\?start=b_/);

  // 3. View generated links & rename batch link
  const linksAction = findAction(bot, 'cc:links:0');
  let edited;
  await linksAction.handler({
    from: { id: 1 },
    match: linksAction.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Generated Share Links/);
  assert.match(edited.text, /Starter Pack/);

  const renAction = findAction(bot, 'cc:lnk_ren:2');
  await renAction.handler({
    from: { id: 1 },
    match: renAction.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Rename Share Link/);

  const textHandler = bot.onHandlers.get('text');
  await textHandler(
    {
      from: { id: 1 },
      message: { text: 'Starter Pack Renamed' },
      reply: async (text, options) => { replies.push({ text, options }); },
    },
    async () => {},
  );
  assert.equal(links.get(2).title, 'Starter Pack Renamed');
  assert.ok(replies.some((r) => /Title: Starter Pack Renamed/.test(r.text)));
});

test('Delivery Bot /start <payload> queues batch delivery for share links', async () => {
  let queuedFiles = null;
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO users')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM share_links WHERE link_code = $1')) {
        if (params[0] === 'b_abc1234567') {
          return {
            rows: [{ id: 7, link_code: 'b_abc1234567', link_type: 'batch', title: 'Course Pack', is_enabled: true }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM share_link_items i')) {
        return {
          rows: [
            { position: 1, file_id: 21, file_code: 'C1', file_name: 'Lesson1.mp4', file_status: 'active', telegram_message_id: 501, storage_chat_id: -1001, storage_channel_enabled: true },
            { position: 2, file_id: 22, file_code: 'C2', file_name: 'Lesson2.mp4', file_status: 'active', telegram_message_id: 502, storage_chat_id: -1001, storage_channel_enabled: true },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('FROM force_sub_channels') || sql.includes("key = 'force_sub_enabled'") || sql.includes("key = 'checkpoint_enabled'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM access_grants') || sql.includes('FROM premium_memberships') || sql.includes('FROM paid_file_links')) {
        return { rows: [{ locked: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (sql.includes('INSERT INTO delivery_jobs')) return { rows: [{ id: 909 }], rowCount: 1 };
          if (sql.includes('INSERT INTO delivery_items')) {
            queuedFiles = (queuedFiles ?? []).concat([params[1]]);
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };

  const runtime = createDeliveryBot({ adminIds: [], deliveryBotToken: '123456:TESTTOKEN' }, { warn() {}, error() {}, info() {} }, pool, '123456:TESTTOKEN');
  const sentMessages = [];
  runtime.bot.botInfo = { id: 123456, is_bot: true, first_name: 'FilesDelivery', username: 'FilesDeliveryBot' };
  runtime.bot.context.reply = async (text, extra) => {
    sentMessages.push({ text, extra });
    return { message_id: 99 };
  };

  await runtime.bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 555, type: 'private' },
      from: { id: 555, is_bot: false, first_name: 'Alice' },
      text: '/start b_abc1234567',
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });
  assert.deepEqual(queuedFiles, [21, 22]);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Batch delivery queued/);
  assert.match(sentMessages[0].text, /Course Pack/);
  assert.match(sentMessages[0].text, /Job ID: 909/);
});
