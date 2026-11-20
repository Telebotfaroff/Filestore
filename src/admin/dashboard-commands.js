import { getAdminDashboardStats, formatAdminDashboard } from './dashboard-repository.js';

export function registerDashboardCommands(bot, pool, logger) {
  async function show(ctx) {
    try {
      const stats = await getAdminDashboardStats(pool);
      await ctx.reply(formatAdminDashboard(stats));
    } catch (error) {
      logger.error({ error: error.message }, 'Dashboard stats query failed');
      await ctx.reply('Dashboard unavailable. Check migrations and database connection.');
    }
  }
  bot.command('dashboard', show);
  bot.command('stats', show);
}
