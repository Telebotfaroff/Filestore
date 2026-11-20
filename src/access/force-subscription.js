export function isTelegramMember(member) {
  if (!member) return false;
  if (['creator', 'administrator', 'member'].includes(member.status)) return true;
  return member.status === 'restricted' && member.is_member === true;
}

export async function checkForceSubscription(telegram, pool, userId) {
  const setting = await pool.query("SELECT value FROM app_settings WHERE key = 'force_sub_enabled' LIMIT 1");
  const enabled = setting.rowCount ? setting.rows[0].value === true : true;
  if (!enabled) return { enabled: false, passed: true, missing: [] };

  const result = await pool.query(
    'SELECT id, telegram_chat_id, title, username, join_url FROM force_sub_channels WHERE is_enabled = TRUE ORDER BY id ASC',
  );
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
