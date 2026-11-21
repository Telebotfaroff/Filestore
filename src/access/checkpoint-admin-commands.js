import { isAdmin } from '../bot/admin-guard.js';
import { setCreatorCheckpointEnabled } from '../wallet/repository.js';

export function registerCheckpointPolicyCommands(bot, pool, logger, config = null) {
  bot.command('checkpoint_global_on', async (ctx) => {
    try {
      const isOwnerAdmin = !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
      if (!isOwnerAdmin) {
        const creatorId = Number(ctx.from.id);
        const providers = await pool.query(
          'SELECT id FROM shortener_providers WHERE is_enabled = TRUE AND owner_telegram_id = $1',
          [creatorId],
        );
        if (!providers.rowCount) return ctx.reply('⚠️ Cannot enable checkpoints: add and enable at least one shortener first.');
        await setCreatorCheckpointEnabled(pool, creatorId, true);
        return ctx.reply('🟢 Shortener checkpoint enforcement enabled for your links!');
      }

      const providers = await pool.query('SELECT id FROM shortener_providers WHERE is_enabled = TRUE AND owner_telegram_id IS NULL');
      if (!providers.rowCount) return ctx.reply('⚠️ Cannot enable checkpoints: no enabled providers.');
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ('checkpoint_enabled', 'true'::jsonb, $1)
         ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [ctx.from.id],
      );
      await ctx.reply('🟢 Checkpoint enforcement enabled!');
    } catch (error) {
      logger.error({ error: error.message }, 'Checkpoint global enable failed');
      await ctx.reply('❌ Could not enable checkpoints.');
    }
  });
  bot.command('checkpoint_global_off', async (ctx) => {
    try {
      const isOwnerAdmin = !Array.isArray(config?.adminIds) || isAdmin(ctx.from?.id, config.adminIds);
      if (!isOwnerAdmin) {
        await setCreatorCheckpointEnabled(pool, Number(ctx.from.id), false);
        return ctx.reply('⚪ Shortener checkpoint enforcement disabled for your links.');
      }

      await pool.query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ('checkpoint_enabled', 'false'::jsonb, $1)
         ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [ctx.from.id],
      );
      await ctx.reply('⚪ Checkpoint enforcement disabled. Force-subscription remains required.');
    } catch (error) {
      logger.error({ error: error.message }, 'Checkpoint global disable failed');
      await ctx.reply('❌ Could not disable checkpoints.');
    }
  });
}

