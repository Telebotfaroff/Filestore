import { isAdmin } from '../bot/admin-guard.js';
import {
  addShortenerProvider,
  decryptShortenerApiKey,
  getShortenerProviderById,
  listShortenerProviders,
  markShortenerTest,
  parseShortenerInput,
  removeShortenerProvider,
  setShortenerDuration,
  setShortenerEnabled,
  setShortenerPriority,
  updateShortenerCredentials,
} from './shortener-repository.js';
import { shortenUrlWithProvider } from './checkpoint-engine.js';
import { getShareableBotUsername } from '../storage/share-links-repository.js';
import { getCommandArgs } from '../bot/telegram-utils.js';
import { parsePositiveInt } from '../utils/validation.js';

function getId(ctx) {
  return parsePositiveInt(getCommandArgs(ctx)[0] ?? '', 'Provider ID');
}

function getCallerOwnerScope(ctx, config) {
  const isOwnerAdmin = !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
  return isOwnerAdmin ? null : Number(ctx.from?.id);
}

async function resolveTestTargetUrl(pool, ctx, ownerId = null) {
  const deliveryUsername = await getShareableBotUsername(pool, ownerId ?? ctx.from?.id ?? null).catch(() => null);
  const botHandle = deliveryUsername || ctx.botInfo?.username || 'telegram';
  return `https://t.me/${String(botHandle).replace(/^@+/, '')}?start=chk_test`;
}

