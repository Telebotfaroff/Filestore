import { Telegraf } from 'telegraf';
import { isAdmin } from './admin-guard.js';
import { registerStorageAdminCommands } from '../storage/admin-commands.js';
import { registerFileIngestHandler } from '../storage/ingest-handler.js';
import { registerFileCommands } from '../storage/file-commands.js';
import { registerDeliveryBotManagerCommands } from '../delivery/admin-commands.js';
import { registerForceSubAdminCommands } from '../access/force-sub-admin-commands.js';
import { registerShortenerAdminCommands } from '../access/shortener-admin-commands.js';
import { registerCheckpointPolicyCommands } from '../access/checkpoint-admin-commands.js';
import { registerPremiumAdminCommands } from '../premium/admin-commands.js';
import { registerPaymentAdminCommands } from '../payments/admin-commands.js';
import { registerPaidFileAdminCommands } from '../paid-files/admin-commands.js';
import { registerPaidBatchAdminCommands } from '../paid-files/batch-admin-commands.js';
import { registerAutoDeleteCommands } from '../delivery/auto-delete-admin-commands.js';
import { registerDashboardCommands } from '../admin/dashboard-commands.js';

export function createMainBot(config, logger, pool) {
  const bot = new Telegraf(config.mainBotToken);
  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx.from?.id, config.adminIds)) {
      if (ctx.chat?.type === 'private') await ctx.reply('This bot is restricted to administrators.');
      return;
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'FileStore Control Center\n\n' +
      'Send supported media here to store and index it.\n\n' +
      'Storage: /storage · /storage_add\nFiles: /files · /find <query> · /fileinfo <code>\nDelivery bots: /delivery_bots\nForce-sub: /force_sub\nShorteners: /shorteners\nUse /help for all commands.'
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '/start — Admin welcome\n/status — Database status\n/storage — Storage channels\n/storage_add — Add channel\n/storage_test — Test channel permissions\n/storage_enable — Enable channel\n/storage_disable — Disable channel\n/storage_primary — Set primary storage\n/storage_remove — Remove/disable channel\n/files — List indexed files\n/find — Search files\n/fileinfo — File metadata\n/delivery_bots — List managed bots\n/delivery_bot_add — Add token\n/delivery_bot_pause — Pause worker\n/delivery_bot_resume — Resume bot\n/delivery_bot_restart — Restart runtime\n/delivery_bot_remove — Remove bot\n/delivery_bot_primary — Set primary\n/delivery_bot_priority — Set priority\n/delivery_bot_test — Test bot access\n/force_sub — List force-sub channels\n/force_sub_add — Add channel + join URL\n/force_sub_test — Test Main Bot permissions\n/force_sub_enable — Enable channel\n/force_sub_disable — Disable channel\n/force_sub_remove — Remove channel\n/force_sub_global_on — Enable force-sub globally\n/force_sub_global_off — Disable force-sub globally\n/shorteners — List providers\n/shortener_add — Add provider config\n/shortener_test — Test config\n/shortener_duration — Set checkpoint minutes\n/shortener_priority — Set provider priority\n/shortener_enable — Activation (currently blocked until verification adapters exist)\n/shortener_disable — Disable provider\n/shortener_remove — Remove provider\n/checkpoint_global_on — Enable checkpoints\n/checkpoint_global_off — Disable checkpoints\n/plans — List Premium plans\n/plan_add — Add/upsert plan\n/plan_edit — Edit plan\n/plan_remove — Delete plan\n/premium_grant — Grant Premium manually\n/premium_revoke — Revoke Premium\n/premium_status — Inspect user Premium\n/payment_methods — List payment methods\n/payment_set — Configure payment method (Stars example: telegram_stars||{\"stars_prices\":{\"premium\":{\"1\":120},\"paid_file\":{\"2\":25},\"paid_batch\":{\"1\":150}}})\n/payment_enable telegram_stars — Enable configured Stars checkout\n/payment_test — Config validation\n/payment_enable — Enable a supported gateway (Telegram Stars active; others blocked)\n/payment_apply — Apply verified transaction (retry-safe)\n/payments — Payment reconciliation dashboard\n/payment_recent — Latest payment transactions\n/payment_detail — Full payment transaction details\n/payment_analytics — Revenue, outcomes and Premium analytics (30 days)\n/payment_reconcile — Retry verified payment fulfillment\n/payment_disable — Disable method\n/paid_link_create — Create paid file link\n/paid_links — List paid links\n/paid_requests — Pending purchase requests\n/paid_link_disable — Disable paid link\n/paid_confirm — Confirm payment manually (admin)\n/batch_link_create — Create paid multi-file link\n/batch_links — List batch links\n/batch_requests — Pending batch purchase requests\n/batch_link_disable — Disable batch link\n/batch_confirm — Confirm batch purchase\n/auto_delete — Set/check delivery auto-delete timer\n/auto_delete_off — Disable auto-delete\n/dashboard — Admin statistics overview\n/stats — Alias for dashboard\n/help — Command list'
    );
  });

  bot.command('status', async (ctx) => {
    const results = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM users) AS tracked_users,
              (SELECT COUNT(*)::int FROM files WHERE status = $1) AS active_files,
              (SELECT COUNT(*)::int FROM premium_memberships WHERE status='active' AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())) AS premium_active,
              (SELECT COUNT(*)::int FROM payment_transactions WHERE status='applied') AS payments_applied,
              (SELECT COALESCE(jsonb_object_agg(currency, total_minor), '{}'::jsonb) FROM (SELECT currency, SUM(amount_minor)::bigint AS total_minor FROM payment_transactions WHERE status='applied' GROUP BY currency) revenue) AS revenue_by_currency`,
      ['active'],
    );
    const botInfo = await ctx.telegram.getMe();
    await ctx.reply(
      'FileStore Status\n\n' +
      'Main Bot: Connected (@' + botInfo.username + ')\n' +
      'Database: Connected\n' +
      'Tracked users: ' + results.rows[0].tracked_users + '\n' +
      'Indexed files: ' + results.rows[0].active_files + '\n' +
      'Premium active: ' + results.rows[0].premium_active + '\n' +
      'Payments applied: ' + results.rows[0].payments_applied + '\n' +
      'Recorded revenue: ' + (Object.entries(results.rows[0].revenue_by_currency ?? {}).map(([currency, minor]) => currency + ' ' + (Number(minor) / 100).toFixed(2)).join(' · ') || 'none')
    );
  });

  registerStorageAdminCommands(bot, pool, logger);
  registerFileCommands(bot, pool, logger);
  registerFileIngestHandler(bot, pool, logger);
  registerDeliveryBotManagerCommands(bot, config.deliveryManager, logger);
  registerForceSubAdminCommands(bot, pool, logger);
  registerShortenerAdminCommands(bot, pool, config, logger);
  registerCheckpointPolicyCommands(bot, pool, logger);
  registerPremiumAdminCommands(bot, pool, logger);
  registerPaymentAdminCommands(bot, pool, config, logger);
  registerPaidFileAdminCommands(bot, pool, logger);
  registerPaidBatchAdminCommands(bot, pool, logger);
  registerAutoDeleteCommands(bot, pool, logger);
  registerDashboardCommands(bot, pool, logger);

  bot.catch((error, ctx) => {
    logger.error({ updateId: ctx.update?.update_id, error: error.message }, 'Telegram handler error');
  });
  return bot;
}
