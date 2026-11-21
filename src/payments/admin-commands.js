import { configurePaymentMethod, disablePaymentMethod, listPaymentMethods, markPaymentMethodTest, listPaymentTransactions, listExpiredPaymentSessions, listPaymentRecoveryFailures } from './repository.js';
import { applyVerifiedPayment } from './fulfillment-repository.js';
import { saveFamPayConfig, enableFamPay, testFamPayImapConnection, maskEmail } from './fampay.js';
import { enableTelegramStars, setTelegramStarsPrice, testTelegramStars } from './telegram-stars.js';
import { getPaidFileLink } from '../paid-files/repository.js';
import { getPaidBatch } from '../paid-files/batch-repository.js';
import { getCommandArgs, getCommandArgText } from '../bot/telegram-utils.js';
import { formatMoney, parsePositiveInt } from '../utils/validation.js';

const METHODS = ['fampay', 'telegram_stars', 'stripe', 'crypto'];
function parseMethod(value) { if (!METHODS.includes(value)) throw new Error('Method must be fampay, telegram_stars, stripe, or crypto.'); return value; }
function hasSensitiveConfigKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => /(secret|token|api.?key|password|credential|private.?key)/i.test(key) || hasSensitiveConfigKey(item));
}
export function registerPaymentAdminCommands(bot, pool, config, logger) {
  bot.command('payment_transactions', async (ctx) => {
    const status = getCommandArgs(ctx)[0] ?? null;
    try {
      const rows = await listPaymentTransactions(pool, status, 15);
      if (!rows.length) return ctx.reply(status ? `💳 No payment transactions with status "${status}".` : '💳 No payment transactions recorded yet.');
      const lines = rows.map((row) => {
        const amount = formatMoney(row.amount_minor, row.currency);
        return `🧾 #${row.id} · ${String(row.status).toUpperCase()} · ${row.method}\n👤 User: ${row.user_telegram_id ?? 'unknown'} · ${row.purpose}\n💰 ${amount} · 🔑 ${row.external_transaction_id ?? 'no provider ID'}\n🕒 ${new Date(row.created_at).toISOString()}`;
      });
      await ctx.reply(`💳 Payment Transactions (latest 15)${status ? ' · ' + status : ''}\n━━━━━━━━━━━━━━━━━━\n` + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Payment transaction listing failed');
      await ctx.reply('❌ Could not list payment transactions. Valid filters: pending, verified, applied, rejected, expired.');
    }
  });

  bot.command('payment_sessions_expired', async (ctx) => {
    try {
      const rows = await listExpiredPaymentSessions(pool, 20);
      if (!rows.length) return ctx.reply('✅ No expired checkout sessions found.');
      const lines = rows.map((s) => `⌛ #${s.id} · ${s.method} · ${s.purpose}\n👤 User: ${s.user_telegram_id}\n💰 ${formatMoney(s.expected_amount_minor, s.currency)}\n🕒 Expired: ${new Date(s.expires_at).toISOString()}`);
      await ctx.reply('⌛ Expired Checkout Sessions (latest 20)\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Expired payment session listing failed');
      await ctx.reply('❌ Could not list expired checkout sessions.');
    }
  });


  bot.command('payment_recovery_pending', async (ctx) => {
    try {
      const rows = await listPaymentRecoveryFailures(pool, 20);
      if (!rows.length) return ctx.reply('✅ No payment fulfillment recovery failures recorded.');
      const lines = rows.map((tx) => `⚠️ #${tx.id} · ${tx.method} · ${tx.purpose}\n👤 User: ${tx.user_telegram_id ?? 'unknown'} · 💰 ${formatMoney(tx.amount_minor, tx.currency)}\n🔁 Attempts: ${tx.recovery_attempts} · Next retry: ${new Date(tx.recovery_next_at).toISOString()}\n💬 Error: ${tx.recovery_last_error ?? 'unknown'}`);
      await ctx.reply('🔄 Verified Payments Awaiting Recovery (latest 20)\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Payment recovery diagnostic listing failed');
      await ctx.reply('❌ Could not list payment recovery failures.');
    }
  });


  bot.command('payment_methods', async (ctx) => {
    try {
      const rows = await listPaymentMethods(pool);
      const lines = rows.map((row) => `${row.is_enabled ? '🟢' : '⚪'} ${row.method} · setup: ${row.setup_status} · test: ${row.last_test_status}`);
      await ctx.reply('💳 Payment Gateways\n━━━━━━━━━━━━━━━━━━\n' + (lines.join('\n') || '📭 No payment methods configured'));
    } catch (error) {
      logger.error({ error: error.message }, 'Payment methods list failed');
      await ctx.reply('❌ Could not load payment methods.');
    }
  });

  bot.command('payment_set', async (ctx) => {
    const text = ctx.message?.text?.trim().replace(/^\/payment_set\s*/, '') ?? '';
    if (!text) return ctx.reply('ℹ️ Usage: /admin payment_set method|secret|public_config_json');
    try { await ctx.deleteMessage(); } catch {}
    try {
      const fields = text.split('|');
      if (fields.length !== 3) throw new Error('Use exactly three pipe-separated fields.');
      const method = parseMethod(fields[0].trim());
      const secret = fields[1].trim();
      const publicConfig = JSON.parse(fields[2].trim());
      if (!publicConfig || typeof publicConfig !== 'object' || Array.isArray(publicConfig)) throw new Error('Config must be a JSON object.');
      if (hasSensitiveConfigKey(publicConfig)) throw new Error('Put secret values in the secret field, not public config.');
      if (secret && !config.tokenEncryptionKey) throw new Error('TOKEN_ENCRYPTION_KEY is required to encrypt payment secrets.');
      const row = await configurePaymentMethod(pool, config, method, secret, publicConfig, ctx.from.id);
      if (!row) throw new Error('Unknown payment method.');
      if (row.method === 'telegram_stars' || row.method === 'fampay') {
        await ctx.reply(`✅ Saved ${row.method} configuration.\n🧪 Run /admin payment_test ${row.method} and /admin payment_enable ${row.method} to activate.`);
      } else {
        await ctx.reply(`✅ Saved ${row.method} configuration.\nℹ️ Gateway adapter is not connected yet, so the method remains disabled.`);
      }
    } catch (error) { await ctx.reply('❌ Payment configuration failed: ' + error.message); }
  });

  bot.command('stars_set', async (ctx) => {
    const [purposeRaw, targetRaw, starsRaw] = getCommandArgs(ctx);
    if (!purposeRaw || !targetRaw || starsRaw === undefined) {
      return ctx.reply(
        '⭐ Usage:\n/admin stars_set <premium|paid_file|paid_batch> <id_or_code> <stars>\n\n✨ Examples:\n/admin stars_set premium 1 50\n/admin stars_set paid_file 1 25\n/admin stars_set paid_batch PACKCODE 100\n💡 Use 0 stars to remove a price.',
      );
    }
    try {
      const purpose = purposeRaw.trim().toLowerCase();
      if (!['premium', 'paid_file', 'paid_batch'].includes(purpose)) {
        throw new Error('Purpose must be premium, paid_file, or paid_batch.');
      }
      if (!/^\d+$/.test(starsRaw.trim())) {
        throw new Error('Stars price must be a non-negative integer.');
      }
      const stars = Number(starsRaw.trim());
      let resolvedId;
      let targetLabel;
      if (purpose === 'premium') {
        resolvedId = parsePositiveInt(targetRaw, 'Plan ID');
        const planRes = await pool.query('SELECT id, name FROM premium_plans WHERE id = $1 LIMIT 1', [resolvedId]);
        if (!planRes.rowCount) throw new Error(`Premium plan #${resolvedId} not found.`);
        targetLabel = `Plan #${resolvedId} (${planRes.rows[0].name})`;
      } else if (purpose === 'paid_file') {
        if (/^\d+$/.test(targetRaw.trim())) {
          resolvedId = Number(targetRaw.trim());
          const linkRes = await pool.query('SELECT id, public_code FROM paid_file_links WHERE id = $1 LIMIT 1', [resolvedId]);
          if (!linkRes.rowCount) throw new Error(`Paid file link #${resolvedId} not found.`);
          targetLabel = `Paid Link #${resolvedId} (${linkRes.rows[0].public_code})`;
        } else {
          const link = await getPaidFileLink(pool, targetRaw.trim());
          if (!link) throw new Error(`Paid file link "${targetRaw}" not found.`);
          resolvedId = link.id;
          targetLabel = `Paid Link #${link.id} (${link.public_code})`;
        }
      } else {
        if (/^\d+$/.test(targetRaw.trim())) {
          resolvedId = Number(targetRaw.trim());
          const batchRes = await pool.query('SELECT id, public_code, title FROM paid_batch_links WHERE id = $1 LIMIT 1', [resolvedId]);
          if (!batchRes.rowCount) throw new Error(`Paid batch link #${resolvedId} not found.`);
          targetLabel = `Batch #${resolvedId} (${batchRes.rows[0].title})`;
        } else {
          const batch = await getPaidBatch(pool, targetRaw.trim());
          if (!batch) throw new Error(`Paid batch "${targetRaw}" not found.`);
          resolvedId = batch.id;
          targetLabel = `Batch #${batch.id} (${batch.title})`;
        }
      }

      const updated = await setTelegramStarsPrice(pool, purpose, resolvedId, stars, ctx.from.id);
      await ctx.reply(
        stars === 0
          ? `🗑️ Removed Telegram Stars price for ${targetLabel}.`
          : `⭐ Set Telegram Stars price for ${targetLabel}: ${stars} ⭐\n⚡ Gateway: ${updated.isEnabled ? '🟢 ENABLED' : '🔴 DISABLED (run /admin payment_enable telegram_stars to activate)'}`,
      );
    } catch (error) {
      await ctx.reply('❌ Stars price update failed: ' + error.message);
    }
  });

  bot.command('fampay_set', async (ctx) => {
    const raw = getCommandArgText(ctx);
    if (!raw) return ctx.reply('ℹ️ Usage: /admin fampay_set <gmail_email>|<gmail_app_password>|<upi_id>|[merchant_name]');
    try { await ctx.deleteMessage(); } catch {}
    try {
      const fields = raw.split('|').map((s) => s.trim());
      if (fields.length < 3 || fields.length > 4) throw new Error('Use: gmail_email|gmail_app_password|upi_id|merchant_name(optional)');
      const saved = await saveFamPayConfig(pool, config, {
        gmailEmail: fields[0],
        gmailAppPassword: fields[1],
        upiId: fields[2],
        ...(fields[3] ? { merchantName: fields[3] } : {}),
      }, ctx.from.id);
      await ctx.reply(
        `✅ FamPay Configuration Saved!\n━━━━━━━━━━━━━━━━━━\n📧 Gmail: ${maskEmail(saved.gmailEmail)}\n🏦 UPI ID: ${saved.upiId}\n🏷 Merchant: ${saved.merchantName}\n🔒 App Password: ${saved.hasAppPassword ? 'Encrypted & saved' : 'Missing'}\n\n🧪 Run /admin payment_test fampay and /admin payment_enable fampay to activate.`,
      );
    } catch (error) {
      await ctx.reply('❌ FamPay setup failed: ' + error.message);
    }
  });

  bot.command('payment_test', async (ctx) => {
    try {
      const method = parseMethod(getCommandArgs(ctx)[0]);
      if (method === 'fampay') {
        const res = await testFamPayImapConnection(pool, config);
        return ctx.reply(`✅ FamPay Gmail IMAP Check Passed!\n━━━━━━━━━━━━━━━━━━\n📧 Gmail: ${maskEmail(res.gmailEmail)}\n🏦 UPI ID: ${res.upiId}\n📥 INBOX messages: ${res.inboxMessages}`);
      }
      if (method === 'telegram_stars') {
        const res = await testTelegramStars(ctx.telegram, pool);
        return ctx.reply(
          `✅ Telegram Stars Check Passed!\n━━━━━━━━━━━━━━━━━━\n🤖 Bot API: @${res.botUsername ?? 'connected'}\n⭐ Configured prices: ${res.counts.premium} plan(s), ${res.counts.paid_file} file(s), ${res.counts.paid_batch} batch(es)\n⚡ Status: ${res.isEnabled ? '🟢 ENABLED' : '🔴 DISABLED (enable via /admin payment_enable telegram_stars)'}`,
        );
      }
      await markPaymentMethodTest(pool, method, 'failed', 'Gateway adapter not connected.');
      await ctx.reply(`⚠️ ${method} adapter is not connected yet. Use fampay or telegram_stars.`);
    } catch (error) {
      const methodRaw = getCommandArgs(ctx)[0];
      try { await markPaymentMethodTest(pool, parseMethod(methodRaw), 'failed', error.message); } catch {}
      await ctx.reply('❌ Payment configuration test failed: ' + error.message);
    }
  });

  bot.command('payment_enable', async (ctx) => {
    try {
      const method = parseMethod(getCommandArgs(ctx)[0]);
      if (method === 'fampay') {
        const enabled = await enableFamPay(pool, config, ctx.from.id);
        return ctx.reply(`🟢 FamPay UPI Checkout Enabled!\n━━━━━━━━━━━━━━━━━━\n📧 Gmail: ${maskEmail(enabled.gmailEmail)}\n🏦 UPI ID: ${enabled.upiId}`);
      }
      if (method !== 'telegram_stars') return ctx.reply('⚠️ Activation blocked: only telegram_stars and fampay have verification implemented.');
      const enabled = await enableTelegramStars(pool, ctx.from.id);
      await ctx.reply(`🟢 Telegram Stars Checkout Enabled! (${enabled.counts.total} price(s) configured)`);
    } catch (error) { await ctx.reply('❌ Payment activation failed: ' + error.message + '\nℹ️ Usage: /admin payment_enable <telegram_stars|fampay>'); }
  });

  bot.command('payment_apply', async (ctx) => {
    let transactionId;
    try { transactionId = parsePositiveInt(getCommandArgs(ctx)[0], 'Transaction ID'); }
    catch { return ctx.reply('ℹ️ Usage: /admin payment_apply <verified_transaction_id>'); }
    try {
      const result = await applyVerifiedPayment(pool, transactionId, { adminIds: config?.adminIds ?? [] });
      if (result.creatorCredit) {
        const { notifyCreatorSale } = await import('../wallet/notifications.js');
        await notifyCreatorSale(ctx.telegram, result.creatorCredit, logger).catch(() => {});
      }
      await ctx.reply(
        result.alreadyApplied
          ? 'ℹ️ Payment was already fulfilled. No duplicate grant created.'
          : `✅ Payment Fulfilled!\n━━━━━━━━━━━━━━━━━━\n📦 Type: ${result.type}\n👤 User: ${result.userId}${result.fileCount ? `\n📄 Files: ${result.fileCount}` : ''}`,
      );
    } catch (error) {
      logger.error({ transactionId, error: error.message }, 'Payment fulfillment failed');
      await ctx.reply('❌ Fulfillment failed safely: ' + error.message);
    }
  });


  bot.command('payment_disable', async (ctx) => {
    try {
      const method = parseMethod(getCommandArgs(ctx)[0]);
      const row = await disablePaymentMethod(pool, method, ctx.from.id);
      await ctx.reply(row ? `⚪ Disabled ${row.method}.` : '❌ Method not found.');
    } catch { await ctx.reply('ℹ️ Usage: /admin payment_disable <method>'); }
  });
}