export function registerShortenerAdminCommands(bot, pool, config, logger) {
  bot.command('shorteners', async (ctx) => {
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const rows = await listShortenerProviders(pool, ownerId);
      if (!rows.length) {
        return ctx.reply(
          '🔗 URL Shortener Manager\n━━━━━━━━━━━━━━━━━━\n📭 No URL shortener providers configured yet.\n\n💡 Add one with:\n/shortener_add https://shrinkme.io|YOUR_API_KEY\nor open Menu → 🔗 Shorteners → ➕ Add Shortener',
        );
      }
      const list = rows.map(
        (p) =>
          `${p.is_enabled ? '🟢' : '⚪'} #${p.id} ${p.name} · ${p.is_enabled ? 'ENABLED' : 'DISABLED'}\n🌐 Base: ${p.base_url} · 🔑 ${p.has_api_key ? 'Saved' : 'Missing'}\n🔢 Priority: ${p.priority} · ⏱ ${p.checkpoint_minutes}m · 🧪 ${p.last_test_status}`,
      );
      await ctx.reply('🔗 URL Shortener Manager\n━━━━━━━━━━━━━━━━━━\n' + list.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Shortener list failed');
      await ctx.reply('❌ Could not load shortener providers.');
    }
  });

  bot.command('shortener_add', async (ctx) => {
    const text = ctx.message?.text?.trim().replace(/^\/shortener_add(@\S+)?\s*/, '') ?? '';
    if (!text) {
      return ctx.reply(
        'ℹ️ Usage:\n/shortener_add <base_url>|<api_key>\n/shortener_add <name>|<base_url>|<api_key>|[minutes]|[priority]\n\n✨ Example:\n/shortener_add https://shrinkme.io|YOUR_API_KEY',
      );
    }
    try { await ctx.deleteMessage(); } catch {}
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const existing = await listShortenerProviders(pool, ownerId);
      const parsed = parseShortenerInput(text, existing);
      const provider = await addShortenerProvider(pool, config, parsed, ctx.from.id, ownerId);

      let testSummary = '🧪 Not tested yet.';
      try {
        const full = await getShortenerProviderById(pool, provider.id, ownerId);
        const apiKey = decryptShortenerApiKey(full, config.tokenEncryptionKey);
        if (apiKey && full.verification_mode !== 'unverified') {
          const targetUrl = await resolveTestTargetUrl(pool, ctx, ownerId);
          const result = await shortenUrlWithProvider(full, targetUrl, apiKey);
          await markShortenerTest(pool, provider.id, 'ok');
          testSummary = `🧪 Live API OK → ${result.shortUrl}`;
        }
      } catch (testError) {
        await markShortenerTest(pool, provider.id, 'failed', testError.message).catch(() => {});
        testSummary = `⚠️ API test warning: ${testError.message}`;
      }

      await ctx.reply(
        `✅ Shortener #${provider.id} Saved (${provider.is_enabled ? '🟢 ENABLED' : '⚪ DISABLED'})\n━━━━━━━━━━━━━━━━━━\n🏷 Name: ${provider.name}\n🌐 Base URL: ${provider.base_url}\n🔌 API Endpoint: ${provider.api_endpoint}\n⏱ Duration: ${provider.checkpoint_minutes}m · 🔢 Priority: ${provider.priority}\n${testSummary}`,
        { disable_web_page_preview: true },
      );
    } catch (error) {
      await ctx.reply('❌ Could not add shortener provider: ' + error.message);
    }
  });

  bot.command('shortener_key', async (ctx) => {
    const args = getCommandArgs(ctx);
    const idRaw = args[0] ?? '';
    const apiKey = args.slice(1).join(' ').trim();
    if (!idRaw || !apiKey) return ctx.reply('ℹ️ Usage: /shortener_key <provider_id> <api_key>');
    try { await ctx.deleteMessage(); } catch {}
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const id = parsePositiveInt(idRaw, 'Provider ID');
      const updated = await updateShortenerCredentials(pool, config, id, { apiKey }, ownerId);
      if (!updated) return ctx.reply('❌ Provider not found.');
      await ctx.reply(`✅ API key updated for #${updated.id} ${updated.name} (🔒 Encrypted).\n🧪 Run /shortener_test ${updated.id} to verify.`);
    } catch (error) {
      await ctx.reply('❌ Could not update API key: ' + error.message);
    }
  });

  bot.command('shortener_test', async (ctx) => {
    let id;
    try {
      id = getId(ctx);
    } catch {
      return ctx.reply('ℹ️ Usage: /shortener_test <provider_id>');
    }
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const provider = await getShortenerProviderById(pool, id, ownerId);
      if (!provider) return ctx.reply('❌ Provider not found.');
      const apiKey = decryptShortenerApiKey(provider, config.tokenEncryptionKey);
      if (!apiKey) throw new Error('Provider does not have an API key saved.');
      const targetUrl = await resolveTestTargetUrl(pool, ctx, ownerId);
      const result = await shortenUrlWithProvider(provider, targetUrl, apiKey);
      await markShortenerTest(pool, id, 'ok');
      await ctx.reply(
        `✅ Live API Test Passed!\n━━━━━━━━━━━━━━━━━━\n🔗 Provider: #${provider.id} ${provider.name}\n🚀 Short URL: ${result.shortUrl}`,
        { disable_web_page_preview: true },
      );
    } catch (error) {
      await markShortenerTest(pool, id, 'failed', error.message).catch(() => {});
      await ctx.reply('❌ Shortener API test failed: ' + error.message);
    }
  });

  bot.command('shortener_duration', async (ctx) => {
    const [idRaw, durationRaw] = getCommandArgs(ctx);
    let id;
    try { id = parsePositiveInt(idRaw, 'Provider ID'); }
    catch { return ctx.reply('ℹ️ Usage: /shortener_duration <provider_id> <1-10080 minutes>'); }
    const duration = Number(durationRaw);
    if (!Number.isInteger(duration) || duration < 1 || duration > 10080) {
      return ctx.reply('ℹ️ Usage: /shortener_duration <provider_id> <1-10080 minutes>');
    }
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const row = await setShortenerDuration(pool, id, duration, ownerId);
      await ctx.reply(row ? `✅ Checkpoint duration updated for ${row.name}: ${duration} minutes.` : '❌ Provider not found.');
    } catch {
      await ctx.reply('❌ Duration update failed.');
    }
  });

  bot.command('shortener_priority', async (ctx) => {
    const [idRaw, priorityRaw] = getCommandArgs(ctx);
    let id;
    try { id = parsePositiveInt(idRaw, 'Provider ID'); }
    catch { return ctx.reply('ℹ️ Usage: /shortener_priority <provider_id> <1-100000>'); }
    const priority = Number(priorityRaw);
    if (!Number.isInteger(priority) || priority < 1 || priority > 100000) {
      return ctx.reply('ℹ️ Usage: /shortener_priority <provider_id> <1-100000>');
    }
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const row = await setShortenerPriority(pool, id, priority, ownerId);
      await ctx.reply(row ? `✅ Priority updated for ${row.name}: ${priority}.` : '❌ Provider not found.');
    } catch {
      await ctx.reply('❌ Priority update failed.');
    }
  });

  bot.command('shortener_enable', async (ctx) => {
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const id = getId(ctx);
      const provider = await getShortenerProviderById(pool, id, ownerId);
      if (!provider) return ctx.reply('❌ Provider not found.');
      if (!provider.api_key_ciphertext) {
        return ctx.reply('⚠️ Cannot enable: set an API key first with /shortener_key <id> <api_key>.');
      }
      const row = await setShortenerEnabled(pool, id, true, ownerId);
      await ctx.reply(row ? `🟢 Enabled shortener #${row.id} ${row.name} (mode: ${row.verification_mode}).` : '❌ Provider not found.');
    } catch {
      await ctx.reply('ℹ️ Usage: /shortener_enable <provider_id>');
    }
  });

  bot.command('shortener_disable', async (ctx) => {
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const id = getId(ctx);
      const row = await setShortenerEnabled(pool, id, false, ownerId);
      await ctx.reply(row ? `⚪ Disabled ${row.name}.` : '❌ Provider not found.');
    } catch {
      await ctx.reply('ℹ️ Usage: /shortener_disable <provider_id>');
    }
  });

  bot.command('shortener_remove', async (ctx) => {
    try {
      const ownerId = getCallerOwnerScope(ctx, config);
      const id = getId(ctx);
      const res = await removeShortenerProvider(pool, id, ownerId);
      if (res.removed) return ctx.reply(`🗑️ Removed provider ${res.name}.`);
      if (res.disabled) return ctx.reply(`⚠️ Provider ${res.name} has session history and cannot be deleted; disabled instead.`);
      return ctx.reply('⚠️ Not removed. Provider may be missing or has pending verification sessions.');
    } catch (error) {
      logger.warn({ error: error.message }, 'Shortener removal failed');
      await ctx.reply('❌ Provider removal failed.');
    }
  });
}

