import { Telegraf } from 'telegraf';
import { isAdmin } from './admin-guard.js';
import { createAdminCommandRouter } from './admin-router.js';
import { escapeHtml } from './telegram-utils.js';
import { registerControlCenter } from './control-center.js';
import { upsertTelegramUser } from '../access/user-repository.js';
import { formatRevenueSummary } from '../utils/validation.js';
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
import { handleStarsPreCheckout, handleStarsSuccessfulPayment } from '../payments/telegram-stars.js';

export const MAIN_BOT_MENU_COMMANDS = Object.freeze([
  { command: 'start', description: 'Open FileStore Hub & main menu' },
  { command: 'me', description: 'View balance, earnings & withdraw UPI' },
  { command: 'guide', description: 'Step-by-step user guide & tutorial' },
  { command: 'help', description: 'Quick help & command guide' },
]);

export function createMainBot(config, logger, pool) {
  const bot = new Telegraf(config.mainBotToken);
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type && ctx.chat.type !== 'private' && !isAdmin(ctx.from?.id, config.adminIds)) {
      return;
    }
    if (ctx.from?.id) {
      try {
        await upsertTelegramUser(pool, ctx.from);
      } catch (error) {
        logger?.warn?.({ userId: ctx.from.id, error: error.message }, 'Main Bot user upsert failed');
      }
    }
    return next();
  });

  let controlCenter;
  const adminRouter = createAdminCommandRouter(bot, config, logger, {
    onAdminHome: (ctx) => controlCenter.showHome(ctx, false),
    clearOtherSessions: (userId) => controlCenter?.clearAllSessions?.(userId),
  });

  controlCenter = registerControlCenter(bot, config, logger, pool, {
    adminBot: adminRouter.adminBot,
    onClearAdminPrompt: (userId) => adminRouter.clearPrompt(userId),
    hasActiveAdminPrompt: (userId) => Boolean(adminRouter.getActivePrompt(userId)),
  });

  adminRouter.adminBot.command('status', async (ctx) => {
    const results = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM users) AS tracked_users,
              (SELECT COUNT(*)::int FROM files WHERE status = $1) AS active_files,
              (SELECT COUNT(*)::int FROM premium_memberships WHERE status='active' AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at > NOW())) AS premium_active,
              (SELECT COUNT(*)::int FROM payment_transactions WHERE status='applied') AS payments_applied,
              (SELECT COALESCE(jsonb_object_agg(currency, total_minor), '{}'::jsonb) FROM (SELECT currency, SUM(amount_minor)::bigint AS total_minor FROM payment_transactions WHERE status='applied' GROUP BY currency) revenue) AS revenue_by_currency`,
      ['active'],
    );
    const botInfo = ctx.botInfo ?? await ctx.telegram.getMe();
    const row = results.rows[0];
    await ctx.reply(
      [
        '📡 <b>FileStore Live Status</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `🤖 <b>Main Bot:</b> 🟢 Connected (<code>@${escapeHtml(botInfo.username)}</code>)`,
        '🗄 <b>Database:</b> 🟢 Connected',
        '',
        `👥 <b>Tracked Users:</b> <code>${row.tracked_users}</code>`,
        `📁 <b>Indexed Files:</b> <code>${row.active_files}</code>`,
        `💎 <b>Active Premium:</b> <code>${row.premium_active}</code>`,
        `💳 <b>Applied Payments:</b> <code>${row.payments_applied}</code>`,
        `💰 <b>Recorded Revenue:</b> <code>${escapeHtml(formatRevenueSummary(row.revenue_by_currency))}</code>`,
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎛 Control Center', callback_data: 'cc:home' },
            { text: '🩺 Health', callback_data: 'cc:health' },
          ]],
        },
      },
    );
  });

  registerStorageAdminCommands(bot, pool, logger, config);
  registerFileCommands(bot, pool, logger, config);
  registerFileIngestHandler(bot, pool, logger);
  registerDeliveryBotManagerCommands(bot, config.deliveryManager, logger, pool, config, adminRouter.adminBot);
  registerForceSubAdminCommands(bot, pool, logger, config);
  registerShortenerAdminCommands(bot, pool, config, logger);
  registerCheckpointPolicyCommands(bot, pool, logger, config);
  registerPaidFileAdminCommands(bot, pool, logger, config, adminRouter.adminBot);
  registerPaidBatchAdminCommands(bot, pool, logger, config, adminRouter.adminBot);

  registerPremiumAdminCommands(adminRouter.adminBot, pool, logger);
  registerPaymentAdminCommands(adminRouter.adminBot, pool, config, logger);
  registerAutoDeleteCommands(adminRouter.adminBot, pool, logger);
  registerDashboardCommands(adminRouter.adminBot, pool, logger, config);

  bot.on('pre_checkout_query', (ctx) => handleStarsPreCheckout(bot, pool, ctx, config.mainBotToken, logger));
  bot.on('message', async (ctx, next) => {
    if (ctx.message?.successful_payment) {
      await handleStarsSuccessfulPayment(pool, ctx, config.mainBotToken, logger, config.adminIds, bot.telegram);
      return;
    }
    return next();
  });

  adminRouter.registerPromptTextHandler();
  bot.adminRouter = adminRouter;

  bot.catch((error, ctx) => {
    logger.error({ updateId: ctx.update?.update_id, error: error.message }, 'Telegram handler error');
  });
  return bot;
}
