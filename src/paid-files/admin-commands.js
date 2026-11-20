import { createPaidFileLink, disablePaidFileLink, listPaidFileLinks, confirmPaidFilePurchase, getPaidFileLink, listPendingPaidFilePurchases } from './repository.js';

function commandArgs(ctx) { return ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []; }
function parseAmount(value) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(String(value ?? ''))) throw new Error('Price must be numeric with up to 2 decimals.');
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Paid file price must be greater than zero.');
  return amount;
}
function parseCurrency(value) { const code = String(value ?? '').toUpperCase(); if (!/^[A-Z]{3}$/.test(code)) throw new Error('Currency must be a three-letter code.'); return code; }
function parseAdminId(value) { if (!/^\d{1,20}$/.test(String(value ?? ''))) throw new Error('User ID must be numeric.'); const n = BigInt(value); if (n <= 0n || n > 9223372036854775807n) throw new Error('User ID out of range.'); return n.toString(); }

export function registerPaidFileAdminCommands(bot, pool, logger) {
  bot.command('paid_link_create', async (ctx) => {
    const raw = ctx.message?.text?.trim().replace(/^\/paid_link_create\s*/, '') ?? '';
    const fields = raw.split('|').map((s) => s.trim());
    if (fields.length < 3 || fields.length > 4) return ctx.reply('Usage: /paid_link_create FILE_CODE|PRICE|CURRENCY|expiry_days(optional)\nExample: /paid_link_create ABC123|149|INR|7');
    try {
      const fileCode = fields[0].toUpperCase();
      const price = parseAmount(fields[1]);
      const currency = parseCurrency(fields[2]);
      let expiry = null;
      if (fields[3]) {
        const days = Number(fields[3]);
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Expiry days must be 1–3650.');
        expiry = new Date(Date.now() + days * 86400000);
      }
      const row = await createPaidFileLink(pool, fileCode, price, currency, expiry, ctx.from.id);
      await ctx.reply(`Paid file link created\n\nCode: ${row.public_code}\nFile: ${row.file_name}\nFile code: ${row.file_code}\nPrice: ${(Number(row.price_minor) / 100).toFixed(2)} ${row.currency}\nExpiry: ${row.expires_at ? new Date(row.expires_at).toISOString() : 'Never'}\n\nUser command: /paid ${row.public_code}\nDelivery code after payment: /get ${row.file_code}`);
    } catch (error) { await ctx.reply('Could not create paid link: ' + error.message); }
  });

  bot.command('paid_links', async (ctx) => {
    try {
      const rows = await listPaidFileLinks(pool);
      if (!rows.length) return ctx.reply('No paid links yet.');
      const lines = rows.map((row) => `#${row.id} · ${row.is_enabled ? 'ON' : 'OFF'} · ${row.public_code}\n${row.file_name} (${row.file_code})\nPrice: ${(Number(row.price_minor) / 100).toFixed(2)} ${row.currency} · Requests: ${row.purchase_count}\nExpires: ${row.expires_at ? new Date(row.expires_at).toISOString() : 'Never'}`);
      await ctx.reply('Paid file links\n\n' + lines.join('\n\n'));
    } catch (error) { logger.error({ error: error.message }, 'Paid links list failed'); await ctx.reply('Could not list paid links.'); }
  });

  bot.command('paid_requests', async (ctx) => {
    try {
      const rows = await listPendingPaidFilePurchases(pool);
      if (!rows.length) return ctx.reply('No pending paid file requests.');
      const lines = rows.map((r) => `Purchase #${r.purchase_id} · ${r.public_code}\nUser ID: ${r.user_telegram_id}\nFile: ${r.file_name} (${r.file_code})\nAmount: ${(Number(r.paid_amount_minor) / 100).toFixed(2)} ${r.currency}\nRequested: ${new Date(r.created_at).toISOString()}\nConfirm: /paid_confirm ${r.public_code} ${r.user_telegram_id}`);
      await ctx.reply('Pending paid file requests\\n\\n' + lines.join('\\n\\n'));
    } catch (error) { logger.error({ error: error.message }, 'Paid requests listing failed'); await ctx.reply('Could not list pending requests.'); }
  });

  bot.command('paid_link_disable', async (ctx) => {
    try {
      const code = commandArgs(ctx)[0];
      if (!code) return ctx.reply('Usage: /paid_link_disable <link_code>');
      const row = await disablePaidFileLink(pool, code, ctx.from.id);
      await ctx.reply(row ? 'Disabled paid link ' + row.public_code : 'Link not found.');
    } catch (error) { await ctx.reply('Link disable failed.'); }
  });

  bot.command('paid_confirm', async (ctx) => {
    const [code, userRaw] = commandArgs(ctx);
    try {
      if (!code || !userRaw) throw new Error('Usage: /paid_confirm <link_code> <user_id>');
      const userId = parseAdminId(userRaw);
      const result = await confirmPaidFilePurchase(pool, code, userId, ctx.from.id);
      await ctx.reply(result.alreadyConfirmed ? 'Purchase was already confirmed.' : 'Purchase confirmed. Access grant recorded.');
      if (!result.alreadyConfirmed) {
        const link = await getPaidFileLink(pool, code);
        try { await ctx.telegram.sendMessage(userId, 'Your payment has been manually verified. Paid access is unlocked for ' + (link?.file_name ?? 'your file') + '.\\nUse /get ' + (link?.file_code ?? '') + ' to request delivery.'); }
        catch (notifyError) { logger.warn({ userId, error: notifyError.message }, 'Paid purchase confirmation notification failed'); }
      }
    } catch (error) { await ctx.reply('Confirmation failed: ' + error.message); }
  });
}
