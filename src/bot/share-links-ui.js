import { ingestTelegramMedia } from '../storage/ingest-handler.js';
import { getIndexedFile, listRecentFiles, formatFileSize } from '../storage/file-query.js';
import { escapeHtml, renderView, safeAnswer } from './telegram-utils.js';
import {
  MAX_SHARE_BATCH_ITEMS,
  getShareableBotUsername,
  buildShareableUrl,
  createSingleShareLink,
  createBatchShareLink,
  getShareLinkById,
  listShareLinks,
  renameShareLink,
  renameIndexedFile,
  addItemToShareLink,
  removeItemFromShareLink,
  updateShareLinkItems,
  setShareLinkEnabled,
  deleteShareLink,
} from '../storage/share-links-repository.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const LINKS_PAGE_SIZE = 6;
const HTML = { parse_mode: 'HTML' };

function parseCodesList(rawText) {
  return String(rawText ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function registerShareLinksUi(bot, logger, pool, hooks = {}) {
  const sessions = new Map();
  const userQueues = new Map();

  function enqueueUserWork(userId, fn) {
    const key = String(userId);
    const prev = userQueues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    userQueues.set(key, next);
    next.finally(() => {
      if (userQueues.get(key) === next) userQueues.delete(key);
    });
    return next;
  }

  function getSession(userId) {
    const key = String(userId);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    return session;
  }

  function setSession(userId, data) {
    const key = String(userId);
    const session = { ...data, expiresAt: Date.now() + SESSION_TTL_MS };
    sessions.set(key, session);
    return session;
  }

  function clearSession(userId) {
    sessions.delete(String(userId));
  }

  function resolveOwnerScope(ctx) {
    const adminIds = hooks.config?.adminIds;
    const isOwnerAdmin = !Array.isArray(adminIds) || adminIds.includes(Number(ctx.from?.id));
    return isOwnerAdmin ? null : Number(ctx.from?.id);
  }

  async function showShareLinkDetail(ctx, linkId, edit = false, confirmDelete = false) {
    const ownerScope = resolveOwnerScope(ctx);
    const [link, botUsername] = await Promise.all([
      getShareLinkById(pool, linkId, ownerScope),
      getShareableBotUsername(pool, ownerScope),
    ]);
    if (!link) return showShareLinks(ctx, 0, edit);

    const shareUrl = buildShareableUrl(botUsername, link.link_code);
    const isBatch = link.link_type === 'batch' || link.items.length > 1;
    const header = isBatch
      ? `📚 <b>Batch Share Link (${link.items.length}/${MAX_SHARE_BATCH_ITEMS} items)</b>`
      : '🔗 <b>Single Media Share Link</b>';

    const itemLines = link.items.length
      ? link.items.map((item, idx) => `${idx + 1}. 📄 ${escapeHtml(String(item.file_name).slice(0, 70))} (<code>${escapeHtml(item.file_code)}</code>)`).join('\n')
      : '<i>No items attached.</i>';

    const lines = [
      header,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 <b>Title: ${escapeHtml(link.title)}</b>`,
      `🔑 <b>Link Code:</b> <code>${escapeHtml(link.link_code)}</code>`,
      `📌 <b>Status:</b> ${link.is_enabled ? '🟢 Enabled' : '⏸ Disabled'}`,
      '',
      shareUrl
        ? `🌐 <b>Generated Link:</b>\n<code>${escapeHtml(shareUrl)}</code>`
        : `⚡ <b>Deep-link payload:</b> <code>/start ${escapeHtml(link.link_code)}</code>\n<i>💡 Add an enabled Delivery Bot in Control Center to get a clickable https://t.me/... link.</i>`,
      '',
      isBatch ? '📦 <b>Batch Files:</b>' : '📄 <b>Linked File:</b>',
      itemLines,
    ];

    const keyboard = [];
    if (shareUrl) {
      keyboard.push([{ text: '🔗 Open Generated Link', url: shareUrl }]);
    }

    if (isBatch) {
      keyboard.push([
        { text: '✏ Rename Batch', callback_data: `cc:lnk_ren:${link.id}` },
        { text: `📝 Edit Items (${link.items.length}/${MAX_SHARE_BATCH_ITEMS})`, callback_data: `cc:lnk_items:${link.id}` },
      ]);
    } else {
      const onlyFile = link.items[0];
      const editRow = [{ text: '✏ Rename Link', callback_data: `cc:lnk_ren:${link.id}` }];
      if (onlyFile) {
        editRow.push({ text: '✏ Rename File', callback_data: `cc:frename:${onlyFile.file_code}:${link.id}` });
      }
      keyboard.push(editRow);
      keyboard.push([
        { text: '📝 Edit / Convert to Batch', callback_data: `cc:lnk_items:${link.id}` },
      ]);
    }

    const actionRow = [
      link.is_enabled
        ? { text: '⏸ Disable', callback_data: `cc:lnk_tog:${link.id}` }
        : { text: '✅ Enable', callback_data: `cc:lnk_tog:${link.id}` },
    ];
    if (confirmDelete) {
      actionRow.push({ text: '⚠ Confirm Delete', callback_data: `cc:lnk_del_ok:${link.id}` });
      actionRow.push({ text: 'Cancel', callback_data: `cc:lnk:${link.id}` });
    } else {
      actionRow.push({ text: '🗑 Delete', callback_data: `cc:lnk_del:${link.id}` });
    }
    keyboard.push(actionRow);
    keyboard.push([
      { text: '📋 All Links', callback_data: 'cc:links:0' },
      { text: '🎛 Main Menu', callback_data: 'cc:home' },
    ]);

    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, HTML);
  }

  async function showShareLinks(ctx, page = 0, edit = false) {
    const safePage = Math.max(0, Number(page) || 0);
    const ownerScope = resolveOwnerScope(ctx);
    const [{ total, rows }, botUsername] = await Promise.all([
      listShareLinks(pool, { limit: LINKS_PAGE_SIZE, offset: safePage * LINKS_PAGE_SIZE, ownerId: ownerScope }),
      getShareableBotUsername(pool, ownerScope),
    ]);
    const pages = Math.max(1, Math.ceil(total / LINKS_PAGE_SIZE));
    const activePage = Math.min(safePage, pages - 1);
    const displayRows = activePage === safePage
      ? rows
      : (await listShareLinks(pool, { limit: LINKS_PAGE_SIZE, offset: activePage * LINKS_PAGE_SIZE, ownerId: ownerScope })).rows;

    const lines = displayRows.length
      ? displayRows.map((row, idx) => {
          const url = buildShareableUrl(botUsername, row.link_code) ?? `/start ${row.link_code}`;
          const kind = row.link_type === 'batch' ? `📚 Batch (${row.item_count}/${MAX_SHARE_BATCH_ITEMS})` : '🔗 Single';
          return `<b>${activePage * LINKS_PAGE_SIZE + idx + 1}.</b> ${row.is_enabled ? '🟢' : '⏸'} <b>${escapeHtml(String(row.title).slice(0, 70))}</b>\n${kind} · <code>${escapeHtml(row.link_code)}</code>\n<code>${escapeHtml(url)}</code>`;
        })
      : ['<i>✨ No shareable links generated yet.\n\nUse <code>/link</code> for a single media file or <code>/Batch</code> for up to 20 files.</i>'];

    const keyboard = displayRows.map((row) => [
      {
        text: `${row.is_enabled ? '🟢' : '⏸'} ${row.link_type === 'batch' ? '📚' : '🔗'} ${String(row.title).slice(0, 24)} (${row.link_code})`,
        callback_data: `cc:lnk:${row.id}`,
      },
      {
        text: '🗑',
        callback_data: `cc:lnk_del:${row.id}`,
      },
    ]);
    keyboard.push([
      { text: '➕ Single Link (/link)', callback_data: 'cc:cmd_link' },
      { text: '➕ Batch (/Batch)', callback_data: 'cc:cmd_batch' },
    ]);
    const nav = [];
    if (activePage > 0) nav.push({ text: '← Prev', callback_data: `cc:links:${activePage - 1}` });
    nav.push({ text: '↻ Refresh', callback_data: `cc:links:${activePage}` });
    if (activePage < pages - 1) nav.push({ text: 'Next →', callback_data: `cc:links:${activePage + 1}` });
    keyboard.push(nav);
    keyboard.push([{ text: '← Main Menu', callback_data: 'cc:home' }]);

    return renderView(
      ctx,
      `🔗 <b>Generated Share Links</b> · Page ${activePage + 1}/${pages} (<b>${total}</b> total)\n━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n\n')}`,
      { inline_keyboard: keyboard },
      edit,
      true,
      HTML,
    );
  }

  async function showShareLinkItemsEditor(ctx, linkId, edit = true) {
    const ownerScope = resolveOwnerScope(ctx);
    const link = await getShareLinkById(pool, linkId, ownerScope);
    if (!link) return showShareLinks(ctx, 0, edit);

    const itemLines = link.items.map((item, idx) =>
      `${idx + 1}. 📄 ${escapeHtml(String(item.file_name).slice(0, 60))} (<code>${escapeHtml(item.file_code)}</code>) · ${escapeHtml(formatFileSize(item.file_size))}`,
    );
    const text = [
      `📝 <b>Edit Link Items</b> · ${escapeHtml(link.title)}`,
      '━━━━━━━━━━━━━━━━━━',
      `🔑 <b>Code:</b> <code>${escapeHtml(link.link_code)}</code> · 📦 <b>Items:</b> ${link.items.length}/${MAX_SHARE_BATCH_ITEMS}`,
      '',
      ...itemLines,
      '',
      '💡 <i>Tap <b>Add Media / Code</b> to append items (max 20), or remove an item below:</i>',
    ].join('\n');

    const keyboard = [
      [
        { text: `➕ Add Media / Code (${link.items.length}/${MAX_SHARE_BATCH_ITEMS})`, callback_data: `cc:lnk_add:${link.id}` },
        { text: '✏ Replace All Codes', callback_data: `cc:lnk_rep:${link.id}` },
      ],
    ];

    if (link.items.length > 1) {
      for (let i = 0; i < link.items.length; i += 2) {
        const pair = link.items.slice(i, i + 2).map((item, offset) => ({
          text: `🗑 #${i + offset + 1} ${item.file_code}`,
          callback_data: `cc:lnk_rmi:${link.id}:${item.file_id}`,
        }));
        keyboard.push(pair);
      }
    }

    keyboard.push([
      { text: '← Back to Link', callback_data: `cc:lnk:${link.id}` },
      { text: '📋 All Links', callback_data: 'cc:links:0' },
    ]);

    return renderView(ctx, text, { inline_keyboard: keyboard }, edit, true, HTML);
  }

  function buildBatchCollectorKeyboard(session) {
    const count = session.items.length;
    const rows = [];
    if (count > 0) {
      rows.push([{ text: `✅ Generate Link (${count}/${MAX_SHARE_BATCH_ITEMS})`, callback_data: 'cc:b_done' }]);
    }
    const midRow = [{ text: '✏ Set / Rename Title', callback_data: 'cc:b_title' }];
    if (count > 0) midRow.push({ text: '↩ Undo Last', callback_data: 'cc:b_undo' });
    rows.push(midRow);
    rows.push([{ text: '✖ Cancel Batch', callback_data: 'cc:b_cancel' }]);
    return { inline_keyboard: rows };
  }

  function formatBatchCollectorText(session) {
    const count = session.items.length;
    const lines = [
      `📦 <b>Interactive Batch Link Builder (${count}/${MAX_SHARE_BATCH_ITEMS})</b>`,
      '━━━━━━━━━━━━━━━━━━',
      `🏷 <b>Title:</b> ${session.title ? escapeHtml(session.title) : '<i>(auto-generated when finished)</i>'}`,
      '',
      count
        ? session.items.map((item, i) => `${i + 1}. 📄 ${escapeHtml(String(item.file_name).slice(0, 60))} (<code>${escapeHtml(item.file_code)}</code>)`).join('\n')
        : '<i>📭 No media added yet.</i>',
      '',
      count >= MAX_SHARE_BATCH_ITEMS
        ? `🎉 Maximum limit of <b>${MAX_SHARE_BATCH_ITEMS}</b> media items reached! Tap <b>"✅ Generate Link"</b> or send <code>/done</code>.`
        : `📤 Send or forward media files (videos, docs, photos, audio) OR send file codes (comma/space separated) to add up to <b>${MAX_SHARE_BATCH_ITEMS}</b> items.\n\n✨ Tap <b>"✅ Generate Link"</b> or type <code>/done</code> when finished.`,
    ];
    return lines.join('\n');
  }

  async function startSingleLinkPrompt(ctx, edit = false, presetTitle = null) {
    hooks.clearPrompt?.(ctx.from.id);
    const ownerScope = resolveOwnerScope(ctx);
    setSession(ctx.from.id, { mode: 'link_single', title: presetTitle });
    const recent = await listRecentFiles(pool, 4, ownerScope).catch(() => []);
    const keyboard = recent.map((f) => [
      { text: `📄 ${f.file_code} · ${String(f.file_name).slice(0, 26)}`, callback_data: `cc:mklink:${f.file_code}` },
    ]);
    keyboard.push([{ text: '✖ Cancel', callback_data: 'cc:b_cancel' }]);
    const lines = [
      '🔗 <b>Create Single Media Share Link</b>',
      '━━━━━━━━━━━━━━━━━━',
      ...(presetTitle ? [`🏷 <b>Preset Title:</b> ${escapeHtml(presetTitle)}`] : []),
      '',
      '📤 Send or forward <b>ANY media file</b> (video, document, photo, audio, animation) here, OR enter an existing file code.',
      ...(recent.length ? ['', '⚡ <i>Or tap a recent indexed file below:</i>'] : []),
    ];
    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, HTML);
  }

  async function startBatchSession(ctx, edit = false, presetTitle = null) {
    hooks.clearPrompt?.(ctx.from.id);
    const session = setSession(ctx.from.id, {
      mode: 'batch_collect',
      title: presetTitle || null,
      awaitingTitle: false,
      items: [],
    });
    return renderView(ctx, formatBatchCollectorText(session), buildBatchCollectorKeyboard(session), edit, true, HTML);
  }

  async function finalizeBatchSession(ctx, edit = false) {
    const session = getSession(ctx.from.id);
    if (!session || session.mode !== 'batch_collect') {
      return renderView(ctx, '⚠️ No active <code>/Batch</code> session.', { inline_keyboard: [[{ text: '➕ Start /Batch', callback_data: 'cc:cmd_batch' }]] }, edit, true, HTML);
    }
    if (!session.items.length) {
      return renderView(ctx, '⚠️ Add at least <b>1 media file</b> or file code before generating the batch link.', buildBatchCollectorKeyboard(session), edit, true, HTML);
    }
    const ownerScope = resolveOwnerScope(ctx);
    const created = await createBatchShareLink(
      pool,
      session.items.map((item) => item.file_id),
      session.title,
      ctx.from.id,
      ownerScope,
    );
    clearSession(ctx.from.id);
    return showShareLinkDetail(ctx, created.id, edit);
  }

  // --- Commands ---
  async function handleLinkCommand(ctx) {
    hooks.clearPrompt?.(ctx.from.id);
    clearSession(ctx.from.id);
    const rawArgs = ctx.message?.text?.replace(/^\/\S+\s*/, '').trim() ?? '';
    if (!rawArgs) {
      return startSingleLinkPrompt(ctx, false, null);
    }
    try {
      const [codePart, titlePart] = rawArgs.split('|').map((s) => s.trim());
      if (!codePart) return startSingleLinkPrompt(ctx, false, titlePart || null);
      const created = await createSingleShareLink(pool, codePart.toUpperCase(), titlePart || null, ctx.from.id, resolveOwnerScope(ctx));
      return showShareLinkDetail(ctx, created.id, false);
    } catch (error) {
      return ctx.reply('❌ Could not create share link: ' + error.message);
    }
  }

  async function handleBatchCommand(ctx) {
    hooks.clearPrompt?.(ctx.from.id);
    clearSession(ctx.from.id);
    const rawArgs = ctx.message?.text?.replace(/^\/\S+\s*/, '').trim() ?? '';
    if (rawArgs.includes('|')) {
      try {
        const [titlePart, codesPart] = rawArgs.split('|').map((s) => s.trim());
        const codes = parseCodesList(codesPart);
        if (!codes.length) throw new Error('Use: /Batch TITLE | CODE1,CODE2,... (up to 20)');
        const created = await createBatchShareLink(pool, codes, titlePart || null, ctx.from.id, resolveOwnerScope(ctx));
        return showShareLinkDetail(ctx, created.id, false);
      } catch (error) {
        return ctx.reply('❌ Could not create batch link: ' + error.message);
      }
    }
    return startBatchSession(ctx, false, rawArgs || null);
  }

  async function handleLinksCommand(ctx) {
    hooks.clearPrompt?.(ctx.from.id);
    clearSession(ctx.from.id);
    return showShareLinks(ctx, 0, false);
  }

  async function handleDoneCommand(ctx) {
    const session = getSession(ctx.from.id);
    if (!session || session.mode !== 'batch_collect') {
      return ctx.reply('⚠️ No active /Batch collection session. Start one with /Batch.');
    }
    return enqueueUserWork(ctx.from.id, () => finalizeBatchSession(ctx, false));
  }

  async function handleLinkDeleteCommand(ctx) {
    hooks.clearPrompt?.(ctx.from.id);
    clearSession(ctx.from.id);
    const idOrCode = ctx.message?.text?.replace(/^\/\S+\s*/, '').trim() ?? '';
    if (!idOrCode) return ctx.reply('ℹ️ Usage: /link_delete <link_code_or_id>');
    try {
      const deleted = await deleteShareLink(pool, idOrCode, resolveOwnerScope(ctx));
      return ctx.reply(deleted ? `🗑 Deleted share link ${deleted.link_code} (${deleted.title}).` : '⚠️ Share link not found.');
    } catch (error) {
      return ctx.reply('❌ Could not delete share link: ' + error.message);
    }
  }

  bot.command('link', handleLinkCommand);
  bot.command('Batch', handleBatchCommand);
  bot.command('batch', handleBatchCommand);
  bot.command(/^batch$/i, handleBatchCommand);
  bot.command('links', handleLinksCommand);
  bot.command('link_delete', handleLinkDeleteCommand);
  bot.command('done', handleDoneCommand);

  // --- Inline Callbacks ---
  bot.action('cc:cmd_link', async (ctx) => {
    await safeAnswer(ctx);
    await startSingleLinkPrompt(ctx, true, null);
  });

  bot.action('cc:cmd_batch', async (ctx) => {
    await safeAnswer(ctx);
    await startBatchSession(ctx, true, null);
  });

  bot.action(/^cc:links:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    clearSession(ctx.from.id);
    await showShareLinks(ctx, Number(ctx.match[1]), true);
  });

  bot.action(/^cc:lnk:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    clearSession(ctx.from.id);
    await showShareLinkDetail(ctx, Number(ctx.match[1]), true);
  });

  bot.action(/^cc:mklink:([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
    const code = ctx.match[1];
    try {
      const active = getSession(ctx.from.id);
      const title = active?.mode === 'link_single' ? active.title : null;
      clearSession(ctx.from.id);
      const created = await createSingleShareLink(pool, code, title, ctx.from.id, resolveOwnerScope(ctx));
      await safeAnswer(ctx, 'Shareable link generated! 🔗');
      await showShareLinkDetail(ctx, created.id, false);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });

  bot.action(/^cc:frename:([A-Za-z0-9_-]{2,32})(?::(\d+))?$/, async (ctx) => {
    const fileCode = ctx.match[1].toUpperCase();
    const returnLinkId = ctx.match[2] ? Number(ctx.match[2]) : null;
    const file = await getIndexedFile(pool, fileCode, resolveOwnerScope(ctx));
    if (!file) return safeAnswer(ctx, 'File not found.', true);
    hooks.clearPrompt?.(ctx.from.id);
    setSession(ctx.from.id, { mode: 'file_rename', fileCode: file.file_code, returnLinkId });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `✏️ <b>Rename File</b> (<code>${escapeHtml(file.file_code)}</code>)\n━━━━━━━━━━━━━━━━━━\n\n📄 <b>Current name:</b> ${escapeHtml(file.file_name)}\n\n✍️ Send the new filename below:`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: returnLinkId ? `cc:lnk:${returnLinkId}` : `cc:file:${file.file_code}` }]] },
      true,
      true,
      HTML,
    );
  });

  bot.action(/^cc:lnk_ren:(\d+)$/, async (ctx) => {
    const linkId = Number(ctx.match[1]);
    const link = await getShareLinkById(pool, linkId, resolveOwnerScope(ctx));
    if (!link) return safeAnswer(ctx, 'Link not found.', true);
    hooks.clearPrompt?.(ctx.from.id);
    setSession(ctx.from.id, { mode: 'link_rename', linkId });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `✏️ <b>Rename Share Link</b>\n━━━━━━━━━━━━━━━━━━\n\n🏷 <b>Current title:</b> ${escapeHtml(link.title)}\n🔑 <b>Link code:</b> <code>${escapeHtml(link.link_code)}</code>\n\n✍️ Send the new title below:`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: `cc:lnk:${linkId}` }]] },
      true,
      true,
      HTML,
    );
  });

  bot.action(/^cc:lnk_items:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    clearSession(ctx.from.id);
    await showShareLinkItemsEditor(ctx, Number(ctx.match[1]), true);
  });

  bot.action(/^cc:lnk_add:(\d+)$/, async (ctx) => {
    const linkId = Number(ctx.match[1]);
    const link = await getShareLinkById(pool, linkId, resolveOwnerScope(ctx));
    if (!link) return safeAnswer(ctx, 'Link not found.', true);
    if (link.items.length >= MAX_SHARE_BATCH_ITEMS) {
      return safeAnswer(ctx, `Maximum ${MAX_SHARE_BATCH_ITEMS} items reached.`, true);
    }
    hooks.clearPrompt?.(ctx.from.id);
    setSession(ctx.from.id, { mode: 'link_add_item', linkId });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `➕ <b>Add Media to "${escapeHtml(link.title)}"</b> (${link.items.length}/${MAX_SHARE_BATCH_ITEMS})\n━━━━━━━━━━━━━━━━━━\n\n📤 Send or forward a media file, OR send file code(s) separated by spaces/commas:`,
      { inline_keyboard: [[{ text: '✖ Done / Cancel', callback_data: `cc:lnk_items:${linkId}` }]] },
      true,
      true,
      HTML,
    );
  });

  bot.action(/^cc:lnk_rep:(\d+)$/, async (ctx) => {
    const linkId = Number(ctx.match[1]);
    const link = await getShareLinkById(pool, linkId, resolveOwnerScope(ctx));
    if (!link) return safeAnswer(ctx, 'Link not found.', true);
    hooks.clearPrompt?.(ctx.from.id);
    setSession(ctx.from.id, { mode: 'link_replace_items', linkId });
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `✏️ <b>Replace Items in "${escapeHtml(link.title)}"</b>\n━━━━━━━━━━━━━━━━━━\n\n✍️ Send 1 to ${MAX_SHARE_BATCH_ITEMS} file codes separated by commas or spaces:\n<i>Example: <code>CODE1, CODE2, CODE3</code></i>`,
      { inline_keyboard: [[{ text: '✖ Cancel', callback_data: `cc:lnk_items:${linkId}` }]] },
      true,
      true,
      HTML,
    );
  });

  bot.action(/^cc:lnk_rmi:(\d+):(\d+)$/, async (ctx) => {
    const linkId = Number(ctx.match[1]);
    const fileId = Number(ctx.match[2]);
    try {
      await removeItemFromShareLink(pool, linkId, fileId, resolveOwnerScope(ctx));
      await safeAnswer(ctx, 'Item removed from batch.');
      await showShareLinkItemsEditor(ctx, linkId, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });

  bot.action(/^cc:lnk_tog:(\d+)$/, async (ctx) => {
    const linkId = Number(ctx.match[1]);
    const ownerScope = resolveOwnerScope(ctx);
    const link = await getShareLinkById(pool, linkId, ownerScope);
    if (!link) return safeAnswer(ctx, 'Link not found.', true);
    await setShareLinkEnabled(pool, linkId, !link.is_enabled, ownerScope);
    await safeAnswer(ctx, !link.is_enabled ? 'Share link enabled. 🟢' : 'Share link disabled. ⏸');
    await showShareLinkDetail(ctx, linkId, true);
  });

  bot.action(/^cc:lnk_del:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    await showShareLinkDetail(ctx, Number(ctx.match[1]), true, true);
  });

  bot.action(/^cc:lnk_del_ok:(\d+)$/, async (ctx) => {
    const linkId = Number(ctx.match[1]);
    const deleted = await deleteShareLink(pool, linkId, resolveOwnerScope(ctx));
    await safeAnswer(ctx, deleted ? 'Share link deleted. 🗑' : 'Link not found.');
    await showShareLinks(ctx, 0, true);
  });

  // Batch session inline controls
  bot.action('cc:b_done', async (ctx) => {
    await safeAnswer(ctx);
    await enqueueUserWork(ctx.from.id, () => finalizeBatchSession(ctx, true));
  });

  bot.action('cc:b_title', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.mode !== 'batch_collect') {
      return safeAnswer(ctx, 'No active batch session.', true);
    }
    session.awaitingTitle = true;
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `✏️ <b>Set Batch Title</b>\n━━━━━━━━━━━━━━━━━━\n\n🏷 <b>Current:</b> ${session.title ? escapeHtml(session.title) : '<i>(none)</i>'}\n✍️ Send the new batch title below:`,
      { inline_keyboard: [[{ text: '← Back to Collector', callback_data: 'cc:b_back' }]] },
      true,
      true,
      HTML,
    );
  });

  bot.action('cc:b_back', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.mode !== 'batch_collect') {
      return safeAnswer(ctx, 'No active batch session.', true);
    }
    session.awaitingTitle = false;
    await safeAnswer(ctx);
    await renderView(ctx, formatBatchCollectorText(session), buildBatchCollectorKeyboard(session), true, true, HTML);
  });

  bot.action('cc:b_undo', async (ctx) => {
    await safeAnswer(ctx);
    await enqueueUserWork(ctx.from.id, async () => {
      const session = getSession(ctx.from.id);
      if (!session || session.mode !== 'batch_collect') return;
      session.items.pop();
      await renderView(ctx, formatBatchCollectorText(session), buildBatchCollectorKeyboard(session), true, true, HTML);
    });
  });

  bot.action('cc:b_cancel', async (ctx) => {
    clearSession(ctx.from.id);
    await safeAnswer(ctx, 'Cancelled.');
    await renderView(
      ctx,
      '✖ <b>Link creation cancelled.</b>\n\n💡 <i>Use /link, /Batch, or open the menu below anytime.</i>',
      {
        inline_keyboard: [[
          { text: '🔗 Generated Links', callback_data: 'cc:links:0' },
          { text: '🎛 Main Menu', callback_data: 'cc:home' },
        ]],
      },
      true,
      true,
      HTML,
    );
  });

  // --- Media Interceptor (runs BEFORE passive file ingest handler) ---
  bot.on(['video', 'document', 'photo', 'audio', 'voice', 'video_note', 'animation'], async (ctx, next) => {
    const session = getSession(ctx.from?.id);
    if (!session) return next();

    if (!['link_single', 'batch_collect', 'link_add_item'].includes(session.mode)) {
      return next();
    }

    return enqueueUserWork(ctx.from.id, async () => {
      const active = getSession(ctx.from.id);
      if (!active) return next();

      if (active.mode === 'batch_collect' && active.items.length >= MAX_SHARE_BATCH_ITEMS) {
        return ctx.reply(
          `📦 <b>Batch limit reached (${MAX_SHARE_BATCH_ITEMS}/${MAX_SHARE_BATCH_ITEMS}).</b>\nTap <b>"✅ Generate Link"</b> or send <code>/done</code>.`,
          { ...HTML, reply_markup: buildBatchCollectorKeyboard(active) },
        );
      }

      let ingestResult;
      try {
        ingestResult = await ingestTelegramMedia(ctx, pool, logger);
      } catch (error) {
        return ctx.reply('❌ Media indexing failed: ' + error.message);
      }
      if (!ingestResult?.file) return;
      const file = ingestResult.file;

      if (active.mode === 'link_single') {
        const title = active.title ?? null;
        const ownerScope = resolveOwnerScope(ctx);
        clearSession(ctx.from.id);
        const created = await createSingleShareLink(pool, file.id, title, ctx.from.id, ownerScope);
        return showShareLinkDetail(ctx, created.id, false);
      }

      if (active.mode === 'batch_collect') {
        active.awaitingTitle = false;
        active.expiresAt = Date.now() + SESSION_TTL_MS;
        if (active.items.some((item) => Number(item.file_id) === Number(file.id))) {
          return ctx.reply(
            `♻️ <b>Already in batch (${active.items.length}/${MAX_SHARE_BATCH_ITEMS}):</b> ${escapeHtml(file.file_name)} (<code>${escapeHtml(file.file_code)}</code>)`,
            { ...HTML, reply_markup: buildBatchCollectorKeyboard(active) },
          );
        }
        active.items.push({ file_id: file.id, file_code: file.file_code, file_name: file.file_name });
        return ctx.reply(
          `✅ <b>Added (${active.items.length}/${MAX_SHARE_BATCH_ITEMS}): ${escapeHtml(file.file_name)}</b> (<code>${escapeHtml(file.file_code)}</code>)\n` +
            (active.items.length >= MAX_SHARE_BATCH_ITEMS
              ? `🎉 Limit of ${MAX_SHARE_BATCH_ITEMS} items reached! Tap <b>"✅ Generate Link"</b> or send <code>/done</code>.`
              : '📤 Send more media/codes, or tap <b>"✅ Generate Link"</b> when ready.'),
          { ...HTML, reply_markup: buildBatchCollectorKeyboard(active) },
        );
      }

      if (active.mode === 'link_add_item') {
        try {
          const added = await addItemToShareLink(pool, active.linkId, file.id, resolveOwnerScope(ctx));
          clearSession(ctx.from.id);
          await ctx.reply(`✅ Added <b>${escapeHtml(added.file.file_name)}</b> (<code>${escapeHtml(added.file.file_code)}</code>) — now <b>${added.itemCount}/${MAX_SHARE_BATCH_ITEMS}</b> item(s).`, HTML);
          return showShareLinkItemsEditor(ctx, active.linkId, false);
        } catch (error) {
          return ctx.reply('❌ Could not add media: ' + error.message);
        }
      }
    });
  });

  return {
    getSession,
    clearSession,
    showShareLinks,
    showShareLinkDetail,
    async handleTextMessage(ctx) {
      const text = ctx.message?.text?.trim() ?? '';
      const session = getSession(ctx.from?.id);
      if (!session) return false;

      if (text.startsWith('/')) return false;

      return enqueueUserWork(ctx.from.id, async () => {
        const active = getSession(ctx.from.id);
        if (!active) return false;

        const ownerScope = resolveOwnerScope(ctx);
        try {
          if (active.mode === 'link_single') {
            const code = text.split(/\s+/)[0].toUpperCase();
            const created = await createSingleShareLink(pool, code, active.title ?? null, ctx.from.id, ownerScope);
            clearSession(ctx.from.id);
            await showShareLinkDetail(ctx, created.id, false);
            return true;
          }

          if (active.mode === 'batch_collect') {
            active.expiresAt = Date.now() + SESSION_TTL_MS;
            if (active.awaitingTitle) {
              active.title = text.slice(0, 160);
              active.awaitingTitle = false;
              await ctx.reply(formatBatchCollectorText(active), { ...HTML, reply_markup: buildBatchCollectorKeyboard(active) });
              return true;
            }
            const codes = parseCodesList(text);
            if (!codes.length) {
              await ctx.reply('📤 Send media files or valid file codes (or tap <b>"✅ Generate Link"</b>).', {
                ...HTML,
                reply_markup: buildBatchCollectorKeyboard(active),
              });
              return true;
            }
            const addedCodes = [];
            const skipped = [];
            for (const code of codes) {
              if (active.items.length >= MAX_SHARE_BATCH_ITEMS) {
                skipped.push(`${code} (max ${MAX_SHARE_BATCH_ITEMS} reached)`);
                continue;
              }
              const file = await getIndexedFile(pool, code, ownerScope);
              if (!file) {
                skipped.push(`${code} (not found)`);
                continue;
              }
              if (active.items.some((i) => Number(i.file_id) === Number(file.id))) {
                skipped.push(`${file.file_code} (duplicate)`);
                continue;
              }
              active.items.push({ file_id: file.id, file_code: file.file_code, file_name: file.file_name });
              addedCodes.push(file.file_code);
            }
            const msgParts = [];
            if (addedCodes.length) msgParts.push(`✅ Added <code>${escapeHtml(addedCodes.join(', '))}</code> (<b>${active.items.length}/${MAX_SHARE_BATCH_ITEMS}</b>).`);
            if (skipped.length) msgParts.push(`⚠️ Skipped: ${escapeHtml(skipped.join(', '))}.`);
            await ctx.reply(msgParts.join('\n') || formatBatchCollectorText(active), {
              ...HTML,
              reply_markup: buildBatchCollectorKeyboard(active),
            });
            return true;
          }

          if (active.mode === 'link_rename') {
            const updated = await renameShareLink(pool, active.linkId, text, ownerScope);
            clearSession(ctx.from.id);
            if (!updated) throw new Error('Share link not found.');
            await ctx.reply(`✅ Link renamed to: <b>${escapeHtml(updated.title)}</b>`, HTML);
            await showShareLinkDetail(ctx, updated.id, false);
            return true;
          }

          if (active.mode === 'file_rename') {
            const updated = await renameIndexedFile(pool, active.fileCode, text, ownerScope);
            const returnLinkId = active.returnLinkId;
            clearSession(ctx.from.id);
            if (!updated) throw new Error('File not found.');
            await ctx.reply(`✅ File <code>${escapeHtml(updated.file_code)}</code> renamed to: <b>${escapeHtml(updated.file_name)}</b>`, HTML);
            if (returnLinkId) {
              await showShareLinkDetail(ctx, returnLinkId, false);
            } else {
              await ctx.reply(`📄 <b>Updated file:</b> ${escapeHtml(updated.file_name)} (<code>${escapeHtml(updated.file_code)}</code>)`, {
                ...HTML,
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🔗 Generate Share Link', callback_data: `cc:mklink:${updated.file_code}` },
                    { text: '📄 File Details', callback_data: `cc:file:${updated.file_code}` },
                  ]],
                },
              });
            }
            return true;
          }

          if (active.mode === 'link_add_item') {
            const codes = parseCodesList(text);
            if (!codes.length) throw new Error('Send a media file or one or more file codes.');
            const added = [];
            for (const code of codes) {
              const res = await addItemToShareLink(pool, active.linkId, code, ownerScope);
              added.push(res.file.file_code);
            }
            clearSession(ctx.from.id);
            await ctx.reply(`✅ Added <code>${escapeHtml(added.join(', '))}</code> to share link.`, HTML);
            await showShareLinkItemsEditor(ctx, active.linkId, false);
            return true;
          }

          if (active.mode === 'link_replace_items') {
            const codes = parseCodesList(text);
            const updated = await updateShareLinkItems(pool, active.linkId, codes, ownerScope);
            clearSession(ctx.from.id);
            await ctx.reply(`✅ Updated batch items (<b>${updated.itemCount}/${MAX_SHARE_BATCH_ITEMS}</b>).`, HTML);
            await showShareLinkItemsEditor(ctx, active.linkId, false);
            return true;
          }
        } catch (error) {
          await ctx.reply('❌ Action failed: ' + error.message);
          return true;
        }
        return false;
      });
    },
  };
}
