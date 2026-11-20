import { editPremiumPlan, getPremiumStatus, grantPremiumMembership, listPremiumPlans, removePremiumPlan, revokePremiumMembership, upsertPremiumPlan } from './repository.js';

function args(ctx) { return ctx.message?.text?.trim().split(/\s+/).slice(1) ?? []; }
function parseUserId(value) {
  if (!/^\d{1,20}$/.test(String(value ?? ''))) throw new Error('Telegram user ID must be numeric.');
  const id = BigInt(value);
  if (id <= 0n || id > 9223372036854775807n) throw new Error('Telegram user ID out of range.');
  return id.toString();
}
function parsePlanId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Plan ID must be a positive integer.');
  return id;
}
function parsePrice(value) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(String(value ?? ''))) throw new Error('Price must be a number with up to 2 decimal places.');
  const minor = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(minor)) throw new Error('Price is too large.');
  return minor;
}
function parsePlanFields(name, price, currency, days, enabled = true) {
  const normalizedName = String(name ?? '').trim();
  if (!normalizedName || normalizedName.length > 60) throw new Error('Plan name must be 1–60 characters.');
  const code = String(currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('Currency must be a 3-letter code.');
  const duration = Number(days);
  if (!Number.isInteger(duration) || duration < 1 || duration > 3650) throw new Error('Duration must be 1–3650 days.');
  return { name: normalizedName, priceMinor: parsePrice(price), currency: code, durationDays: duration, enabled: Boolean(enabled) };
}

export function registerPremiumAdminCommands(bot, pool, logger) {
  bot.command('plans', async (ctx) => {
    try {
      const rows = await listPremiumPlans(pool);
      if (!rows.length) return ctx.reply('No Premium plans configured. Add one with /plan_add.');
      const lines = rows.map((p) => `#${p.id} · ${p.name} · ${p.is_enabled ? 'ON' : 'OFF'}\nPrice: ${(Number(p.price_minor) / 100).toFixed(2)} ${p.currency}\nDuration: ${p.duration_days} days`);
      await ctx.reply('Premium Plans\n\n' + lines.join('\n\n'));
    } catch (error) {
      logger.error({ error: error.message }, 'Premium plan listing failed');
      await ctx.reply('Could not list Premium plans.');
    }
  });

  bot.command('plan_add', async (ctx) => {
    const raw = ctx.message?.text?.trim().replace(/^\/plan_add\s*/, '') ?? '';
    const fields = raw.split('|').map((v) => v.trim());
    if (fields.length !== 4) return ctx.reply('Usage: /plan_add name|price|currency|duration_days (example: Monthly|99|INR|30)');
    try {
      const input = parsePlanFields(fields[0], fields[1], fields[2], fields[3]);
      const row = await upsertPremiumPlan(pool, input, ctx.from.id);
      await ctx.reply(`Plan saved.\nID: ${row.id}\nName: ${row.name}\nPrice: ${(Number(row.price_minor) / 100).toFixed(2)} ${row.currency}\nDuration: ${row.duration_days} days\nStatus: ${row.is_enabled ? 'Enabled' : 'Disabled'}`);
    } catch (error) { await ctx.reply('Plan save failed: ' + error.message); }
  });

  bot.command('plan_edit', async (ctx) => {
    const fields = ctx.message?.text?.trim().replace(/^\/plan_edit\s*/, '').split('|').map((v) => v.trim()) ?? [];
    if (fields.length !== 6) return ctx.reply('Usage: /plan_edit id|name|price|currency|duration_days|enabled (true/false)');
    try {
      const id = parsePlanId(fields[0]);
      if (!['true', 'false'].includes(fields[5].toLowerCase())) throw new Error('enabled must be true or false.');
      const input = parsePlanFields(fields[1], fields[2], fields[3], fields[4], fields[5].toLowerCase() === 'true');
      const row = await editPremiumPlan(pool, id, input);
      await ctx.reply(row ? `Plan #${row.id} updated.` : 'Plan not found.');
    } catch (error) { await ctx.reply('Plan edit failed: ' + error.message); }
  });

  bot.command('plan_remove', async (ctx) => {
    try {
      const id = parsePlanId(args(ctx)[0]);
      const row = await removePremiumPlan(pool, id);
      await ctx.reply(row ? `Plan ${row.name} deleted. Membership history is retained with the plan reference cleared.` : 'Plan not found.');
    } catch (error) { await ctx.reply('Usage: /plan_remove <plan_id>'); }
  });

  bot.command('premium_grant', async (ctx) => {
    const [userRaw, planRaw, daysRaw] = args(ctx);
    try {
      const userId = parseUserId(userRaw);
      const planId = parsePlanId(planRaw);
      const days = daysRaw === undefined ? null : Number(daysRaw);
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error('Override days must be 1–3650.');
      const result = await grantPremiumMembership(pool, userId, planId, days, ctx.from.id);
      if (result.permanent) return ctx.reply('This user already has permanent Premium. No expiry was changed.');
      await ctx.reply(`Premium granted.\nUser: ${userId}\nPlan: ${result.plan}\nDuration: ${result.days} days\nExpiry: ${result.expiresAt.toISOString()}`);
    } catch (error) { await ctx.reply('Premium grant failed: ' + error.message); }
  });

  bot.command('premium_revoke', async (ctx) => {
    try {
      const userId = parseUserId(args(ctx)[0]);
      const count = await revokePremiumMembership(pool, userId, ctx.from.id);
      await ctx.reply(count ? `Revoked ${count} active Premium membership(s) for ${userId}.` : 'No active Premium membership found.');
    } catch (error) { await ctx.reply('Usage: /premium_revoke <user_id>'); }
  });

  bot.command('premium_status', async (ctx) => {
    try {
      const userId = parseUserId(args(ctx)[0]);
      const rows = await getPremiumStatus(pool, userId);
      if (!rows.length) return ctx.reply('No Premium membership records found.');
      const lines = rows.map((r) => `Plan: ${r.plan_name ?? 'deleted plan'} · ${r.status}\nStarted: ${new Date(r.starts_at).toISOString()}\nExpires: ${r.expires_at ? new Date(r.expires_at).toISOString() : 'Never'}`);
      await ctx.reply('Premium status for ' + userId + '\n\n' + lines.join('\n\n'));
    } catch (error) { await ctx.reply('Usage: /premium_status <user_id>'); }
  });
}
