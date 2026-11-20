import { configurePaymentMethod, disablePaymentMethod, listPaymentMethods, markPaymentMethodTest, listPaymentTransactions, listExpiredPaymentSessions, listPaymentRecoveryFailures } from './repository.js';
import { applyVerifiedPayment } from './fulfillment-repository.js';

const METHODS = ['fampay', 'telegram_stars', 'stripe', 'crypto'];
function parseMethod(value) { if (!METHODS.includes(value)) throw new Error('Method must be fampay, telegram_stars, stripe, or crypto.'); return value; }
function args(ctx) { return ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []; }
function hasSensitiveConfigKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => /(secret|token|api.?key|password|credential|private.?key)/i.test(key) || hasSensitiveConfigKey(item));
}
export function registerPaymentAdminCommands(bot, pool, config, logger) {
  bot.command('payment_transactions', async (ctx) => {
    const status = args(ctx)[0] ?? null;
    try {
      const rows = await listPaymentTransactions(pool, status, 15);
      if (!rows.length) return ctx.reply(status ? 'No payment transactions with status ' + status + '.' : 'No payment transactions recorded.');
      const lines = rows.map((row) => {
        const amount = (Number(row.amount_minor) / 100).toFixed(2) + ' ' + row.currency;
        return `#${row.id} · ${String(row.status).toUpperCase()} · ${row.method}
User: ${row.user_telegram_id ?? 'unknown'} · ${row.purpose}
Amount: ${amount} · ${row.external_transaction_id ?? 'no provider ID'}
Created: ${new Date(row.created_at).toISOString()}`;
      });
      await ctx.reply('Payment transactions (latest 15)' + (status ? ' · ' + status : '') + '\\n\\n' + lines.join('\\n\\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Payment transaction listing failed');
      await ctx.reply('Could not list payment transactions. Valid filters: pending, verified, applied, rejected, expired.');
    }
  });

  bot.command('payment_sessions_expired', async (ctx) => {
    try {
      const rows = await listExpiredPaymentSessions(pool, 20);
      if (!rows.length) return ctx.reply('No expired checkout sessions found.');
      const lines = rows.map((s) => `#${s.id} · ${s.method} · ${s.purpose}\\nUser: ${s.user_telegram_id}\\nAmount: ${(Number(s.expected_amount_minor) / 100).toFixed(2)} ${s.currency}\\nExpired: ${new Date(s.expires_at).toISOString()}`);
      await ctx.reply('Expired checkout sessions (latest 20)\\n\\n' + lines.join('\\n\\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Expired payment session listing failed');
      await ctx.reply('Could not list expired checkout sessions.');
    }
  });


  bot.command('payment_recovery_pending', async (ctx) => {
    try {
      const rows = await listPaymentRecoveryFailures(pool, 20);
      if (!rows.length) return ctx.reply('No payment fulfillment recovery failures recorded.');
      const lines = rows.map((tx) => `#${tx.id} · ${tx.method} · ${tx.purpose}\nUser: ${tx.user_telegram_id ?? 'unknown'} · ${(Number(tx.amount_minor) / 100).toFixed(2)} ${tx.currency}\nAttempts: ${tx.recovery_attempts} · Next retry: ${new Date(tx.recovery_next_at).toISOString()}\nError: ${tx.recovery_last_error ?? 'unknown'}`);
      await ctx.reply('Verified payments awaiting recovery (latest 20)\n\n' + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Payment recovery diagnostic listing failed');
      await ctx.reply('Could not list payment recovery failures.');
    }
  });


  bot.command('payment_methods', async (ctx) => {
    try {
      const rows = await listPaymentMethods(pool);
      const lines = rows.map((row) => `${row.method} · ${row.is_enabled ? 'ON' : 'OFF'} · setup ${row.setup_status} · test ${row.last_test_status}`);
      await ctx.reply('Payment gateways\n\n' + (lines.join('\n') || 'No payment methods configured'));
    } catch (error) {
      logger.error({ error: error.message }, 'Payment methods list failed');
      await ctx.reply('Could not load payment methods.');
    }
  });

  bot.command('payment_set', async (ctx) => {
    const text = ctx.message?.text?.trim().replace(/^\/payment_set\s*/, '') ?? '';
    if (!text) return ctx.reply('Usage: /payment_set method|secret|public_config_json');
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
      await ctx.reply(`Saved ${row.method} configuration. Gateway integration is not yet connected, so the method remains disabled.`);
    } catch (error) { await ctx.reply('Payment configuration failed: ' + error.message); }
  });

  bot.command('payment_test', async (ctx) => {
    try {
      const method = parseMethod(args(ctx)[0]);
      const result = await pool.query('SELECT setup_status, public_config FROM payment_methods WHERE method = $1', [method]);
      if (!result.rowCount) return ctx.reply('Payment method not found.');
      const setup = result.rows[0];
      if (setup.setup_status !== 'configured') throw new Error('Method has not been configured.');
      if (!setup.public_config || typeof setup.public_config !== 'object' || Array.isArray(setup.public_config)) throw new Error('Public config must be a JSON object.');
      await markPaymentMethodTest(pool, method, 'unknown');
      await ctx.reply('Configuration check passed only. This is not a live payment, webhook, signature, or automatic verification test.');
    } catch (error) {
      const methodRaw = args(ctx)[0];
      try { await markPaymentMethodTest(pool, parseMethod(methodRaw), 'failed', error.message); } catch {}
      await ctx.reply('Payment configuration test failed: ' + error.message);
    }
  });

  bot.command('payment_enable', async (ctx) => {
    try {
      const method = parseMethod(args(ctx)[0]);
      if (method !== 'telegram_stars') return ctx.reply('Activation blocked: only Telegram Stars has checkout and server-side verification implemented.');
      const row = await pool.query('SELECT public_config FROM payment_methods WHERE method=$1', [method]);
      const config = row.rows[0]?.public_config ?? {};
      const prices = config.stars_prices;
      if (!prices || typeof prices !== 'object' || Array.isArray(prices) || !Object.values(prices).some(v => v && typeof v === 'object' && Object.values(v).some(n => Number.isSafeInteger(Number(n)) && Number(n) > 0))) throw new Error('Set at least one Stars price map before activation.');
      await pool.query("UPDATE payment_methods SET is_enabled=TRUE, setup_status='configured', last_test_status='unknown', last_test_error=NULL, updated_by=$2, updated_at=NOW() WHERE method=$1", [method, ctx.from.id]);
      await ctx.reply('Telegram Stars checkout enabled. Prices are read from the configured stars_prices maps.');
    } catch (error) { await ctx.reply('Payment activation failed: ' + error.message + '\nUsage: /payment_enable telegram_stars'); }
  });

  bot.command('payment_apply', async (ctx) => {
    const transactionId = Number(args(ctx)[0]);
    if (!Number.isSafeInteger(transactionId) || transactionId <= 0) return ctx.reply('Usage: /payment_apply <verified_transaction_id>');
    try {
      const result = await applyVerifiedPayment(pool, transactionId);
      await ctx.reply(result.alreadyApplied ? 'Payment was already fulfilled. No duplicate grant created.' : 'Payment fulfilled successfully: ' + result.type + ' · user ' + result.userId + (result.fileCount ? ' · ' + result.fileCount + ' files' : ''));
    } catch (error) {
      logger.error({ transactionId, error: error.message }, 'Payment fulfillment failed');
      await ctx.reply('Fulfillment failed safely: ' + error.message);
    }
  });


  bot.command('payment_disable', async (ctx) => {
    try {
      const method = parseMethod(args(ctx)[0]);
      const row = await disablePaymentMethod(pool, method, ctx.from.id);
      await ctx.reply(row ? `Disabled ${row.method}.` : 'Method not found.');
    } catch { await ctx.reply('Usage: /payment_disable <method>'); }
  });
}
