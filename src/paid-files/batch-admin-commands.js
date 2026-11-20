import { createPaidBatch, listPaidBatchLinks, disablePaidBatchLink, confirmPaidBatchPurchase, listPendingBatchPurchases, getPaidBatch } from './batch-repository.js';

function args(ctx) { return ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []; }
function amount(value) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(String(value ?? ''))) throw new Error('Invalid price format.');
  const n = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Price must be positive.');
  return n;
}
function currency(value) { const c = String(value ?? '').toUpperCase(); if (!/^[A-Z]{3}$/.test(c)) throw new Error('Currency must be 3 letters.'); return c; }
function userId(value) { if (!/^\d{1,20}$/.test(String(value ?? ''))) throw new Error('User ID must be numeric.'); const n = BigInt(value); if (n <= 0n || n > 9223372036854775807n) throw new Error('User ID out of range.'); return n.toString(); }

export function registerPaidBatchAdminCommands(bot, pool, logger) {
  bot.command('batch_link_create', async (ctx) => {
    const raw = ctx.message?.text?.trim().replace(/^\/batch_link_create\s*/, '') ?? '';
    const fields = raw.split('|').map((v) => v.trim());
    if (fields.length < 4 || fields.length > 5) return ctx.reply('Usage: /batch_link_create TITLE|FILE_CODE1,FILE_CODE2,...|PRICE|CURRENCY|expiry_days(optional)\nExample: /batch_link_create Summer Pack|A1B2,C3D4,E5F6|299|INR|30');
    try {
      const title = fields[0];
      if (!title || title.length > 100) throw new Error('Title must be 1–100 characters.');
      const codes = fields[1].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      const price = amount(fields[2]);
      const cur = currency(fields[3]);
      let expiry = null;
      if (fields[4]) {
        const days = Number(fields[4]);
        if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Expiry must be 1–3650 days.');
        expiry = new Date(Date.now() + days * 86400000);
      }
      const result = await createPaidBatch(pool, codes, title, price, cur, expiry, ctx.from.id);
      const names = result.files.map((f, i) => (i + 1) + '. ' + f.file_name + ' (' + f.file_code + ')').join('\n');
      await ctx.reply('Paid batch link created\n\n' + result.title + '\nCode: ' + result.public_code + '\nFiles: ' + result.itemCount + '\nPrice: ' + (Number(result.price_minor) / 100).toFixed(2) + ' ' + result.currency + '\nExpiry: ' + (result.expires_at ? new Date(result.expires_at).toISOString() : 'Never') + '\n\n' + names + '\n\nUser command: /batch ' + result.public_code);
    } catch (error) { await ctx.reply('Batch creation failed: ' + error.message); }
  });

  bot.command('batch_links', async (ctx) => {
    try {
      const rows = await listPaidBatchLinks(pool);
      if (!rows.length) return ctx.reply('No batch links created.');
      const lines = rows.map((b) => `#${b.id} · ${b.is_enabled ? 'ON' : 'OFF'} · ${b.public_code}\n${b.title} · ${b.item_count} files\nPrice: ${(Number(b.price_minor) / 100).toFixed(2)} ${b.currency} · Purchase count: ${b.purchase_count}\nExpires: ${b.expires_at ? new Date(b.expires_at).toISOString() : 'Never'}`);
      await ctx.reply('Paid batch links\n\n' + lines.join('\n\n'));
    } catch (e) { logger.error({ error: e.message }, 'Batch links list failed'); await ctx.reply('Failed to list batches.'); }
  });

  bot.command('batch_requests', async (ctx) => {
    try {
      const rows = await listPendingBatchPurchases(pool);
      if (!rows.length) return ctx.reply('No pending batch purchase requests.');
      const lines = rows.map((p) => `#${p.purchase_id} · ${p.title}\nCode: ${p.public_code}\nUser: ${p.user_telegram_id}\nAmount: ${(Number(p.paid_amount_minor) / 100).toFixed(2)} ${p.currency}\nConfirm: /batch_confirm ${p.public_code} ${p.user_telegram_id}`);
      await ctx.reply('Pending batch purchases\n\n' + lines.join('\n\n'));
    } catch (e) { logger.error({ error: e.message }, 'Batch requests list failed'); await ctx.reply('Failed to list batch requests.'); }
  });

  bot.command('batch_link_disable', async (ctx) => {
    const code = args(ctx)[0];
    if (!code) return ctx.reply('Usage: /batch_link_disable <code>');
    try { const row = await disablePaidBatchLink(pool, code); await ctx.reply(row ? 'Batch link disabled: ' + row.public_code : 'Batch link not found.'); }
    catch { await ctx.reply('Failed to disable batch link.'); }
  });

  bot.command('batch_confirm', async (ctx) => {
    const [code, rawUser] = args(ctx);
    try {
      if (!code || !rawUser) throw new Error('Usage: /batch_confirm <code> <user_id>');
      const id = userId(rawUser);
      const result = await confirmPaidBatchPurchase(pool, code, id, ctx.from.id);
      await ctx.reply(result.alreadyConfirmed ? 'Batch purchase already confirmed.' : 'Batch purchase confirmed. Entitlements granted to all files.');
      if (!result.alreadyConfirmed) {
        const batch = await getPaidBatch(pool, code);
        try { await ctx.telegram.sendMessage(id, 'Payment manually verified for batch: ' + (batch?.title ?? 'your collection') + '. Use /batch_get ' + code + ' to queue all files.'); }
        catch (e) { logger.warn({ userId: id, error: e.message }, 'Batch confirmation notification failed'); }
      }
    } catch (e) { await ctx.reply('Batch confirmation failed: ' + e.message); }
  });
}
