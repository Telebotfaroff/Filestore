import { addShortenerProvider, listShortenerProviders, markShortenerTest, removeShortenerProvider, setShortenerDuration, setShortenerEnabled, setShortenerPriority } from './shortener-repository.js';

function parts(ctx) {
  return ctx.message?.text?.trim().split(/\s+/).slice(1) ?? [];
}
function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Provider ID must be a positive integer.');
  return id;
}
function getId(ctx) { return parseId(parts(ctx)[0] ?? ''); }
function validateProviderUrls(baseUrl, apiEndpoint) {
  const base = new URL(baseUrl);
  const endpoint = new URL(apiEndpoint);
  if (base.protocol !== 'https:' || endpoint.protocol !== 'https:') throw new Error('Both URLs must use HTTPS.');
  return { baseUrl: base.toString(), apiEndpoint: endpoint.toString() };
}

export function registerShortenerAdminCommands(bot, pool, config, logger) {
  bot.command('shorteners', async (ctx) => {
    try {
      const rows = await listShortenerProviders(pool);
      if (!rows.length) return ctx.reply('No URL shortener providers configured.');
      const list = rows.map((p) => `#${p.id} ${p.name} · ${p.is_enabled ? 'ENABLED' : 'DISABLED'}\nPriority: ${p.priority} · checkpoint: ${p.checkpoint_minutes}m\nVerify: ${p.verification_mode} · test: ${p.last_test_status}`);
      await ctx.reply('URL Shortener Manager\n\n' + list.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Shortener list failed');
      await ctx.reply('Could not load shortener providers.');
    }
  });

  bot.command('shortener_add', async (ctx) => {
    const text = ctx.message?.text?.trim().replace(/^\/shortener_add\s*/, '') ?? '';
    if (!text) return ctx.reply('Usage: /shortener_add name|base_url|api_endpoint|api_key|checkpoint_minutes|priority|api_key_param|target_url_param|response_url_path|json_or_text|verification_mode');
    try { await ctx.deleteMessage(); } catch {}
    const values = text.split('|').map((value) => value.trim());
    if (values.length !== 11) return ctx.reply('Provider config needs exactly 11 pipe-separated fields. Re-send after checking the format.');
    const [name, baseUrlRaw, apiEndpointRaw, apiKey, durationRaw, priorityRaw, apiKeyParam, targetUrlParam, responseUrlPath, responseFormat, verificationMode] = values;
    if (!name || name.length > 80) throw new Error('Provider name must be 1–80 characters.');
    const urls = validateProviderUrls(baseUrlRaw, apiEndpointRaw);
    const duration = Number(durationRaw);
    const priority = Number(priorityRaw);
    if (!Number.isInteger(duration) || duration < 1 || duration > 10080) throw new Error('Checkpoint duration must be 1–10080 minutes.');
    if (!Number.isInteger(priority) || priority < 1 || priority > 100000) throw new Error('Priority must be 1–100000.');
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(apiKeyParam) || !/^[a-zA-Z0-9_-]{1,50}$/.test(targetUrlParam)) throw new Error('API key and URL parameter names are invalid.');
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(responseUrlPath)) throw new Error('Response URL field is invalid.');
    if (!['json', 'text'].includes(responseFormat)) throw new Error('Response format must be json or text.');
    if (!['unverified', 'callback', 'provider_api'].includes(verificationMode)) throw new Error('Verification mode must be unverified, callback, or provider_api.');
    if (apiKey && !config.tokenEncryptionKey) throw new Error('TOKEN_ENCRYPTION_KEY is required to store provider API keys.');
    const provider = await addShortenerProvider(pool, config, { name, ...urls, apiKey, apiKeyParam, targetUrlParam, responseUrlPath, responseFormat, checkpointMinutes: duration, priority, verificationMode }, ctx.from.id);
    await ctx.reply(`Provider saved as disabled.\nID: ${provider.id}\nName: ${provider.name}\n\nProvider verification adapters are not connected yet, so it cannot be activated or grant checkpoint credit.`);
  });

  bot.command('shortener_test', async (ctx) => {
    try {
      const id = getId(ctx);
      const rows = await pool.query('SELECT base_url, api_endpoint, response_url_path, response_format FROM shortener_providers WHERE id = $1', [id]);
      if (!rows.rowCount) return ctx.reply('Provider not found.');
      const p = rows.rows[0];
      validateProviderUrls(p.base_url, p.api_endpoint);
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(p.response_url_path)) throw new Error('Response URL field invalid.');
      if (!['json', 'text'].includes(p.response_format)) throw new Error('Response format invalid.');
      await markShortenerTest(pool, id, 'ok');
      await ctx.reply('Configuration test passed (HTTPS URLs and response settings). This does not test the provider API or checkpoint verification.');
    } catch (error) {
      const idRaw = parts(ctx)[0];
      try { await markShortenerTest(pool, parseId(idRaw), 'failed', error.message); } catch {}
      await ctx.reply('Provider config test failed: ' + error.message);
    }
  });

  bot.command('shortener_duration', async (ctx) => {
    const [idRaw, durationRaw] = parts(ctx);
    const id = parseId(idRaw);
    const duration = Number(durationRaw);
    if (!Number.isInteger(duration) || duration < 1 || duration > 10080) return ctx.reply('Usage: /shortener_duration <provider_id> <1-10080 minutes>');
    try {
      const row = await setShortenerDuration(pool, id, duration);
      await ctx.reply(row ? `Checkpoint duration updated for ${row.name}: ${duration} minutes.` : 'Provider not found.');
    } catch (error) { await ctx.reply('Duration update failed.'); }
  });

  bot.command('shortener_priority', async (ctx) => {
    const [idRaw, priorityRaw] = parts(ctx);
    const id = parseId(idRaw);
    const priority = Number(priorityRaw);
    if (!Number.isInteger(priority) || priority < 1 || priority > 100000) return ctx.reply('Usage: /shortener_priority <provider_id> <1-100000>');
    const row = await setShortenerPriority(pool, id, priority);
    await ctx.reply(row ? `Priority updated for ${row.name}.` : 'Provider not found.');
  });

  bot.command('shortener_enable', async (ctx) => {
    try {
      const id = getId(ctx);
      await ctx.reply('Activation blocked: no provider-specific completion verifier is wired yet. Providers stay disabled until server-side verification is implemented and tested.');
    } catch { await ctx.reply('Usage: /shortener_enable <provider_id>'); }
  });

  bot.command('shortener_disable', async (ctx) => {
    try {
      const id = getId(ctx);
      const row = await setShortenerEnabled(pool, id, false);
      await ctx.reply(row ? `Disabled ${row.name}.` : 'Provider not found.');
    } catch { await ctx.reply('Usage: /shortener_disable <provider_id>'); }
  });

  bot.command('shortener_remove', async (ctx) => {
    try {
      const id = getId(ctx);
      const row = await removeShortenerProvider(pool, id);
      await ctx.reply(row ? `Removed provider ${row.name}.` : 'Not removed. Provider may be missing or has pending sessions.');
    } catch (error) {
      logger.warn({ error: error.message }, 'Shortener removal failed');
      await ctx.reply('Provider removal failed.');
    }
  });
}
