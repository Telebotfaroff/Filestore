// Creator-owned broadcast callback controller.
export function registerCreatorBroadcastActions(bot, context) {
  const { isOwnerAdmin, denyAdminOnly, safeAnswer, deliveryManager, pickCreatorBroadcastBot, pool, escapeHtml, renderView, listCreatorBroadcasts, clearShortenerDraft, shareLinksUi, paidLinksUi, walletUi, setPrompt, getCreatorBroadcast, setCreatorBroadcastStatus, retryCreatorBroadcast } = context;
  // Creator broadcast menu and history (creator-owned audience only)
  bot.action('cc:broadcast', async (ctx) => {
    if (isOwnerAdmin(ctx)) return safeAnswer(ctx, 'Creator broadcast is available from a creator account.', true);
    await safeAnswer(ctx);
    const ownerId = Number(ctx.from.id);
    const bots = await deliveryManager.list(ownerId);
    const active = bots.filter((b) => b.is_enabled && b.runtime_status === 'running');
    const selectedBot = pickCreatorBroadcastBot(bots);
    const history = await listCreatorBroadcasts(pool, ownerId, 5).catch(() => []);
    const audience = selectedBot
      ? await pool.query('SELECT COUNT(*)::int AS count FROM delivery_bot_user_activity WHERE delivery_bot_id = $1', [Number(selectedBot.id)])
      : { rows: [{ count: 0 }] };
    const botLine = selectedBot ? '🤖 Sending via: <b>@' + escapeHtml(selectedBot.username) + '</b> (' + active.length + ' active)' : '🤖 Active delivery bots: <b>0</b>';
    const msg = '📢 <b>Creator Broadcast</b>\n━━━━━━━━━━━━━━━━━━\n' + botLine + '\n👥 Tracked audience: <b>' + Number(audience.rows[0]?.count || 0) + '</b>\n\nSend a text or media announcement to users tracked by your delivery bot. Each broadcast runs in the background.';
    const kb = [];
    if (selectedBot) kb.push([{ text: '✉️ Compose Broadcast', callback_data: 'cc:broadcast_compose' }]);
    if (history.length) kb.push([{ text: '📋 Recent Broadcasts', callback_data: 'cc:broadcast_history' }]);
    kb.push([{ text: '↻ Refresh', callback_data: 'cc:broadcast' }, { text: '← Creator Hub', callback_data: 'cc:home' }]);
    return renderView(ctx, msg, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action('cc:broadcast_compose', async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const bots = await deliveryManager.list(Number(ctx.from.id));
    if (!pickCreatorBroadcastBot(bots)) { await safeAnswer(ctx, 'No active delivery bot is running.', true); return; }
    clearShortenerDraft(ctx.from.id);
    shareLinksUi.clearSession(ctx.from.id);
    paidLinksUi.clearSession(ctx.from.id);
    walletUi.clearSession(ctx.from.id);
    const cfg = setPrompt(ctx.from.id, 'creator_broadcast', { back: 'cc:broadcast' });
    await safeAnswer(ctx);
    return renderView(ctx, '✏️ <b>New Broadcast</b>\n━━━━━━━━━━━━━━━━━━\n' + escapeHtml(cfg.prompt), { inline_keyboard: [[{ text: '✖ Cancel', callback_data: 'cc:cancel_prompt' }]] }, true, true, { parse_mode: 'HTML' });
  });
  bot.action('cc:broadcast_history', async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    await safeAnswer(ctx);
    const rows = await listCreatorBroadcasts(pool, Number(ctx.from.id), 10);
    const statusIcon = { pending: '⏳', processing: '🚀', paused: '⏸', completed: '✅', cancelled: '🛑', failed: '⚠️' };
    const body = rows.length
      ? rows.map((r) => `${statusIcon[r.status] ?? '📋'} #${r.id} · ${escapeHtml(r.status)}\n👥 ${r.total_recipients} · 📤 ${r.sent_count} · ⚠️ ${r.failed_count}`).join('\n\n')
      : 'No broadcasts yet.';
    const kb = rows.map((r) => [{ text: 'Details #' + r.id + ' · ' + r.status, callback_data: 'cc:broadcast_detail:' + r.id }]);
    kb.push([{ text: '← Broadcast', callback_data: 'cc:broadcast' }, { text: 'Creator Hub', callback_data: 'cc:home' }]);
    return renderView(ctx, '📋 <b>Broadcast History</b>\n━━━━━━━━━━━━━━━━━━\n\n' + body, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action(/^cc:broadcast_detail:(\d+)$/, async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]), owner = Number(ctx.from.id);
    const b = await getCreatorBroadcast(pool, owner, id);
    if (!b) { await safeAnswer(ctx, 'Broadcast not found.', true); return; }
    await safeAnswer(ctx);
    const pct = b.total_recipients ? Math.floor(Number(b.sent_count) * 100 / Number(b.total_recipients)) : 0;
    const msg = '📋 <b>Broadcast #' + b.id + '</b>\n━━━━━━━━━━━━━━━━━━\nStatus: <b>' + escapeHtml(b.status) + '</b>\n👥 Total: ' + b.total_recipients + '\n📤 Sent: ' + b.sent_count + ' (' + pct + '%)\n⚠️ Failed: ' + b.failed_count + '\n⏳ Pending: ' + b.pending_count + '\n\n' + (b.last_error ? 'Last error: ' + escapeHtml(String(b.last_error).slice(0, 300)) : '');
    const kb = [];
    if (['processing', 'pending'].includes(b.status)) kb.push([{ text: '⏸ Pause', callback_data: 'cc:broadcast_manage:paused:' + id }]);
    if (b.status === 'paused') kb.push([{ text: '▶ Resume', callback_data: 'cc:broadcast_manage:pending:' + id }]);
    if (['processing', 'pending', 'paused'].includes(b.status)) kb.push([{ text: '🛑 Cancel', callback_data: 'cc:broadcast_manage:cancelled:' + id }]);
    if (['completed', 'failed', 'paused'].includes(b.status) && Number(b.failed_count) > 0) kb.push([{ text: '🔁 Retry Failed', callback_data: 'cc:broadcast_retry:' + id }]);
    kb.push([{ text: '↻ Refresh', callback_data: 'cc:broadcast_detail:' + id }, { text: '← History', callback_data: 'cc:broadcast_history' }]);
    return renderView(ctx, msg, { inline_keyboard: kb }, true, true, { parse_mode: 'HTML' });
  });
  bot.action(/^cc:broadcast_manage:(paused|pending|cancelled):(\d+)$/, async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const status = ctx.match[1], id = Number(ctx.match[2]), owner = Number(ctx.from.id);
    const changed = await setCreatorBroadcastStatus(pool, owner, id, status);
    await safeAnswer(ctx, changed ? 'Broadcast updated.' : 'Broadcast could not be updated.', !changed);
    return bot.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, { inline_keyboard: [[{ text: '↻ Refresh Details', callback_data: 'cc:broadcast_detail:' + id }], [{ text: '← History', callback_data: 'cc:broadcast_history' }]] }).catch(() => {});
  });
  bot.action(/^cc:broadcast_retry:(\d+)$/, async (ctx) => {
    if (isOwnerAdmin(ctx)) return denyAdminOnly(ctx);
    const id = Number(ctx.match[1]);
    try {
      const n = await retryCreatorBroadcast(pool, Number(ctx.from.id), id);
      await safeAnswer(ctx, 'Retry queued for ' + n + ' failed recipient(s).');
    } catch (e) {
      await safeAnswer(ctx, e.message || 'Retry failed.', true);
    }
    return renderView(ctx, '🔁 Retry requested for Broadcast #' + id, { inline_keyboard: [[{ text: '📋 Details', callback_data: 'cc:broadcast_detail:' + id }, { text: 'History', callback_data: 'cc:broadcast_history' }]] }, true, true);
  });
}
