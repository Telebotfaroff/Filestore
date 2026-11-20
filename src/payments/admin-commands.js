import { configurePaymentMethod, disablePaymentMethod, listPaymentMethods, markPaymentMethodTest } from './repository.js';
import { applyVerifiedPayment } from './fulfillment-repository.js';

const METHODS = ['fampay', 'telegram_stars', 'stripe', 'crypto'];
function parseMethod(value) { if (!METHODS.includes(value)) throw new Error('Method must be fampay, telegram_stars, stripe, or crypto.'); return value; }
function args(ctx) { return ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []; }
function hasSensitiveConfigKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => /(secret|token|api.?key|password|credential|private.?key)/i.test(key) || hasSensitiveConfigKey(item));
}
export function registerPaymentAdminCommands(bot, pool, config, logger) {
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
    } catch (error) { await ctx.reply('Payment activation failed: ' + error.message + '\\nUsage: /payment_enable telegram_stars'); }
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
