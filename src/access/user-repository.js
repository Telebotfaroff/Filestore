export async function upsertTelegramUser(pool, user) {
  const existing = await pool.query('SELECT 1 FROM users WHERE telegram_id = $1 LIMIT 1', [user.id]);
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, language_code, started_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username,
       first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
       language_code = EXCLUDED.language_code, last_seen_at = NOW(), updated_at = NOW()`,
    [user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null, user.language_code ?? null],
  );
  if (!existing.rowCount) {
    await pool.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('user_started', $1, $1, $2::jsonb)`,
      [user.id, JSON.stringify({ username: user.username ?? null })],
    );
  }
}
