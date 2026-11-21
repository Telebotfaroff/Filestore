import { editPremiumPlan, getPremiumStatus, grantPremiumMembership, listPremiumPlans, removePremiumPlan, revokePremiumMembership, upsertPremiumPlan } from './repository.js';
import { getCommandArgs } from '../bot/telegram-utils.js';
import {
  parsePositiveInt,
  parseTelegramUserId,
  parseMinorAmount,
  parseCurrencyCode,
  formatMoney,
} from '../utils/validation.js';

function parsePlanFields(name, price, currency, days, enabled = true) {
  const normalizedName = String(name ?? '').trim();
  if (!normalizedName || normalizedName.length > 60) throw new Error('Plan name must be 1–60 characters.');
  const code = parseCurrencyCode(currency);
  const duration = Number(days);
  if (!Number.isInteger(duration) || duration < 1 || duration > 3650) throw new Error('Duration must be 1–3650 days.');
  return { name: normalizedName, priceMinor: parseMinorAmount(price, { allowZero: true }), currency: code, durationDays: duration, enabled: Boolean(enabled) };
}

export function registerPremiumAdminCommands(bot, pool, logger) {
  bot.command('plans', async (ctx) => {
    try {
      const rows = await listPremiumPlans(pool);
      if (!rows.length) return ctx.reply('💎 No Premium plans configured yet.\n💡 Add one with /admin plan_add.');
      const lines = rows.map((p) => `${p.is_enabled ? '🟢' : '⚪'} #${p.id} · ${p.name}\n💵 ${formatMoney(p.price_minor, p.currency)} · ⏳ ${p.duration_days} day(s)`);
      await ctx.reply('💎 Premium Plans\n━━━━━━━━━━━━━━━━━━\n' + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Premium plan listing failed');
      await ctx.reply('❌ Could not list Premium plans.');
    }
  });

  bot.command('plan_add', async (ctx) => {
    const raw = ctx.message?.text?.trim().replace(/^\/plan_add\s*/, '') ?? '';
    const fields = raw.split('|').map((v) => v.trim());
    if (fields.length !== 4) return ctx.reply('ℹ️ Usage: /admin plan_add name|price|currency|duration_days (example: Monthly|99|INR|30)');
    try {
      const input = parsePlanFields(fields[0], fields[1], fields[2], fields[3]);
      const row = await upsertPremiumPlan(pool, input, ctx.from.id);
      await ctx.reply(`✅ Plan Saved!\n━━━━━━━━━━━━━━━━━━\n🆔 ID: ${row.id}\n💎 Name: ${row.name}\n💵 Price: ${formatMoney(row.price_minor, row.currency)}\n⏳ Duration: ${row.duration_days} days\n⚡ Status: ${row.is_enabled ? '🟢 Enabled' : '⚪ Disabled'}`);
    } catch (error) { await ctx.reply('❌ Plan save failed: ' + error.message); }
  });

  bot.command('plan_edit', async (ctx) => {
    const fields = ctx.message?.text?.trim().replace(/^\/plan_edit\s*/, '').split('|').map((v) => v.trim()) ?? [];
    if (fields.length !== 6) return ctx.reply('ℹ️ Usage: /admin plan_edit id|name|price|currency|duration_days|enabled (true/false)');
    try {
      const id = parsePositiveInt(fields[0], 'Plan ID');
      if (!['true', 'false'].includes(fields[5].toLowerCase())) throw new Error('enabled must be true or false.');
      const input = parsePlanFields(fields[1], fields[2], fields[3], fields[4], fields[5].toLowerCase() === 'true');
      const row = await editPremiumPlan(pool, id, input);
      await ctx.reply(row ? `✅ Plan #${row.id} updated!` : '❌ Plan not found.');
    } catch (error) { await ctx.reply('❌ Plan edit failed: ' + error.message); }
  });

  bot.command('plan_remove', async (ctx) => {
    try {
      const id = parsePositiveInt(getCommandArgs(ctx)[0], 'Plan ID');
      const row = await removePremiumPlan(pool, id);
      await ctx.reply(row ? `🗑️ Plan ${row.name} deleted. Membership history is retained with the plan reference cleared.` : '❌ Plan not found.');
    } catch (error) { await ctx.reply('ℹ️ Usage: /admin plan_remove <plan_id>'); }
  });

  bot.command('premium_grant', async (ctx) => {
    const [userRaw, planRaw, daysRaw] = getCommandArgs(ctx);
    try {
      const userId = parseTelegramUserId(userRaw);
      const planId = parsePositiveInt(planRaw, 'Plan ID');
      const days = daysRaw === undefined ? null : Number(daysRaw);
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error('Override days must be 1–3650.');
      const result = await grantPremiumMembership(pool, userId, planId, days, ctx.from.id);
      if (result.permanent) return ctx.reply('💎 This user already has permanent Premium. No expiry was changed.');
      await ctx.reply(`✅ Premium Granted!\n━━━━━━━━━━━━━━━━━━\n👤 User: ${userId}\n💎 Plan: ${result.plan}\n⏳ Duration: ${result.days} days\n📅 Expiry: ${result.expiresAt.toISOString()}`);
    } catch (error) { await ctx.reply('❌ Premium grant failed: ' + error.message); }
  });

  bot.command('premium_revoke', async (ctx) => {
    try {
      const userId = parseTelegramUserId(getCommandArgs(ctx)[0]);
      const count = await revokePremiumMembership(pool, userId, ctx.from.id);
      await ctx.reply(count ? `🚫 Revoked ${count} active Premium membership(s) for user ${userId}.` : 'ℹ️ No active Premium membership found.');
    } catch (error) { await ctx.reply('ℹ️ Usage: /admin premium_revoke <user_id>'); }
  });

  bot.command('premium_status', async (ctx) => {
    try {
      const userId = parseTelegramUserId(getCommandArgs(ctx)[0]);
      const rows = await getPremiumStatus(pool, userId);
      if (!rows.length) return ctx.reply('ℹ️ No Premium membership records found.');
      const lines = rows.map((r) => `✨ Plan: ${r.plan_name ?? 'deleted plan'} · ${r.status}\n📅 Started: ${new Date(r.starts_at).toISOString()}\n⏳ Expires: ${r.expires_at ? new Date(r.expires_at).toISOString() : 'Never'}`);
      await ctx.reply(`💎 Premium Status · User ${userId}\n━━━━━━━━━━━━━━━━━━\n` + lines.join('\n\n'));
    } catch (error) { await ctx.reply('ℹ️ Usage: /admin premium_status <user_id>'); }
  });
}
