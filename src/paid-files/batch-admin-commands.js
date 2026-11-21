import { isAdmin } from '../bot/admin-guard.js';
import { listPaidBatchLinks, disablePaidBatchLink, deletePaidBatchLink, confirmPaidBatchPurchase, listPendingBatchPurchases, getPaidBatch } from './batch-repository.js';
import { getCommandArgs } from '../bot/telegram-utils.js';
import {
  parseTelegramUserId,
  formatMoney,
} from '../utils/validation.js';

export function registerPaidBatchAdminCommands(bot, pool, logger, config = null, adminBot = bot) {
  const isOwnerAdmin = (ctx) => !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
  const scopeOwner = (ctx) => (isOwnerAdmin(ctx) ? null : Number(ctx.from.id));
  const ownerCmdBot = adminBot ?? bot;

  bot.command('batch_links', async (ctx) => {
    try {
      const rows = await listPaidBatchLinks(pool, 30, scopeOwner(ctx));
      if (!rows.length) return ctx.reply('📦 No paid batch links created yet.\n💡 Create one anytime with /plink.');
      const lines = rows.map((b) => `${b.is_enabled ? '🟢' : '⚪'} #${b.id} · ${b.public_code}\n📦 ${b.title} · ${b.item_count} file(s)\n💵 ${formatMoney(b.price_minor, b.currency)} · 🧾 ${b.purchase_count} purchase(s)\n⏳ Expires: ${b.expires_at ? new Date(b.expires_at).toISOString() : 'Never'}`);
      await ctx.reply('📦 Paid Batch Links\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (e) { logger.error({ error: e.message }, 'Batch links list failed'); await ctx.reply('❌ Failed to list batch links.'); }
  });

  ownerCmdBot.command('batch_requests', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return ctx.reply('🔒 This command is restricted to the platform owner.');
    try {
      const rows = await listPendingBatchPurchases(pool);
      if (!rows.length) return ctx.reply('✅ No pending batch purchase requests.');
      const lines = rows.map((p) => `⏳ #${p.purchase_id} · ${p.title}\n🔑 Code: ${p.public_code}\n👤 User: ${p.user_telegram_id}\n💵 Amount: ${formatMoney(p.paid_amount_minor, p.currency)}\n✅ Confirm: /admin batch_confirm ${p.public_code} ${p.user_telegram_id}`);
      await ctx.reply('⏳ Pending Batch Purchases\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (e) { logger.error({ error: e.message }, 'Batch requests list failed'); await ctx.reply('❌ Failed to list batch requests.'); }
  });

  bot.command('batch_link_disable', async (ctx) => {
    const code = getCommandArgs(ctx)[0];
    if (!code) return ctx.reply('ℹ️ Usage: /batch_link_disable <code>');
    try { const row = await disablePaidBatchLink(pool, code, scopeOwner(ctx)); await ctx.reply(row ? `⏸ Batch link disabled: ${row.public_code}` : '❌ Batch link not found.'); }
    catch { await ctx.reply('❌ Failed to disable batch link.'); }
  });

  bot.command('batch_link_delete', async (ctx) => {
    const idOrCode = getCommandArgs(ctx)[0];
    if (!idOrCode) return ctx.reply('ℹ️ Usage: /batch_link_delete <batch_code_or_id>');
    try {
      const row = await deletePaidBatchLink(pool, idOrCode, scopeOwner(ctx));
      await ctx.reply(row ? `🗑️ Deleted paid batch link ${row.public_code} (${row.title}).` : '❌ Batch link not found.');
    } catch (e) { await ctx.reply('❌ Failed to delete batch link: ' + e.message); }
  });

  ownerCmdBot.command('batch_confirm', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return ctx.reply('🔒 This command is restricted to the platform owner.');
    const [code, rawUser] = getCommandArgs(ctx);
    try {
      if (!code || !rawUser) throw new Error('Usage: /admin batch_confirm <code> <user_id>');
      const id = parseTelegramUserId(rawUser, 'User ID');
      const result = await confirmPaidBatchPurchase(pool, code, id, ctx.from.id);
      await ctx.reply(result.alreadyConfirmed ? 'ℹ️ Batch purchase was already confirmed.' : '✅ Batch purchase confirmed! Entitlements granted to all files.');
      if (!result.alreadyConfirmed) {
        const batch = await getPaidBatch(pool, code);
        try {
          await ctx.telegram.sendMessage(
            id,
            `🎉 Batch Payment Verified!\n━━━━━━━━━━━━━━━━━━\n📦 Collection: ${batch?.title ?? 'your collection'}\n🔓 All files in this batch are unlocked!\n\n👇 Queue delivery anytime:\n/batch_get ${code}`,
          );
        }
        catch (e) { logger.warn({ userId: id, error: e.message }, 'Batch confirmation notification failed'); }
      }
    } catch (e) { await ctx.reply('❌ Batch confirmation failed: ' + e.message); }
  });
}
