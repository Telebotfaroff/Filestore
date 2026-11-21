import { ingestTelegramMedia } from '../storage/ingest-handler.js';
import { getIndexedFile, listRecentFiles, formatFileSize } from '../storage/file-query.js';
import { getShareableBotUsername, buildShareableUrl, MAX_SHARE_BATCH_ITEMS } from '../storage/share-links-repository.js';
import { createPaidFileLink } from '../paid-files/repository.js';
import { createPaidBatch } from '../paid-files/batch-repository.js';
import { setTelegramStarsPrice } from '../payments/telegram-stars.js';
import { escapeHtml, renderView, safeAnswer } from './telegram-utils.js';
import {
  parseMinorAmount,
  parseCurrencyCode,
  parseOptionalExpiryDays,
  formatMoney,
} from '../utils/validation.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const HTML = { parse_mode: 'HTML' };

function parseCodesList(rawText) {
  return String(rawText ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function parsePaidPriceInput(rawText) {
  const input = String(rawText ?? '').trim();
  if (!input) throw new Error('Enter a price (e.g. 149, 149|50, or 50 stars).');

  // Support single-token Stars shorthand like "50 stars", "50 star", "50⭐", "50 XTR"
  if (!input.includes('|')) {
    const starsOnlyMatch = input.match(/^(\d+)\s*(?:⭐|stars?|xtr)$/i);
    if (starsOnlyMatch) {
      const stars = Number(starsOnlyMatch[1]);
      if (!Number.isSafeInteger(stars) || stars < 1 || stars > 100_000_000) {
        throw new Error('Stars price must be an integer between 1 and 100000000.');
      }
      return { priceMinor: stars, currency: 'XTR', starsPrice: stars, expiresAt: null };
    }
  }

  const parts = input.split('|').map((s) => s.trim());
  if (parts.length > 3) {
    throw new Error('Use: PRICE [CURRENCY] | STARS(optional) | EXPIRY_DAYS(optional)');
  }

  const fiatPart = parts[0] ?? '';
  const starsPart = parts[1] ?? '';
  const expiryPart = parts[2] ?? '';

  // Parse optional Stars amount
  let starsPrice = null;
  if (starsPart !== '') {
    const cleanStars = starsPart.replace(/\s*(?:⭐|stars?|xtr)$/i, '').trim();
    if (!/^\d+$/.test(cleanStars)) {
      throw new Error('Stars price must be a non-negative integer (or leave blank).');
    }
    const n = Number(cleanStars);
    if (n > 100_000_000) throw new Error('Stars price is too large.');
    if (n > 0) starsPrice = n;
  }

  // Parse optional expiry days
  const expiresAt = expiryPart ? parseOptionalExpiryDays(expiryPart) : null;

  // Parse fiat/INR price (allow "0" only when Stars price is set -> Stars-only link)
  const fiatTokens = fiatPart.split(/\s+/).filter(Boolean);
  if (!fiatTokens.length) throw new Error('Price is required (e.g. 149, 149|50, or 50 stars).');

  const rawAmt = fiatTokens[0];
  const rawCur = fiatTokens[1] ?? 'INR';
  const curUpper = rawCur.toUpperCase();

  if (curUpper === 'XTR' || /^(?:⭐|stars?|xtr)$/i.test(rawCur)) {
    if (!/^\d+$/.test(rawAmt)) throw new Error('Stars price must be a whole integer.');
    const stars = Number(rawAmt);
    if (stars < 1 || stars > 100_000_000) throw new Error('Stars price must be between 1 and 100000000.');
    return { priceMinor: stars, currency: 'XTR', starsPrice: stars, expiresAt };
  }

  const priceMinor = parseMinorAmount(rawAmt, { allowZero: true });
  const currency = parseCurrencyCode(curUpper);

  if (priceMinor === 0) {
    if (!starsPrice) {
      throw new Error('Price must be greater than 0 (or provide a Stars price, e.g. 0|50 or 50 stars).');
    }
    return { priceMinor: starsPrice, currency: 'XTR', starsPrice, expiresAt };
  }

  return { priceMinor, currency, starsPrice, expiresAt };
}

export function registerPaidLinksUi(bot, logger, pool, hooks = {}) {
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

  function pricePromptText(header, summaryLines) {
    return [
      `<b>${header}</b>`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      ...summaryLines,
      '',
      '💵 <b>Send the price in any format:</b>',
      '• <code>149</code> — ₹149.00 INR (UPI QR)',
      '• <code>149|50</code> — ₹149.00 INR + 50 ⭐ Telegram Stars',
      '• <code>50 stars</code> — 50 ⭐ Telegram Stars only',
      '• <code>149|50|30</code> — with 30-day expiry',
    ].join('\n');
  }

  function buildBatchCollectorKeyboard(session) {
    const count = session.items.length;
    const rows = [];
    if (count >= 2) {
      rows.push([{ text: `✅ Next: Set Price (${count}/${MAX_SHARE_BATCH_ITEMS})`, callback_data: 'cc:plb_next' }]);
    }
    const midRow = [{ text: '✏ Set Title', callback_data: 'cc:plb_title' }];
    if (count > 0) midRow.push({ text: '↩ Undo Last', callback_data: 'cc:plb_undo' });
    rows.push(midRow);
    rows.push([
      { text: '← Back', callback_data: 'cc:plink' },
      { text: '✖ Cancel', callback_data: 'cc:plink_cancel' },
    ]);
    return { inline_keyboard: rows };
  }

  function formatBatchCollectorText(session) {
    const count = session.items.length;
    const lines = [
      `📚 <b>Create Batch Paid Link (Step 1/3 · ${count}/${MAX_SHARE_BATCH_ITEMS})</b>`,
      '━━━━━━━━━━━━━━━━━━',
      `🏷 <b>Title: ${session.title ? escapeHtml(session.title) : '(set later or auto-generated)'}</b>`,
      '',
      count
        ? session.items.map((item, i) => `${i + 1}. 📄 ${escapeHtml(String(item.file_name).slice(0, 60))} (<code>${escapeHtml(item.file_code)}</code>)`).join('\n')
        : '<i>📭 No media added yet.</i>',
      '',
      count >= MAX_SHARE_BATCH_ITEMS
        ? `🎉 Maximum <b>${MAX_SHARE_BATCH_ITEMS}</b> items reached! Tap <b>"✅ Next: Set Price"</b> or send <code>/done</code>.`
        : `📤 Send or forward 2 to ${MAX_SHARE_BATCH_ITEMS} media files (video, document, photo, audio) OR file codes.\n` +
          (count >= 2 ? '✨ Tap <b>"✅ Next: Set Price"</b> or send <code>/done</code> when finished.' : `➕ Add at least <b>${2 - count}</b> more item(s).`),
    ];
    return lines.join('\n');
  }

  async function showPlinkMenu(ctx, edit = false) {
    hooks.clearOtherSessions?.(ctx.from.id);
    clearSession(ctx.from.id);
    const text = [
      '💎 <b>Create Paid Link</b> (<code>/plink</code>)',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '💰 <b>Monetize your files with instant UPI QR &amp; Telegram Stars checkout!</b>',
      '',
      '• 🏷 <b>Single</b> — Sell 1 media file',
      '• 📚 <b>Batch</b> — Sell a collection of 2–20 media files',
      '',
      '👇 <i>Choose the type of paid link to create:</i>',
    ].join('\n');
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🏷 Single', callback_data: 'cc:plink_single' },
          { text: '📚 Batch', callback_data: 'cc:plink_batch' },
        ],
        [
          { text: '🏷 Paid Links', callback_data: 'cc:paid' },
          { text: '📚 Batch Links', callback_data: 'cc:batch' },
        ],
        [{ text: '✖ Cancel', callback_data: 'cc:plink_cancel' }],
      ],
    };
    return renderView(ctx, text, keyboard, edit, true, HTML);
  }

  async function startSinglePaidPrompt(ctx, edit = false) {
    hooks.clearOtherSessions?.(ctx.from.id);
    const ownerScope = resolveOwnerScope(ctx);
    setSession(ctx.from.id, { mode: 'plink_single', step: 'media', file: null });
    const recent = await listRecentFiles(pool, 4, ownerScope).catch(() => []);
    const keyboard = recent.map((f) => [
      { text: `📄 ${f.file_code} · ${String(f.file_name).slice(0, 26)}`, callback_data: `cc:plfile:${f.file_code}` },
    ]);
    keyboard.push([
      { text: '← Back', callback_data: 'cc:plink' },
      { text: '✖ Cancel', callback_data: 'cc:plink_cancel' },
    ]);
    const lines = [
      '🏷 <b>Create Single Paid Link (Step 1/2)</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '📤 Send or forward ANY media file (video, document, photo, audio, animation) here.',
      '💡 You can also send an existing file code' + (recent.length ? ' or tap a recent file below:' : '.'),
    ];
    return renderView(ctx, lines.join('\n'), { inline_keyboard: keyboard }, edit, true, HTML);
  }

  async function startBatchPaidSession(ctx, edit = false) {
    hooks.clearOtherSessions?.(ctx.from.id);
    const session = setSession(ctx.from.id, {
      mode: 'plink_batch',
      step: 'media',
      title: null,
      awaitingTitle: false,
      items: [],
    });
    return renderView(ctx, formatBatchCollectorText(session), buildBatchCollectorKeyboard(session), edit, true, HTML);
  }

  async function promptSinglePrice(ctx, session, edit = false) {
    session.step = 'price';
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    const file = session.file;
    const text = pricePromptText('💰 Set Single Paid Link Price (Step 2/2)', [
      `📄 <b>File:</b> ${escapeHtml(file.file_name)} (<code>${escapeHtml(file.file_code)}</code>)`,
      `📦 <b>Size:</b> ${escapeHtml(formatFileSize(file.file_size))}`,
    ]);
    return renderView(
      ctx,
      text,
      {
        inline_keyboard: [[
          { text: '← Change Media', callback_data: 'cc:plink_single' },
          { text: '✖ Cancel', callback_data: 'cc:plink_cancel' },
        ]],
      },
      edit,
      true,
      HTML,
    );
  }

  async function advanceBatchToNextStep(ctx, session, edit = false) {
    if (!session || session.mode !== 'plink_batch') {
      return renderView(ctx, '⚠️ No active paid batch session.', { inline_keyboard: [[{ text: '💎 /plink', callback_data: 'cc:plink' }]] }, edit);
    }
    if (session.items.length < 2) {
      return renderView(
        ctx,
        '⚠️ <b>At least 2 media files required</b> for a paid batch.\nSend more media or switch to <b>Single</b>.',
        buildBatchCollectorKeyboard(session),
        edit,
        true,
        HTML,
      );
    }
    session.awaitingTitle = false;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    if (!session.title) {
      session.step = 'title';
      return renderView(
        ctx,
        `✏️ <b>Batch Paid Link Title (Step 2/3 · ${session.items.length} files)</b>\n━━━━━━━━━━━━━━━━━━\n\n✍️ Send a title for this paid batch (<i>e.g. "Starter Pack"</i>), or tap <b>Use Auto-Title</b>:`,
        {
          inline_keyboard: [
            [{ text: '⏭ Use Auto-Title', callback_data: 'cc:plb_autotitle' }],
            [
              { text: '← Add More Media', callback_data: 'cc:plb_back' },
              { text: '✖ Cancel', callback_data: 'cc:plink_cancel' },
            ],
          ],
        },
        edit,
        true,
        HTML,
      );
    }
    session.step = 'price';
    return renderView(
      ctx,
      pricePromptText('💰 Set Batch Paid Link Price (Step 3/3)', [
        `🏷 <b>Title: ${escapeHtml(session.title)}</b>`,
        `📦 <b>Files:</b> ${session.items.length}`,
      ]),
      {
        inline_keyboard: [[
          { text: '← Add More Media', callback_data: 'cc:plb_back' },
          { text: '✖ Cancel', callback_data: 'cc:plink_cancel' },
        ]],
      },
      edit,
      true,
      HTML,
    );
  }

  async function finalizeSinglePaidLink(ctx, session, priceInput) {
    const parsed = parsePaidPriceInput(priceInput);
    const ownerScope = resolveOwnerScope(ctx);
    const created = await createPaidFileLink(
      pool,
      session.file.file_code,
      parsed.priceMinor,
      parsed.currency,
      parsed.expiresAt,
      ctx.from.id,
      ownerScope,
    );
    if (parsed.starsPrice) {
      await setTelegramStarsPrice(pool, 'paid_file', created.id, parsed.starsPrice, ctx.from.id);
    }
    clearSession(ctx.from.id);
    const botUsername = await getShareableBotUsername(pool, ownerScope);
    const deepUrl = buildShareableUrl(botUsername, `paid_${created.public_code}`);

    const priceParts = [];
    if (created.currency !== 'XTR') priceParts.push(formatMoney(created.price_minor, created.currency));
    if (parsed.starsPrice) priceParts.push(`${parsed.starsPrice} ⭐`);

    const lines = [
      '🎉 <b>Paid Single Link Created!</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      `📄 <b>File:</b> ${escapeHtml(created.file_name)} (<code>${escapeHtml(created.file_code)}</code>)`,
      `🔑 <b>Link ID:</b> #${created.id} · <b>Code:</b> <code>${escapeHtml(created.public_code)}</code>`,
      `💰 <b>Price:</b> <b>${escapeHtml(priceParts.join(' / '))}</b>`,
      `⏳ <b>Expiry:</b> ${created.expires_at ? escapeHtml(new Date(created.expires_at).toISOString()) : 'Never'}`,
      '',
      ...(deepUrl ? [`🌐 <b>Shareable Link:</b>\n<code>${escapeHtml(deepUrl)}</code>`, ''] : []),
      `⚡ <b>User command:</b> <code>/paid ${escapeHtml(created.public_code)}</code>`,
    ];
    const keyboard = [
      ...(deepUrl ? [[{ text: '🔗 Open Paid Link', url: deepUrl }]] : []),
      [
        { text: '🏷 All Paid Links', callback_data: 'cc:paid' },
        { text: '🗑 Delete', callback_data: `cc:paid_del:${created.id}` },
      ],
      [
        { text: '➕ Create Another', callback_data: 'cc:plink' },
        { text: '🎛 Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return ctx.reply(lines.join('\n'), { ...HTML, reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true });
  }

  async function finalizeBatchPaidLink(ctx, session, priceInput) {
    const parsed = parsePaidPriceInput(priceInput);
    const ownerScope = resolveOwnerScope(ctx);
    const title = (session.title || `${session.items[0]?.file_name ?? 'Paid Batch'} + ${session.items.length - 1} more`).slice(0, 100);
    const codes = session.items.map((i) => i.file_code);
    const created = await createPaidBatch(
      pool,
      codes,
      title,
      parsed.priceMinor,
      parsed.currency,
      parsed.expiresAt,
      ctx.from.id,
      ownerScope,
    );
    if (parsed.starsPrice) {
      await setTelegramStarsPrice(pool, 'paid_batch', created.id, parsed.starsPrice, ctx.from.id);
    }
    clearSession(ctx.from.id);
    const botUsername = await getShareableBotUsername(pool, ownerScope);
    const deepUrl = buildShareableUrl(botUsername, `pbatch_${created.public_code}`);

    const priceParts = [];
    if (created.currency !== 'XTR') priceParts.push(formatMoney(created.price_minor, created.currency));
    if (parsed.starsPrice) priceParts.push(`${parsed.starsPrice} ⭐`);
    const itemNames = created.files.map((f, idx) => `${idx + 1}. 📄 ${escapeHtml(f.file_name)} (<code>${escapeHtml(f.file_code)}</code>)`).join('\n');

    const lines = [
      '🎉 <b>Paid Batch Link Created!</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏷 <b>Title: ${escapeHtml(created.title)}</b>`,
      `🔑 <b>Batch ID:</b> #${created.id} · <b>Code:</b> <code>${escapeHtml(created.public_code)}</code>`,
      `📦 <b>Files:</b> ${created.itemCount}`,
      `💰 <b>Price:</b> <b>${escapeHtml(priceParts.join(' / '))}</b>`,
      `⏳ <b>Expiry:</b> ${created.expires_at ? escapeHtml(new Date(created.expires_at).toISOString()) : 'Never'}`,
      '',
      ...(deepUrl ? [`🌐 <b>Shareable Link:</b>\n<code>${escapeHtml(deepUrl)}</code>`, ''] : []),
      `⚡ <b>User command:</b> <code>/batch ${escapeHtml(created.public_code)}</code>`,
      '',
      '📂 <b>Included Files:</b>',
      itemNames,
    ];
    const keyboard = [
      ...(deepUrl ? [[{ text: '🔗 Open Paid Batch', url: deepUrl }]] : []),
      [
        { text: '📚 All Batch Links', callback_data: 'cc:batch' },
        { text: '🗑 Delete', callback_data: `cc:batch_del:${created.id}` },
      ],
      [
        { text: '➕ Create Another', callback_data: 'cc:plink' },
        { text: '🎛 Main Menu', callback_data: 'cc:home' },
      ],
    ];
    return ctx.reply(lines.join('\n'), { ...HTML, reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true });
  }

  // --- Commands ---
  async function handlePlinkCommand(ctx) {
    return showPlinkMenu(ctx, false);
  }
  bot.command('plink', handlePlinkCommand);
  bot.command('Plink', handlePlinkCommand);

  // /done interceptor for plink_batch media collection; calls next() if not in plink_batch media step
  bot.command('done', async (ctx, next) => {
    const session = getSession(ctx.from?.id);
    if (!session || session.mode !== 'plink_batch' || session.step !== 'media') {
      return next();
    }
    return enqueueUserWork(ctx.from.id, () => advanceBatchToNextStep(ctx, getSession(ctx.from.id), false));
  });

  // --- Inline Callbacks ---
  bot.action('cc:plink', async (ctx) => {
    await safeAnswer(ctx);
    await showPlinkMenu(ctx, true);
  });

  bot.action('cc:plink_single', async (ctx) => {
    await safeAnswer(ctx);
    await startSinglePaidPrompt(ctx, true);
  });

  bot.action('cc:plink_batch', async (ctx) => {
    await safeAnswer(ctx);
    await startBatchPaidSession(ctx, true);
  });

  bot.action('cc:plink_cancel', async (ctx) => {
    clearSession(ctx.from.id);
    await safeAnswer(ctx, 'Cancelled.');
    await renderView(
      ctx,
      '✖ <b>Paid link creation cancelled.</b>\n\n💡 <i>Run /plink anytime to start again.</i>',
      {
        inline_keyboard: [[
          { text: '💎 /plink', callback_data: 'cc:plink' },
          { text: '🎛 Main Menu', callback_data: 'cc:home' },
        ]],
      },
      true,
      true,
      HTML,
    );
  });

  bot.action(/^cc:plfile:([A-Za-z0-9_-]{2,32})$/, async (ctx) => {
    const code = ctx.match[1];
    try {
      const file = await getIndexedFile(pool, code, resolveOwnerScope(ctx));
      if (!file) return safeAnswer(ctx, 'File not found.', true);
      hooks.clearOtherSessions?.(ctx.from.id);
      const session = setSession(ctx.from.id, { mode: 'plink_single', step: 'price', file });
      await safeAnswer(ctx, `Selected ${file.file_code}`);
      await promptSinglePrice(ctx, session, true);
    } catch (error) {
      await safeAnswer(ctx, error.message, true);
    }
  });

  bot.action('cc:plb_title', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.mode !== 'plink_batch') return safeAnswer(ctx, 'No active paid batch session.', true);
    session.awaitingTitle = true;
    await safeAnswer(ctx);
    await renderView(
      ctx,
      `✏️ <b>Set Batch Title</b>\n━━━━━━━━━━━━━━━━━━\n\n🏷 <b>Current:</b> ${session.title ? escapeHtml(session.title) : '<i>(none)</i>'}\n✍️ Send the batch title below:`,
      { inline_keyboard: [[{ text: '← Back to Collector', callback_data: 'cc:plb_back' }]] },
      true,
      true,
      HTML,
    );
  });

  bot.action('cc:plb_back', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.mode !== 'plink_batch') return safeAnswer(ctx, 'No active paid batch session.', true);
    session.step = 'media';
    session.awaitingTitle = false;
    await safeAnswer(ctx);
    await renderView(ctx, formatBatchCollectorText(session), buildBatchCollectorKeyboard(session), true, true, HTML);
  });

  bot.action('cc:plb_undo', async (ctx) => {
    await safeAnswer(ctx);
    await enqueueUserWork(ctx.from.id, async () => {
      const session = getSession(ctx.from.id);
      if (!session || session.mode !== 'plink_batch') return;
      session.items.pop();
      await renderView(ctx, formatBatchCollectorText(session), buildBatchCollectorKeyboard(session), true, true, HTML);
    });
  });

  bot.action('cc:plb_next', async (ctx) => {
    await safeAnswer(ctx);
    await enqueueUserWork(ctx.from.id, () => advanceBatchToNextStep(ctx, getSession(ctx.from.id), true));
  });

  bot.action('cc:plb_autotitle', async (ctx) => {
    const session = getSession(ctx.from.id);
    if (!session || session.mode !== 'plink_batch' || session.items.length < 2) {
      return safeAnswer(ctx, 'No active paid batch session.', true);
    }
    session.title = `${session.items[0].file_name} + ${session.items.length - 1} more`.slice(0, 100);
    await safeAnswer(ctx);
    await advanceBatchToNextStep(ctx, session, true);
  });

  // --- Media Interceptor (runs BEFORE passive file ingest handler) ---
  bot.on(['video', 'document', 'photo', 'audio', 'voice', 'video_note', 'animation'], async (ctx, next) => {
    const session = getSession(ctx.from?.id);
    if (!session) return next();

    if (session.step !== 'media' || !['plink_single', 'plink_batch'].includes(session.mode)) {
      return next();
    }

    return enqueueUserWork(ctx.from.id, async () => {
      const active = getSession(ctx.from.id);
      if (!active || active.step !== 'media') return next();

      if (active.mode === 'plink_batch' && active.items.length >= MAX_SHARE_BATCH_ITEMS) {
        return ctx.reply(
          `📦 <b>Maximum ${MAX_SHARE_BATCH_ITEMS} items reached!</b> Tap <b>"✅ Next: Set Price"</b> or send <code>/done</code>.`,
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

      if (active.mode === 'plink_single') {
        active.file = file;
        return promptSinglePrice(ctx, active, false);
      }

      if (active.mode === 'plink_batch') {
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
              ? `🎉 Limit of ${MAX_SHARE_BATCH_ITEMS} items reached! Tap <b>"✅ Next: Set Price"</b> or send <code>/done</code>.`
              : active.items.length >= 2
                ? '📤 Send more media/codes, or tap <b>"✅ Next: Set Price"</b> when ready.'
                : '➕ Send at least <b>1 more</b> media file or code.'),
          { ...HTML, reply_markup: buildBatchCollectorKeyboard(active) },
        );
      }
    });
  });

  return {
    getSession,
    clearSession,
    showPlinkMenu,
    startSinglePaidPrompt,
    startBatchPaidSession,
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
          if (active.mode === 'plink_single') {
            if (active.step === 'media') {
              const code = text.split(/\s+/)[0].toUpperCase();
              const file = await getIndexedFile(pool, code, ownerScope);
              if (!file) throw new Error(`File "${code}" not found. Send a media file or valid file code.`);
              active.file = file;
              await promptSinglePrice(ctx, active, false);
              return true;
            }
            if (active.step === 'price') {
              await finalizeSinglePaidLink(ctx, active, text);
              return true;
            }
          }

          if (active.mode === 'plink_batch') {
            active.expiresAt = Date.now() + SESSION_TTL_MS;
            if (active.step === 'media') {
              if (active.awaitingTitle) {
                active.title = text.slice(0, 100);
                active.awaitingTitle = false;
                await ctx.reply(formatBatchCollectorText(active), { ...HTML, reply_markup: buildBatchCollectorKeyboard(active) });
                return true;
              }
              const codes = parseCodesList(text);
              if (!codes.length) {
                await ctx.reply('📤 Send media files or valid file codes.', { reply_markup: buildBatchCollectorKeyboard(active) });
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
            if (active.step === 'title') {
              if (text.length > 100) throw new Error('Title must be 1–100 characters.');
              active.title = text;
              await advanceBatchToNextStep(ctx, active, false);
              return true;
            }
            if (active.step === 'price') {
              await finalizeBatchPaidLink(ctx, active, text);
              return true;
            }
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
