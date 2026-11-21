export function isTelegramMember(member) {
  if (!member) return false;
  if (['creator', 'administrator', 'member'].includes(member.status)) return true;
  return member.status === 'restricted' && member.is_member === true;
}

export async function checkForceSubscription(telegram, pool, userId, ownerId = null) {
  let enabled;
  let result;
  if (ownerId !== null && ownerId !== undefined) {
    const setting = await pool.query(
      'SELECT force_sub_enabled FROM user_creator_settings WHERE user_telegram_id = $1 LIMIT 1',
      [Number(ownerId)],
    );
    enabled = setting.rowCount ? setting.rows[0].force_sub_enabled === true : false;
    if (!enabled) return { enabled: false, passed: true, missing: [] };

    result = await pool.query(
      'SELECT id, telegram_chat_id, title, username, join_url FROM force_sub_channels WHERE is_enabled = TRUE AND owner_telegram_id = $1 ORDER BY id ASC',
      [Number(ownerId)],
    );
  } else {
    const setting = await pool.query("SELECT value FROM app_settings WHERE key = 'force_sub_enabled' LIMIT 1");
    enabled = setting.rowCount ? setting.rows[0].value === true : true;
    if (!enabled) return { enabled: false, passed: true, missing: [] };

    result = await pool.query(
      'SELECT id, telegram_chat_id, title, username, join_url FROM force_sub_channels WHERE is_enabled = TRUE AND owner_telegram_id IS NULL ORDER BY id ASC',
    );
  }

  const missing = [];
  for (const channel of result.rows) {
    try {
      const member = await telegram.getChatMember(channel.telegram_chat_id, userId);
      if (!isTelegramMember(member)) missing.push({ ...channel, checkStatus: 'missing' });
    } catch (error) {
      // Fail closed when membership cannot be checked.
      missing.push({ ...channel, checkStatus: 'check_failed' });
    }
  }
  return { enabled: true, passed: missing.length === 0, missing };
}
