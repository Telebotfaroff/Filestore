import test from 'node:test';
import assert from 'node:assert/strict';
import { registerControlCenter, buildMainMenuKeyboard } from '../src/bot/control-center.js';

function createFakeBot() {
  const commands = new Map();
  const actions = [];
  const onHandlers = new Map();
  return {
    command(name, handler) { commands.set(name, handler); },
    action(pattern, handler) { actions.push({ pattern, handler }); },
    on(event, handler) { onHandlers.set(event, handler); },
    commands,
    actions,
    onHandlers,
  };
}

function findAction(bot, data) {
  for (const entry of bot.actions) {
    if (typeof entry.pattern === 'string' && entry.pattern === data) {
      return { handler: entry.handler, match: [data] };
    }
    if (entry.pattern instanceof RegExp) {
      const m = data.match(entry.pattern);
      if (m) return { handler: entry.handler, match: m };
    }
  }
  return null;
}

function createMockPool() {
  return {
    query: async (sql) => {
      if (sql.includes('AS users_total')) {
        return {
          rows: [{
            users_total: 12,
            users_active_7d: 5,
            files_active: 34,
            files_disabled: 1,
            storage_channels_active: 1,
            delivery_bots_active: 2,
            jobs_pending: 0,
            jobs_processing: 0,
            jobs_completed: 20,
            jobs_failed: 0,
            jobs_uncertain: 0,
            premium_active: 3,
            paid_file_links_active: 2,
            paid_batch_links_active: 1,
            paid_file_requests_pending: 0,
            paid_batch_requests_pending: 0,
            payments_applied: 4,
            revenue_by_currency: { XTR: 500 },
            events_24h: 8,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('AS delivery_pending')) {
        return {
          rows: [{
            delivery_pending: 0,
            delivery_pending_stale: 0,
            delivery_processing: 0,
            delivery_processing_stale: 0,
            delivery_failed: 0,
            delivery_uncertain: 0,
            deletions_due: 0,
            deletions_stale: 0,
            deletions_failed: 0,
            payment_recovery_pending: 0,
            payment_notifications_pending: 0,
            payment_notifications_exhausted: 0,
            checkpoint_expired_pending: 0,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("setting_key = 'auto_delete_minutes'")) {
        return { rows: [{ setting_value: '15' }], rowCount: 1 };
      }
      if (sql.includes('COUNT(*)::int AS total FROM files')) {
        return { rows: [{ total: 1 }], rowCount: 1 };
      }
      if (sql.includes('FROM files WHERE status')) {
        return {
          rows: [{ file_code: 'FILE01', file_name: 'Sample.pdf', file_type: 'document', file_size: 2048, created_at: new Date() }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('main menu inline keyboard has organized sections within 64-byte callback_data limit', () => {
  const keyboard = buildMainMenuKeyboard();
  assert.ok(keyboard.inline_keyboard.length >= 7);
  const allButtons = keyboard.inline_keyboard.flat();
  assert.ok(allButtons.length >= 14);
  const removed = new Set(['cc:files:0', 'cc:links:0', 'cc:paid', 'cc:batch']);
  for (const btn of allButtons) {
    assert.ok(!removed.has(btn.callback_data), `Button should have been removed: ${btn.callback_data}`);
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `callback_data too long: ${btn.callback_data}`);
  }
});

test('start and menu commands render FileStore Control Center with inline buttons', async () => {
  const bot = createFakeBot();
  const pool = createMockPool();
  registerControlCenter(bot, { deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  let reply;
  await bot.commands.get('start')({
    from: { id: 1 },
    reply: async (text, options) => { reply = { text, options }; },
  });
  assert.match(reply.text, /FileStore Control Center/);
  assert.match(reply.text, /Files: 34 active/);
  assert.ok(reply.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:storage'));
  assert.ok(reply.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:bots'));
});

test('inline panel callbacks navigate cleanly and guided search prompt executes text search', async () => {
  const bot = createFakeBot();
  const pool = createMockPool();
  registerControlCenter(bot, { deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  const filesAction = findAction(bot, 'cc:files:0');
  assert.ok(filesAction);
  let edited;
  await filesAction.handler({
    from: { id: 1 },
    match: filesAction.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Indexed Files/);
  assert.match(edited.text, /Sample\.pdf/);
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:prompt:find'));

  const promptAction = findAction(bot, 'cc:prompt:find');
  await promptAction.handler({
    from: { id: 1 },
    match: promptAction.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Interactive Input/);

  const textHandler = bot.onHandlers.get('text');
  let searchReply;
  await textHandler(
    {
      from: { id: 1 },
      message: { text: 'Sample' },
      reply: async (text, options) => { searchReply = { text, options }; },
    },
    async () => {},
  );
  assert.match(searchReply.text, /Search results for "Sample"/);
  assert.ok(searchReply.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:file:FILE01'));
});

test('auto-delete preset callback updates setting and renders updated state', async () => {
  const bot = createFakeBot();
  let savedArgs = null;
  const pool = {
    query: async (sql, args) => {
      if (sql.includes('INSERT INTO delivery_settings')) {
        savedArgs = args;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("setting_key = 'auto_delete_minutes'")) {
        return { rows: [{ setting_value: savedArgs?.[0] ?? '0' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  registerControlCenter(bot, { deliveryManager: { list: async () => [] } }, { warn() {}, error() {} }, pool);

  const action = findAction(bot, 'cc:autodel_set:30');
  assert.ok(action);
  let edited;
  await action.handler({
    from: { id: 99 },
    match: action.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.equal(savedArgs[0], '30');
  assert.match(edited.text, /30 minute\(s\)/);
});

test('Control Center payment gateways and Telegram Stars pricing setup work cleanly', async () => {
  const { randomBytes } = await import('node:crypto');
  const bot = createFakeBot();
  const starsState = {
    is_enabled: false,
    public_config: {},
    setup_status: 'not_configured',
    last_test_status: 'unknown',
    last_test_error: null,
  };
  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes('SELECT method, is_enabled, public_config')) {
        return {
          rows: [
            { method: 'fampay', is_enabled: false, public_config: {}, setup_status: 'not_configured', last_test_status: 'unknown', last_test_error: null },
            { method: 'telegram_stars', ...starsState },
            { method: 'stripe', is_enabled: false, public_config: {}, setup_status: 'not_configured', last_test_status: 'unknown', last_test_error: null },
          ],
          rowCount: 3,
        };
      }
      if (sql.includes('SELECT is_enabled, public_config, secret_ciphertext')) {
        return { rows: [{ is_enabled: false, public_config: {}, secret_ciphertext: null, setup_status: 'not_configured', last_test_status: 'unknown', last_test_error: null }], rowCount: 1 };
      }
      if (sql.includes('SELECT is_enabled, public_config, setup_status')) {
        return { rows: [{ ...starsState }], rowCount: 1 };
      }
      if (sql.includes('SELECT is_enabled, public_config FROM payment_methods')) {
        return { rows: [{ is_enabled: starsState.is_enabled, public_config: starsState.public_config }], rowCount: 1 };
      }
      if (sql.includes('SET public_config = $2::jsonb')) {
        starsState.public_config = JSON.parse(args[1]);
        starsState.setup_status = args[2];
        starsState.is_enabled = args[3];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM premium_plans WHERE id = $1')) {
        return { rows: [{ id: 1, name: 'Pro', price_minor: 9900, currency: 'INR', duration_days: 30, is_enabled: true }], rowCount: 1 };
      }
      if (sql.includes('FROM premium_plans')) {
        return { rows: [{ id: 1, name: 'Pro', price_minor: 9900, currency: 'INR', duration_days: 30, is_enabled: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const cfg = { tokenEncryptionKey: randomBytes(32).toString('base64'), deliveryManager: { list: async () => [] } };
  registerControlCenter(bot, cfg, { warn() {}, error() {} }, pool);

  // Payment Gateways panel lists FamPay & Telegram Stars (without fake Test buttons for unimplemented gateways)
  const payMethodsAction = findAction(bot, 'cc:pay_methods');
  let edited;
  await payMethodsAction.handler({
    from: { id: 1 },
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /FamPay UPI & Gmail/);
  assert.match(edited.text, /Telegram Stars \(XTR\)/);
  const methodButtons = edited.options.reply_markup.inline_keyboard.flat();
  for (const btn of methodButtons) {
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `callback_data too long: ${btn.callback_data}`);
  }
  assert.ok(methodButtons.some((b) => b.callback_data === 'cc:stars_cfg'));
  assert.ok(!methodButtons.some((b) => b.callback_data === 'cc:pay_test:stripe'));

  // Stars Config panel renders cleanly
  const starsCfgAction = findAction(bot, 'cc:stars_cfg');
  await starsCfgAction.handler({
    from: { id: 1 },
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Telegram Stars \(XTR\) Configuration/);
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:prompt:stars_plan'));

  // Guided prompt to set plan Stars price saves configuration
  const promptStarsPlan = findAction(bot, 'cc:prompt:stars_plan');
  await promptStarsPlan.handler({
    from: { id: 1 },
    match: promptStarsPlan.match,
    answerCbQuery: async () => {},
    editMessageText: async () => {},
  });
  let savedReply;
  await bot.onHandlers.get('text')(
    {
      from: { id: 1 },
      message: { text: '1|75' },
      reply: async (text, options) => { savedReply = { text, options }; },
    },
    async () => {},
  );
  assert.match(savedReply.text, /Saved Stars price for Plan #1 \(Pro\): 75 ⭐/);
  assert.equal(starsState.public_config.stars_prices.premium['1'], 75);

  // Per-plan detail button cc:plan_stars:1 also triggers prompt
  const planStarsAction = findAction(bot, 'cc:plan_stars:1');
  assert.ok(planStarsAction);
  await planStarsAction.handler({
    from: { id: 1 },
    match: planStarsAction.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Set Telegram Stars Price/);
  assert.match(edited.text, /Plan #1: Pro/);
});

test('Control Center shortener UI supports adding multiple shorteners with base_url|api_key and toggling enforcement', async () => {
  const { randomBytes } = await import('node:crypto');
  const bot = createFakeBot();
  const providers = [];
  let checkpointEnabled = false;
  let nextId = 1;
  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes("key = 'checkpoint_enabled'") && sql.includes('SELECT')) {
        return { rows: [{ value: checkpointEnabled }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO app_settings') && sql.includes('checkpoint_enabled')) {
        checkpointEnabled = JSON.parse(args[0]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM shortener_providers') && sql.includes('ORDER BY')) {
        return {
          rows: providers.map((p) => ({ ...p, has_api_key: Boolean(p.api_key_ciphertext) })),
          rowCount: providers.length,
        };
      }
      if (sql.includes('INSERT INTO shortener_providers')) {
        const row = {
          id: nextId++,
          name: args[0],
          base_url: args[1],
          api_endpoint: args[2],
          api_key_ciphertext: args[3],
          api_key_param: args[4],
          target_url_param: args[5],
          response_url_path: args[6],
          response_format: args[7],
          checkpoint_minutes: args[8],
          priority: args[9],
          verification_mode: args[10],
          is_enabled: args[11],
          last_test_status: 'unknown',
          last_test_error: null,
        };
        providers.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('FROM shortener_providers WHERE is_enabled = TRUE')) {
        const enabled = providers.filter((p) => p.is_enabled);
        return { rows: enabled, rowCount: enabled.length };
      }
      if (sql.trimStart().startsWith('SELECT') && sql.includes('FROM shortener_providers WHERE id = $1')) {
        const found = providers.find((p) => p.id === Number(args[0]));
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes('UPDATE shortener_providers')) {
        const found = providers.find((p) => p.id === Number(args[0]));
        if (found) {
          if (sql.includes('is_enabled = $2')) found.is_enabled = args[1];
          if (sql.includes('SET name = $2')) found.name = args[1];
          if (sql.includes('SET checkpoint_minutes = $2')) found.checkpoint_minutes = args[1];
          if (sql.includes('SET priority = $2')) found.priority = args[1];
        }
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM shortener_providers')) {
        const idx = providers.findIndex((p) => p.id === Number(args[0]));
        if (idx < 0) return { rows: [], rowCount: 0 };
        const [removed] = providers.splice(idx, 1);
        return { rows: [removed], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const cfg = { tokenEncryptionKey: randomBytes(32).toString('base64'), deliveryManager: { list: async () => [] } };
  registerControlCenter(bot, cfg, { warn() {}, error() {} }, pool);

  const shortAction = findAction(bot, 'cc:short');
  let edited;
  await shortAction.handler({
    from: { id: 1 },
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /URL Shorteners & Checkpoints/);
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:short_new'));

  // Step 1: Tap Add Shortener button -> Step 1 asks Base URL -> Step 2 asks API key -> Step 3 asks Duration button
  const addNewBtn = findAction(bot, 'cc:short_new');
  await addNewBtn.handler({
    from: { id: 1 },
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Step 1 of 3/);

  let stepReply;
  await bot.onHandlers.get('text')(
    {
      from: { id: 1 },
      message: { text: 'https://shrinkme.io' },
      reply: async (text, options) => { stepReply = { text, options }; },
    },
    async () => {},
  );
  assert.match(stepReply.text, /Step 2 of 3/);

  await bot.onHandlers.get('text')(
    {
      from: { id: 1 },
      message: { text: 'secret_key_one' },
      deleteMessage: async () => {},
      reply: async (text, options) => { stepReply = { text, options }; },
    },
    async () => {},
  );
  assert.match(stepReply.text, /Step 3 of 3/);
  const durButtons = stepReply.options.reply_markup.inline_keyboard.flat();
  assert.ok(durButtons.some((b) => b.callback_data === 'cc:short_wiz_dur:1440'));

  const pick1440 = findAction(bot, 'cc:short_wiz_dur:1440');
  await pick1440.handler({
    from: { id: 1 },
    match: pick1440.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Shortener #1 Added/);
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:short_edit:1'));
  assert.ok(edited.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'cc:short_new'));

  // Add second shortener via quick format
  await addNewBtn.handler({
    from: { id: 1 },
    answerCbQuery: async () => {},
    editMessageText: async () => {},
  });
  let addReply;
  await bot.onHandlers.get('text')(
    {
      from: { id: 1 },
      message: { text: 'GPLinks|https://gplinks.com|secret_key_two|720|10' },
      deleteMessage: async () => {},
      reply: async (text, options) => { addReply = { text, options }; },
    },
    async () => {},
  );
  assert.match(addReply.text, /Shortener #2 saved/);
  assert.equal(providers.length, 2);

  // Interactive Edit menu & preset duration/priority buttons
  const editMenu = findAction(bot, 'cc:short_edit:1');
  await editMenu.handler({
    from: { id: 1 },
    match: editMenu.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Edit Shortener #1/);
  for (const btn of edited.options.reply_markup.inline_keyboard.flat()) {
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `callback_data too long: ${btn.callback_data}`);
  }

  const durPreset = findAction(bot, 'cc:short_durs:1:360');
  await durPreset.handler({
    from: { id: 1 },
    match: durPreset.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.equal(providers[0].checkpoint_minutes, 360);

  // Enable global checkpoints now that shorteners exist
  const chkOn = findAction(bot, 'cc:chk_g:1');
  await chkOn.handler({
    from: { id: 1 },
    match: chkOn.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.equal(checkpointEnabled, true);
  assert.match(edited.text, /Enforcement: ON/);
  assert.match(edited.text, /Active providers: 2\/2/);

  // Delete provider #2 with inline confirmation
  const rmAsk = findAction(bot, 'cc:short_rm:2');
  await rmAsk.handler({
    from: { id: 1 },
    match: rmAsk.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.match(edited.text, /Confirm deletion/);
  const rmOk = findAction(bot, 'cc:short_rm_ok:2');
  await rmOk.handler({
    from: { id: 1 },
    match: rmOk.match,
    answerCbQuery: async () => {},
    editMessageText: async (text, options) => { edited = { text, options }; },
  });
  assert.equal(providers.length, 1);
  assert.match(edited.text, /Active providers: 1\/1/);
});

