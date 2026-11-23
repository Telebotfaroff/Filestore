// URL-shortener and checkpoint callback controller.
export function registerShortenerActions(bot, context) {
  const { getOwnerScope, pool, safeAnswer, setCreatorCheckpointEnabled, showShorteners, clearShortenerDraft, setPrompt, renderView, PROMPT_CONFIGS, getShortenerDraft, clearPrompt, listShortenerProviders, deriveUniqueShortenerName, addShortenerProvider, config, getShortenerProviderById, decryptShortenerApiKey, getShareableBotUsername, shortenUrlWithProvider, markShortenerTest, showShortenerDetail, setShortenerEnabled, showShortenerEdit, setShortenerDuration, setShortenerPriority, removeShortenerProvider } = context;
  // Shortener & Checkpoint actions
  bot.action(/^cc:chk_g:(0|1)$/, async (ctx) => {
    const enable = ctx.match[1] === '1';
    const ownerId = getOwnerScope(ctx);
    if (enable) {
      const providers = ownerId === null
        ? await pool.query('SELECT id FROM shortener_providers WHERE is_enabled = TRUE AND owner_telegram_id IS NULL')
        : await pool.query('SELECT id FROM shortener_providers WHERE is_enabled = TRUE AND owner_telegram_id = $1', [ownerId]);
      if (!providers.rowCount) {
        return safeAnswer(ctx, 'Cannot enable checkpoints: no enabled shortener providers.', true);
      }
    }
    if (ownerId !== null) {
      await setCreatorCheckpointEnabled(pool, ownerId, enable);
    } else {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ('checkpoint_enabled', $1::jsonb, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [JSON.stringify(enable), ctx.from.id],
      );
    }
    await safeAnswer(ctx, `Checkpoints ${enable ? 'enabled' : 'disabled'}.`);
    await showShorteners(ctx, true);
  });

  bot.action('cc:short_new', async (ctx) => {
    clearShortenerDraft(ctx.from.id);
    setPrompt(ctx.from.id, 'shortener_add', { back: 'cc:short' });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      PROMPT_CONFIGS.shortener_add.prompt,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action('cc:short_wiz_key_back', async (ctx) => {
    const draft = getShortenerDraft(ctx.from.id);
    if (!draft) {
      clearShortenerDraft(ctx.from.id);
      setPrompt(ctx.from.id, 'shortener_add', { back: 'cc:short' });
      await safeAnswer(ctx);
      return renderView(
        ctx,
        PROMPT_CONFIGS.shortener_add.prompt,
        { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
        true,
      );
    }
    setPrompt(ctx.from.id, 'shortener_wiz_key', { back: 'cc:short' });
    await safeAnswer(ctx);
    return renderView(
      ctx,
      `➕ Add URL Shortener · Step 2 of 3\n━━━━━━━━━━━━━━━━━━\n🌐 Base URL: ${draft.baseUrl}\n🔌 API Endpoint: ${draft.apiEndpoint}\n\n🔑 Now send your API Key:\n🔒 Your message will be deleted immediately for security.`,
      {
        inline_keyboard: [[
          { text: '← Change Base URL', callback_data: 'cc:short_new' },
          { text: '✖ Cancel', callback_data: 'cc:cancel_prompt' },
        ]],
      },
      true,
    );
  });

  bot.action(/^cc:short_wiz_dur:(custom|\d+)$/, async (ctx) => {
    const choice = ctx.match[1];
    const draft = getShortenerDraft(ctx.from.id);
    if (!draft?.baseUrl || !draft?.apiKey) {
      await safeAnswer(ctx, 'Setup session expired. Start again.', true);
      return showShorteners(ctx, true);
    }
    if (choice === 'custom') {
      setPrompt(ctx.from.id, 'shortener_wiz_dur', { back: 'cc:short' });
      await safeAnswer(ctx);
      return renderView(
        ctx,
        `⏱ Add URL Shortener · Custom Duration\n━━━━━━━━━━━━━━━━━━\n🌐 Base URL: ${draft.baseUrl}\n\n✏️ Send unlock duration in minutes (1–10080):`,
        { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
        true,
      );
    }
    const ownerId = getOwnerScope(ctx);
    const checkpointMinutes = Number(choice);
    const existing = await listShortenerProviders(pool, ownerId);
    const name = deriveUniqueShortenerName(draft.hostname, existing);
    const provider = await addShortenerProvider(
      pool,
      config,
      {
        name,
        baseUrl: draft.baseUrl,
        apiEndpoint: draft.apiEndpoint,
        apiKey: draft.apiKey,
        apiKeyParam: 'api',
        targetUrlParam: 'url',
        responseUrlPath: 'shortenedUrl',
        responseFormat: 'json',
        checkpointMinutes,
        priority: 100,
        verificationMode: 'callback',
        enabled: true,
      },
      ctx.from.id,
      ownerId,
    );
    clearShortenerDraft(ctx.from.id);
    clearPrompt(ctx.from.id);
    await safeAnswer(ctx, `✅ Shortener #${provider.id} saved!`);
    return renderView(
      ctx,
      `✅ Shortener #${provider.id} Added!\n━━━━━━━━━━━━━━━━━━\n🏷 Name: ${provider.name}\n🌐 Base URL: ${provider.base_url}\n🔌 API Endpoint: ${provider.api_endpoint}\n⏱ Duration: ${provider.checkpoint_minutes} min · 🔢 Priority: ${provider.priority}\n🟢 Status: Enabled · 🔒 API Key: Encrypted`,
      {
        inline_keyboard: [
          [
            { text: '🧪 Test API Now', callback_data: `cc:short_test:${provider.id}` },
            { text: '✏ Edit', callback_data: `cc:short_edit:${provider.id}` },
          ],
          [
            { text: '➕ Add Another Shortener', callback_data: 'cc:short_new' },
            { text: '🗑 Delete', callback_data: `cc:short_rm:${provider.id}` },
          ],
          [
            { text: '← Shorteners', callback_data: 'cc:short' },
            { text: '← Main Menu', callback_data: 'cc:home' },
          ],
        ],
      },
      true,
    );
  });

  bot.action(/^cc:short_p:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showShortenerDetail(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:short_edit:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showShortenerEdit(ctx, Number(ctx.match[1]), true); });
  bot.action(/^cc:short_rm:(\d+)$/, async (ctx) => { await safeAnswer(ctx); await showShortenerDetail(ctx, Number(ctx.match[1]), true, true); });

  bot.action(/^cc:short_test:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    try {
      const p = await getShortenerProviderById(pool, id, ownerId);
      if (!p) return safeAnswer(ctx, 'Provider not found.', true);
      const apiKey = decryptShortenerApiKey(p, config.tokenEncryptionKey);
      if (!apiKey) throw new Error('No API key set for this shortener.');
      const deliveryUsername = await getShareableBotUsername(pool, ownerId).catch(() => null);
      const targetHandle = String(deliveryUsername || ctx.botInfo?.username || 'telegram').replace(/^@+/, '');
      const result = await shortenUrlWithProvider(p, `https://t.me/${targetHandle}?start=chk_test`, apiKey);
      await markShortenerTest(pool, id, 'ok', null, ownerId);
      await safeAnswer(ctx, `API OK → ${result.shortUrl}`, true);
    } catch (error) {
      await markShortenerTest(pool, id, 'failed', error.message, ownerId).catch(() => {});
      await safeAnswer(ctx, 'API test failed: ' + error.message, true);
    }
    await showShortenerDetail(ctx, id, true);
  });

  bot.action(/^cc:short_en:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const p = await getShortenerProviderById(pool, id, ownerId);
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    if (!p.api_key_ciphertext) {
      return safeAnswer(ctx, 'Set an API key before enabling this shortener.', true);
    }
    await setShortenerEnabled(pool, id, true, ownerId);
    await safeAnswer(ctx, 'Provider enabled.');
    await showShortenerDetail(ctx, id, true);
  });

  bot.action(/^cc:short_dis:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const ownerId = getOwnerScope(ctx);
    const p = await getShortenerProviderById(pool, id, ownerId);
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    await setShortenerEnabled(pool, id, false, ownerId);
    await safeAnswer(ctx, 'Provider disabled.');
    await showShortenerDetail(ctx, id, true);
  });

  bot.action(/^cc:short_name:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_name', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🏷 Edit Name · #${p.id}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.name}\n\n✏️ Send the new name (1–80 characters):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_url:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_url', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🌐 Edit Base URL · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.base_url}\n\n✏️ Send the new HTTPS Base URL (e.g. https://shrinkme.io):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_ep:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_ep', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔌 Edit API Endpoint · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.api_endpoint}\n\n✏️ Send the new HTTPS API Endpoint (e.g. https://shrinkme.io/api):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_key:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_key', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔑 Update API Key · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n✏️ Send the new API key:\n🔒 Your message will be deleted immediately for security.`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_dur:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `⏱ Checkpoint Duration · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.checkpoint_minutes} min\n\n👇 Select a preset duration or enter custom minutes:`,
      {
        inline_keyboard: [
          [
            { text: '15 min', callback_data: `cc:short_durs:${id}:15` },
            { text: '1 hour', callback_data: `cc:short_durs:${id}:60` },
            { text: '6 hours', callback_data: `cc:short_durs:${id}:360` },
          ],
          [
            { text: '12 hours', callback_data: `cc:short_durs:${id}:720` },
            { text: '24 hours', callback_data: `cc:short_durs:${id}:1440` },
          ],
          [
            { text: '✏ Custom Minutes', callback_data: `cc:short_durc:${id}` },
            { text: '← Back', callback_data: `cc:short_edit:${id}` },
          ],
        ],
      },
      true,
    );
  });

  bot.action(/^cc:short_durs:(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const minutes = Number(ctx.match[2]);
    const updated = await setShortenerDuration(pool, id, minutes, getOwnerScope(ctx));
    if (!updated) return safeAnswer(ctx, 'Provider not found.', true);
    await safeAnswer(ctx, `✅ Duration set to ${minutes}m.`);
    await showShortenerEdit(ctx, id, true);
  });

  bot.action(/^cc:short_durc:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_dur', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `⏱ Checkpoint Duration · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.checkpoint_minutes} min\n\n✏️ Send new duration in minutes (1–10080):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_prio:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔢 Shortener Priority · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.priority} (lower number runs first)\n\n👇 Select a priority preset or enter a custom number:`,
      {
        inline_keyboard: [
          [
            { text: '1 (First)', callback_data: `cc:short_prios:${id}:1` },
            { text: '10 (High)', callback_data: `cc:short_prios:${id}:10` },
            { text: '50', callback_data: `cc:short_prios:${id}:50` },
            { text: '100', callback_data: `cc:short_prios:${id}:100` },
          ],
          [
            { text: '✏ Custom Priority', callback_data: `cc:short_prioc:${id}` },
            { text: '← Back', callback_data: `cc:short_edit:${id}` },
          ],
        ],
      },
      true,
    );
  });

  bot.action(/^cc:short_prios:(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const priority = Number(ctx.match[2]);
    const updated = await setShortenerPriority(pool, id, priority, getOwnerScope(ctx));
    if (!updated) return safeAnswer(ctx, 'Provider not found.', true);
    await safeAnswer(ctx, `✅ Priority set to ${priority}.`);
    await showShortenerEdit(ctx, id, true);
  });

  bot.action(/^cc:short_prioc:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const p = await getShortenerProviderById(pool, id, getOwnerScope(ctx));
    if (!p) return safeAnswer(ctx, 'Provider not found.', true);
    setPrompt(ctx.from.id, 'shortener_prio', { back: `cc:short_edit:${id}`, meta: { providerId: id } });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `🔢 Shortener Priority · #${p.id} ${p.name}\n━━━━━━━━━━━━━━━━━━\n📌 Current: ${p.priority} (lower runs first)\n\n✏️ Send new priority (1–100000):`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
    );
  });

  bot.action(/^cc:short_rm_ok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const res = await removeShortenerProvider(pool, id, getOwnerScope(ctx));
    if (res.removed) await safeAnswer(ctx, 'Provider removed.');
    else if (res.disabled) await safeAnswer(ctx, 'Provider has session history; disabled instead.', true);
    else await safeAnswer(ctx, 'Cannot remove provider with active pending sessions.', true);
    await showShorteners(ctx, true);
  });
}
