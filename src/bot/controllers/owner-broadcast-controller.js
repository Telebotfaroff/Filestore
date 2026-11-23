// Platform-owner broadcast campaign callback controller.
export function registerOwnerBroadcastActions(bot, context) {
  const { isOwnerAdmin, denyAdminOnly, safeAnswer, pool, renderView, listOwnerCreatedBroadcasts, escapeHtml, getCreatorBroadcast, setCreatorBroadcastStatus, retryCreatorBroadcast, deliveryManager, clearShortenerDraft, shareLinksUi, paidLinksUi, walletUi, setPrompt } = context;
  // Platform owner broadcast: select creator (or platform bot), then their delivery bot
  bot.action('cc:owner_broadcast', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await safeAnswer(ctx);
    const [creators, platformRes] = await Promise.all([
      pool.query(
        `SELECT d.owner_telegram_id,
                u.username,
                u.first_name,
                COUNT(DISTINCT d.id)::int AS bots,
                COALESCE(COUNT(DISTINCT a.telegram_user_id), 0)::int AS total_users
         FROM delivery_bots d
         LEFT JOIN users u ON u.telegram_id = d.owner_telegram_id
         LEFT JOIN delivery_bot_user_activity a ON a.delivery_bot_id = d.id
         WHERE d.owner_telegram_id IS NOT NULL AND d.is_enabled = TRUE
         GROUP BY d.owner_telegram_id, u.username, u.first_name
         ORDER BY total_users DESC, d.owner_telegram_id ASC`,
      ),
      pool.query(
        `SELECT COUNT(DISTINCT d.id)::int AS bots,
                COALESCE(COUNT(DISTINCT a.telegram_user_id), 0)::int AS total_users
         FROM delivery_bots d
         LEFT JOIN delivery_bot_user_activity a ON a.delivery_bot_id = d.id
         WHERE d.owner_telegram_id IS NULL AND d.is_enabled = TRUE`,
      ).catch(() => ({ rows: [{ bots: 0, total_users: 0 }] })),
    ]);
    const kb = creators.rows.map((c) => {
      const label = c.username
        ? `@${c.username}`
        : (c.first_name ? `${String(c.first_name).slice(0, 18)} (${c.owner_telegram_id})` : `Creator ${c.owner_telegram_id}`);
      return [{
        text: `👤 ${label} · ${c.bots} bot · ${c.total_users} users`,
        callback_data: 'cc:owner_broadcast:creator:' + c.owner_telegram_id,
      }];
    });
    const platformBots = Number(platformRes.rows[0]?.bots || 0);
    if (platformBots > 0) {
      kb.push([{
        text: `🌐 Platform Bots · ${platformBots} bot · ${Number(platformRes.rows[0]?.total_users || 0)} users`,
        callback_data: 'cc:owner_broadcast:platform',
      }]);
    }
    kb.push([{ text: '📋 My Campaign History', callback_data: 'cc:owner_broadcast_history' }]);
    kb.push([{ text: '← Main Menu', callback_data: 'cc:home' }]);
    const intro = kb.length <= 2
      ? '👑 <b>Owner Broadcast</b>\n━━━━━━━━━━━━━━━━━━\n<i>No enabled creator or platform delivery bots found yet.</i>'
      : '👑 <b>Owner Broadcast</b>\n━━━━━━━━━━━━━━━━━━\nChoose a creator (or platform bot) to broadcast on their behalf. Audience is scoped to the chosen delivery bot.';
    return renderView(ctx, intro, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action('cc:owner_broadcast_history', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await safeAnswer(ctx);
    const rows = await listOwnerCreatedBroadcasts(pool, ctx.from.id, 15);
    const icons = { pending: '⏳', processing: '🚀', paused: '⏸', completed: '✅', cancelled: '🛑', failed: '⚠️' };
    const body = rows.length
      ? rows.map((r) => `${icons[r.status] ?? '📋'} #${r.id} · ${r.bot_username ? '@' + escapeHtml(r.bot_username) : 'Bot #' + r.delivery_bot_id} · Creator ${r.owner_telegram_id} · <b>${escapeHtml(r.status)}</b>\n👥 ${r.total_recipients} · 📤 ${r.sent_count} · ⚠️ ${r.failed_count}`).join('\n\n')
      : 'No owner-created campaigns yet.';
    const kb = rows.slice(0, 8).map((r) => [{
      text: `📋 #${r.id} · ${r.bot_username ? '@' + r.bot_username : 'Bot #' + r.delivery_bot_id} · ${r.status}`,
      callback_data: 'cc:owner_broadcast_detail:' + r.id,
    }]);
    kb.push([{ text: '← Owner Broadcast', callback_data: 'cc:owner_broadcast' }, { text: 'Main Menu', callback_data: 'cc:home' }]);
    return renderView(ctx, '📋 <b>Owner Campaign History</b>\n━━━━━━━━━━━━━━━━━━\n\n' + body, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action(/^cc:owner_broadcast_detail:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    const b = await getCreatorBroadcast(pool, null, id);
    if (!b) return safeAnswer(ctx, 'Broadcast not found.', true);
    await safeAnswer(ctx);
    const pct = b.total_recipients ? Math.floor(Number(b.sent_count) * 100 / Number(b.total_recipients)) : 0;
    const msg = `📋 <b>Broadcast #${b.id}</b>\n━━━━━━━━━━━━━━━━━━\n🤖 Bot: <b>${b.bot_username ? '@' + escapeHtml(b.bot_username) : 'Bot #' + b.delivery_bot_id}</b>\n👤 Creator ID: <code>${b.owner_telegram_id}</code>\nStatus: <b>${escapeHtml(b.status)}</b>\n👥 Total: ${b.total_recipients}\n📤 Sent: ${b.sent_count} (${pct}%)\n⚠️ Failed: ${b.failed_count}\n⏳ Pending: ${b.pending_count}` + (b.last_error ? `\n\nLast error: ${escapeHtml(String(b.last_error).slice(0, 300))}` : '');
    const kb = [];
    if (['processing', 'pending'].includes(b.status)) kb.push([{ text: '⏸ Pause', callback_data: 'cc:owner_broadcast_manage:paused:' + id }]);
    if (b.status === 'paused') kb.push([{ text: '▶ Resume', callback_data: 'cc:owner_broadcast_manage:pending:' + id }]);
    if (['processing', 'pending', 'paused'].includes(b.status)) kb.push([{ text: '🛑 Cancel', callback_data: 'cc:owner_broadcast_manage:cancelled:' + id }]);
    if (['completed', 'failed', 'paused'].includes(b.status) && Number(b.failed_count) > 0) kb.push([{ text: '🔁 Retry Failed', callback_data: 'cc:owner_broadcast_retry:' + id }]);
    kb.push([{ text: '↻ Refresh', callback_data: 'cc:owner_broadcast_detail:' + id }, { text: '← History', callback_data: 'cc:owner_broadcast_history' }]);
    return renderView(ctx, msg, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action(/^cc:owner_broadcast_manage:(paused|pending|cancelled):(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const status = ctx.match[1], id = Number(ctx.match[2]);
    const changed = await setCreatorBroadcastStatus(pool, null, id, status);
    await safeAnswer(ctx, changed ? 'Broadcast updated.' : 'Broadcast could not be updated.', !changed);
    return bot.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, {
      inline_keyboard: [[{ text: '↻ Refresh Details', callback_data: 'cc:owner_broadcast_detail:' + id }], [{ text: '← History', callback_data: 'cc:owner_broadcast_history' }]],
    }).catch(() => {});
  });
  bot.action(/^cc:owner_broadcast_retry:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    try {
      const n = await retryCreatorBroadcast(pool, null, id);
      await safeAnswer(ctx, 'Retry queued for ' + n + ' failed recipient(s).');
    } catch (e) {
      await safeAnswer(ctx, e.message || 'Retry failed.', true);
    }
    return renderView(ctx, '🔁 Retry requested for Broadcast #' + id, { inline_keyboard: [[{ text: '📋 Details', callback_data: 'cc:owner_broadcast_detail:' + id }, { text: 'History', callback_data: 'cc:owner_broadcast_history' }]] }, true, true);
  });
  bot.action('cc:owner_broadcast:platform', async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await safeAnswer(ctx);
    const bots = await deliveryManager.list(null);
    const kb = [];
    for (const b of bots.filter((b) => b.is_enabled)) {
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM delivery_bot_user_activity WHERE delivery_bot_id=$1', [b.id]);
      const statusDot = b.runtime_status === 'running' ? '🟢' : '⚠️';
      kb.push([{
        text: `${statusDot} @${b.username} · ${Number(count.rows[0]?.count || 0)} users`,
        callback_data: 'cc:owner_broadcast:bot:0:' + b.id,
      }]);
    }
    kb.push([{ text: '← Back', callback_data: 'cc:owner_broadcast' }]);
    const msg = kb.length <= 1
      ? '🌐 <b>Platform Delivery Bots</b>\nNo enabled platform delivery bots found.'
      : '🌐 <b>Platform Delivery Bots</b>\nSelect a delivery bot to broadcast to its tracked subscribers.';
    return renderView(ctx, msg, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action(/^cc:owner_broadcast:creator:(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const creatorId = Number(ctx.match[1]);
    await safeAnswer(ctx);
    const bots = await deliveryManager.list(creatorId);
    const kb = [];
    for (const b of bots.filter((b) => b.is_enabled)) {
      const count = await pool.query('SELECT COUNT(*)::int AS count FROM delivery_bot_user_activity WHERE delivery_bot_id=$1', [b.id]);
      const statusDot = b.runtime_status === 'running' ? '🟢' : '⚠️';
      kb.push([{
        text: `${statusDot} @${b.username} · ${Number(count.rows[0]?.count || 0)} users`,
        callback_data: 'cc:owner_broadcast:bot:' + creatorId + ':' + b.id,
      }]);
    }
    kb.push([{ text: '← Creators', callback_data: 'cc:owner_broadcast' }]);
    const msg = kb.length <= 1
      ? `👑 <b>Broadcast for Creator ${creatorId}</b>\nNo enabled delivery bots found for this creator.`
      : `👑 <b>Broadcast for Creator ${creatorId}</b>\nSelect their delivery bot to message its tracked audience.`;
    return renderView(ctx, msg, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action(/^cc:owner_broadcast:bot:(\d+):(\d+)$/, async (ctx) => {
    if (!isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const creatorId = Number(ctx.match[1]), botId = Number(ctx.match[2]);
    const isPlatformBot = creatorId === 0;
    const bots = await deliveryManager.list(isPlatformBot ? null : creatorId);
    const selected = bots.find((b) => Number(b.id) === botId && b.is_enabled);
    if (!selected) { await safeAnswer(ctx, 'Selected delivery bot is disabled or not found.', true); return; }
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM delivery_bot_user_activity WHERE delivery_bot_id=$1', [botId]);
    const audienceCount = Number(count.rows[0]?.count || 0);
    if (audienceCount === 0) {
      await safeAnswer(ctx, 'No tracked users on @' + selected.username + ' yet.', true);
      return;
    }
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    setPrompt(ctx.from.id, 'owner_broadcast', {
      back: isPlatformBot ? 'cc:owner_broadcast:platform' : 'cc:owner_broadcast:creator:' + creatorId,
      meta: { creatorId: isPlatformBot ? Number(ctx.from.id) : creatorId, botId, allowPlatformBot: isPlatformBot },
    });
    await safeAnswer(ctx);
    const titleLine = isPlatformBot
      ? '✏️ <b>Broadcast via Platform Bot</b>'
      : `✏️ <b>Broadcast on behalf of Creator ${creatorId}</b>`;
    return renderView(
      ctx,
      titleLine + '\n━━━━━━━━━━━━━━━━━━\n🤖 @' + escapeHtml(selected.username) + '\n👥 Audience: ' + audienceCount + '\n\nSend text, or attach a photo, video, document, or GIF with an optional caption. Add URL buttons on separate lines:\n<code>Button: Label | https://example.com</code>',
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] },
      true,
      true,
      { parse_mode: 'HTML' },
    );
  });
}
