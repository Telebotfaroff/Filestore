export function registerCheckpointPolicyCommands(bot, pool, logger) {
  bot.command('checkpoint_global_on', async (ctx) => {
    try {
      const providers = await pool.query('SELECT id FROM shortener_providers WHERE is_enabled = TRUE');
      if (!providers.rowCount) return ctx.reply('Cannot enable checkpoints: no enabled providers.');
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ('checkpoint_enabled', 'true'::jsonb, $1)
         ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [ctx.from.id],
      );
      await ctx.reply('Checkpoint enforcement enabled.');
    } catch (error) {
      logger.error({ error: error.message }, 'Checkpoint global enable failed');
      await ctx.reply('Could not enable checkpoints.');
    }
  });
  bot.command('checkpoint_global_off', async (ctx) => {
    try {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ('checkpoint_enabled', 'false'::jsonb, $1)
         ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [ctx.from.id],
      );
      await ctx.reply('Checkpoint enforcement disabled. Force-subscription remains required.');
    } catch (error) {
      logger.error({ error: error.message }, 'Checkpoint global disable failed');
      await ctx.reply('Could not disable checkpoints.');
    }
  });
}
