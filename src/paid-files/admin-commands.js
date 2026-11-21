import { isAdmin } from '../bot/admin-guard.js';
import { disablePaidFileLink, deletePaidFileLink, listPaidFileLinks, confirmPaidFilePurchase, getPaidFileLink, listPendingPaidFilePurchases } from './repository.js';
import { getCommandArgs } from '../bot/telegram-utils.js';
import {
  parseTelegramUserId,
  formatMoney,
} from '../utils/validation.js';

export function registerPaidFileAdminCommands(bot, pool, logger, config = null, adminBot = bot) {
  const isOwnerAdmin = (ctx) => !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
  const scopeOwner = (ctx) => (isOwnerAdmin(ctx) ? null : Number(ctx.from.id));
  const ownerCmdBot = adminBot ?? bot;

  bot.command('paid_links', async (ctx) => {
    try {
      const rows = await listPaidFileLinks(pool, 30, scopeOwner(ctx));
      if (!rows.length) return ctx.reply('💰 No paid links yet.\n💡 Create one anytime with /plink.');
      const lines = rows.map((row) => `${row.is_enabled ? '🟢' : '⚪'} #${row.id} · ${row.public_code}\n📄 ${row.file_name} (${row.file_code})\n💵 ${formatMoney(row.price_minor, row.currency)} · 🧾 ${row.purchase_count} purchase(s)\n⏳ Expires: ${row.expires_at ? new Date(row.expires_at).toISOString() : 'Never'}`);
      await ctx.reply('💰 Paid File Links\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (error) { logger.error({ error: error.message }, 'Paid links list failed'); await ctx.reply('❌ Could not list paid links.'); }
  });

  ownerCmdBot.command('paid_requests', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return ctx.reply('🔒 This command is restricted to the platform owner.');
    try {
      const rows = await listPendingPaidFilePurchases(pool);
      if (!rows.length) return ctx.reply('✅ No pending paid file requests.');
      const lines = rows.map((r) => `⏳ Purchase #${r.purchase_id} · ${r.public_code}\n👤 User ID: ${r.user_telegram_id}\n📄 ${r.file_name} (${r.file_code})\n💵 ${formatMoney(r.paid_amount_minor, r.currency)}\n🕒 Requested: ${new Date(r.created_at).toISOString()}\n✅ Confirm: /admin paid_confirm ${r.public_code} ${r.user_telegram_id}`);
      await ctx.reply('⏳ Pending Paid File Requests\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (error) { logger.error({ error: error.message }, 'Paid requests listing failed'); await ctx.reply('❌ Could not list pending requests.'); }
  });

  bot.command('paid_link_disable', async (ctx) => {
    try {
      const code = getCommandArgs(ctx)[0];
      if (!code) return ctx.reply('ℹ️ Usage: /paid_link_disable <link_code>');
      const row = await disablePaidFileLink(pool, code, ctx.from.id, scopeOwner(ctx));
      await ctx.reply(row ? `⏸ Disabled paid link ${row.public_code}.` : '❌ Paid link not found.');
    } catch { await ctx.reply('❌ Link disable failed.'); }
  });

  bot.command('paid_link_delete', async (ctx) => {
    try {
      const idOrCode = getCommandArgs(ctx)[0];
      if (!idOrCode) return ctx.reply('ℹ️ Usage: /paid_link_delete <link_code_or_id>');
      const row = await deletePaidFileLink(pool, idOrCode, scopeOwner(ctx));
      await ctx.reply(row ? `🗑️ Deleted paid link ${row.public_code} (#${row.id}).` : '❌ Paid link not found.');
    } catch (error) { await ctx.reply('❌ Paid link deletion failed: ' + error.message); }
  });

  ownerCmdBot.command('paid_confirm', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return ctx.reply('🔒 This command is restricted to the platform owner.');
    const [code, userRaw] = getCommandArgs(ctx);
    try {
      if (!code || !userRaw) throw new Error('Usage: /admin paid_confirm <link_code> <user_id>');
      const userId = parseTelegramUserId(userRaw, 'User ID');
      const result = await confirmPaidFilePurchase(pool, code, userId, ctx.from.id);
      await ctx.reply(result.alreadyConfirmed ? 'ℹ️ Purchase was already confirmed.' : '✅ Purchase confirmed! Access grant recorded.');
      if (!result.alreadyConfirmed) {
        const link = await getPaidFileLink(pool, code);
        try {
          await ctx.telegram.sendMessage(
            userId,
            `🎉 Payment Verified!\n━━━━━━━━━━━━━━━━━━\n🔓 Paid access is unlocked for:\n📄 ${link?.file_name ?? 'your file'}\n\n👇 Request delivery anytime:\n/get ${link?.file_code ?? ''}`,
          );
        }
        catch (notifyError) { logger.warn({ userId, error: notifyError.message }, 'Paid purchase confirmation notification failed'); }
      }
    } catch (error) { await ctx.reply('❌ Confirmation failed: ' + error.message); }
  });
}
