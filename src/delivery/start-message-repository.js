import net from 'node:net';
import { escapeHtml } from '../bot/telegram-utils.js';
import { cached, cacheDeletePrefix } from '../utils/cache.js';
import { parsePositiveInt } from '../utils/validation.js';

export const MAX_START_MESSAGE_LENGTH = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const MAX_START_IMAGE_BYTES = 2 * 1024 * 1024;
export const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MIME_TO_EXT = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
});

const DELIVERY_BOT_CACHE_PREFIX = 'delivery-bots:';

function buildScopeClause(ownerScope, startParam = 2) {
  if (ownerScope === undefined) {
    return { clause: '', params: [] };
  }
  if (ownerScope === null) {
    return { clause: 'AND owner_telegram_id IS NULL', params: [] };
  }
  const id = Number(ownerScope);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error('Invalid owner scope.'), { statusCode: 400 });
  }
  return { clause: `AND owner_telegram_id = $${startParam}`, params: [id] };
}

function isPrivateOrBlockedIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) {
    return true;
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }
  const ipVer = net.isIP(host);
  if (ipVer === 4) return isPrivateOrBlockedIpv4(host);
  if (ipVer === 6) {
    if (host === '::' || host === '::1') return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateOrBlockedIpv4(mapped[1]);
    if (/^(fc|fd|fe[89ab])/i.test(host)) return true;
  }
  return false;
}

export function detectImageMimeFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  const header6 = buf.subarray(0, 6).toString('ascii');
  if (header6 === 'GIF87a' || header6 === 'GIF89a') {
    return 'image/gif';
  }
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function validateStartImageUrl(rawUrl) {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > 1000) {
    throw Object.assign(new Error('Image URL must be 1000 characters or fewer.'), { statusCode: 400 });
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw Object.assign(new Error('Image URL must be a valid https:// link.'), { statusCode: 400 });
  }
  if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Image URL must start with https://.'), { statusCode: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('Image URL must not include embedded credentials.'), { statusCode: 400 });
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw Object.assign(new Error('Image URL host is not allowed.'), { statusCode: 400 });
  }
  return parsed.toString();
}

export function parseUploadedStartImage(rawDataUrl) {
  const input = String(rawDataUrl ?? '').trim();
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(input);
  if (!match) {
    throw Object.assign(new Error('Invalid image upload payload. Choose a PNG, JPG, WEBP, or GIF file.'), { statusCode: 400 });
  }
  const base64Clean = match[2].replace(/\s+/g, '');
  if (!base64Clean || base64Clean.length > Math.ceil(MAX_START_IMAGE_BYTES * 1.45)) {
    throw Object.assign(new Error('Image file is too large. Maximum size is 2 MB.'), { statusCode: 400 });
  }
  const buffer = Buffer.from(base64Clean, 'base64');
  if (!buffer.length) {
    throw Object.assign(new Error('Uploaded image file is empty.'), { statusCode: 400 });
  }
  if (buffer.length > MAX_START_IMAGE_BYTES) {
    throw Object.assign(new Error('Image file is too large. Maximum size is 2 MB.'), { statusCode: 400 });
  }
  const detectedMime = detectImageMimeFromBuffer(buffer);
  if (!detectedMime || !ALLOWED_IMAGE_MIMES.has(detectedMime)) {
    throw Object.assign(new Error('Only PNG, JPG, WEBP, or GIF images are supported.'), { statusCode: 400 });
  }
  return { buffer, mime: detectedMime };
}

export function normalizeStartMessage(raw) {
  const normalized = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return null;
  if (normalized.length > MAX_START_MESSAGE_LENGTH) {
    throw Object.assign(
      new Error(`Start message must be ${MAX_START_MESSAGE_LENGTH} characters or fewer.`),
      { statusCode: 400 },
    );
  }
  return normalized;
}

export function buildStartImagePreviewUrl(row) {
  if (!row) return null;
  if (row.start_image_data && ALLOWED_IMAGE_MIMES.has(row.start_image_mime)) {
    const buf = Buffer.isBuffer(row.start_image_data)
      ? row.start_image_data
      : Buffer.from(row.start_image_data);
    return `data:${row.start_image_mime};base64,${buf.toString('base64')}`;
  }
  if (row.start_image_url) {
    return row.start_image_url;
  }
  return null;
}

export function serializeStartConfig(row) {
  if (!row) return null;
  const hasUpload = Boolean(row.start_image_data);
  const hasUrl = Boolean(row.start_image_url);
  const imageMode = hasUpload ? 'upload' : hasUrl ? 'url' : 'none';
  return {
    botId: Number(row.id),
    username: row.username ?? null,
    startMessage: row.start_message ?? '',
    hasCustomStartMessage: Boolean(row.start_message || hasUpload || hasUrl),
    hasStartImage: hasUpload || hasUrl,
    imageMode,
    imageUrl: row.start_image_url ?? null,
    imageMime: row.start_image_mime ?? null,
    imagePreviewUrl: buildStartImagePreviewUrl(row),
    updatedAt: row.start_updated_at ?? null,
  };
}

export async function getDeliveryBotStartConfig(pool, botId, ownerScope = undefined) {
  const id = parsePositiveInt(botId, 'Bot ID');
  const scope = buildScopeClause(ownerScope, 2);
  const { rows } = await pool.query(
    `SELECT id, username, owner_telegram_id, start_message, start_image_url, start_image_data, start_image_mime, start_updated_at
     FROM delivery_bots
     WHERE id = $1 ${scope.clause}
     LIMIT 1`,
    [id, ...scope.params],
  );
  return rows[0] ?? null;
}

export async function getCachedDeliveryBotStartConfig(pool, botId) {
  const numericId = Number(botId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
  return cached(`${DELIVERY_BOT_CACHE_PREFIX}start:${numericId}`, 15_000, async () => {
    try {
      return await getDeliveryBotStartConfig(pool, numericId, undefined);
    } catch {
      return null;
    }
  });
}

export async function saveDeliveryBotStartConfig(pool, botId, ownerScope, payload = {}) {
  const id = parsePositiveInt(botId, 'Bot ID');
  const existing = await getDeliveryBotStartConfig(pool, id, ownerScope);
  if (!existing) return null;

  let nextMessage = null;
  let nextImageUrl = null;
  let nextImageData = null;
  let nextImageMime = null;

  if (payload.clear !== true) {
    nextMessage = normalizeStartMessage(payload.startMessage ?? payload.message);
    const mode = String(payload.imageMode || '').trim().toLowerCase();

    if (payload.removeImage === true || mode === 'none') {
      nextImageUrl = null;
      nextImageData = null;
      nextImageMime = null;
    } else if (mode === 'upload' || (typeof payload.imageDataUrl === 'string' && payload.imageDataUrl.trim())) {
      if (!payload.imageDataUrl || !String(payload.imageDataUrl).trim()) {
        throw Object.assign(new Error('Please select an image file to upload.'), { statusCode: 400 });
      }
      const parsedImg = parseUploadedStartImage(payload.imageDataUrl);
      nextImageUrl = null;
      nextImageData = parsedImg.buffer;
      nextImageMime = parsedImg.mime;
    } else if (mode === 'url' || (typeof payload.imageUrl === 'string' && payload.imageUrl.trim())) {
      const validated = validateStartImageUrl(payload.imageUrl);
      if (!validated) {
        throw Object.assign(new Error('Please enter a valid https:// image URL.'), { statusCode: 400 });
      }
      nextImageUrl = validated;
      nextImageData = null;
      nextImageMime = null;
    } else {
      nextImageUrl = existing.start_image_url ?? null;
      nextImageData = existing.start_image_data ?? null;
      nextImageMime = existing.start_image_mime ?? null;
    }

    if (!nextMessage && !nextImageUrl && !nextImageData) {
      nextImageUrl = null;
      nextImageData = null;
      nextImageMime = null;
    }
  }

  const scope = buildScopeClause(ownerScope, 6);
  const { rows } = await pool.query(
    `UPDATE delivery_bots
     SET start_message = $2,
         start_image_url = $3,
         start_image_data = $4,
         start_image_mime = $5,
         start_updated_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 ${scope.clause}
     RETURNING id, username, owner_telegram_id, start_message, start_image_url, start_image_data, start_image_mime, start_updated_at`,
    [id, nextMessage, nextImageUrl, nextImageData, nextImageMime, ...scope.params],
  );
  cacheDeletePrefix(DELIVERY_BOT_CACHE_PREFIX);
  return rows[0] ?? null;
}

export function normalizeMainBotUsername(username) {
  const clean = String(username ?? '').trim().replace(/^@+/, '');
  if (!clean || !/^[A-Za-z0-9_]{3,64}$/.test(clean)) return null;
  return clean;
}

export function buildDeliveryStartCloneMeta(mainBotUsername) {
  const cleanHandle = normalizeMainBotUsername(mainBotUsername);
  const noteHtml = cleanHandle
    ? `🤖 <i>This bot is cloned from @${escapeHtml(cleanHandle)}</i>`
    : '🤖 <i>This bot is a FileStore clone</i>';
  const replyMarkup = cleanHandle
    ? {
        reply_markup: {
          inline_keyboard: [[
            { text: '🤖 Create Clone', url: `https://t.me/${cleanHandle}?start=clone` },
          ]],
        },
      }
    : {};
  return {
    mainBotUsername: cleanHandle,
    noteHtml,
    replyMarkup,
  };
}

export function appendStartCloneNote(bodyHtml, mainBotUsername, maxLen = MAX_START_MESSAGE_LENGTH) {
  const { noteHtml } = buildDeliveryStartCloneMeta(mainBotUsername);
  const cleanBody = String(bodyHtml ?? '').trim();
  if (!cleanBody) return noteHtml;
  const separator = '\n\n';
  if (cleanBody.length + separator.length + noteHtml.length <= maxLen) {
    return `${cleanBody}${separator}${noteHtml}`;
  }
  const available = Math.max(0, maxLen - separator.length - noteHtml.length - 1);
  if (available <= 0) return noteHtml.slice(0, maxLen);
  const trimmedBody = cleanBody.slice(0, available).replace(/&[^;\s]*$/, '').trimEnd();
  return `${trimmedBody}…${separator}${noteHtml}`;
}

export function renderStartMessageText(template, ctx = {}, botInfo = null) {
  const raw = String(template ?? '').trim();
  if (!raw) return '';
  const firstName = ctx.from?.first_name ? String(ctx.from.first_name) : 'there';
  const fullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim() || firstName;
  const username = ctx.from?.username ? `@${ctx.from.username}` : firstName;
  const botName = botInfo?.first_name || (botInfo?.username ? `@${botInfo.username}` : 'Delivery Bot');

  return escapeHtml(raw)
    .replace(/\{first_name\}/gi, escapeHtml(firstName))
    .replace(/\{name\}/gi, escapeHtml(fullName))
    .replace(/\{username\}/gi, escapeHtml(username))
    .replace(/\{bot_name\}/gi, escapeHtml(botName));
}

export async function sendCustomStartMessage(
  ctx,
  startConfig,
  botInfo = null,
  logger = null,
  mainBotUsername = null,
) {
  if (!startConfig) return false;
  const renderedText = renderStartMessageText(startConfig.start_message, ctx, botInfo);
  let photoSource = null;

  if (startConfig.start_image_data) {
    const ext = MIME_TO_EXT[startConfig.start_image_mime] || '.jpg';
    const buf = Buffer.isBuffer(startConfig.start_image_data)
      ? startConfig.start_image_data
      : Buffer.from(startConfig.start_image_data);
    photoSource = { source: buf, filename: `start${ext}` };
  } else if (startConfig.start_image_url) {
    photoSource = startConfig.start_image_url;
  }

  if (!renderedText && !photoSource) return false;

  const { replyMarkup } = buildDeliveryStartCloneMeta(mainBotUsername);
  const finalText = appendStartCloneNote(renderedText, mainBotUsername, MAX_START_MESSAGE_LENGTH);

  if (photoSource && typeof ctx.replyWithPhoto === 'function') {
    const { noteHtml } = buildDeliveryStartCloneMeta(mainBotUsername);
    const combinedCaption = renderedText
      ? `${renderedText}\n\n${noteHtml}`
      : noteHtml;

    try {
      if (combinedCaption.length <= TELEGRAM_CAPTION_LIMIT) {
        await ctx.replyWithPhoto(photoSource, {
          caption: combinedCaption,
          parse_mode: 'HTML',
          ...replyMarkup,
        });
        return true;
      }
      await ctx.replyWithPhoto(photoSource);
      await ctx.reply(finalText, { parse_mode: 'HTML', ...replyMarkup });
      return true;
    } catch (error) {
      logger?.warn?.({ error: error?.message }, 'Custom /start photo send failed; falling back to text');
      await ctx.reply(
        renderedText ? finalText : appendStartCloneNote('✨ <b>Welcome!</b>', mainBotUsername, MAX_START_MESSAGE_LENGTH),
        { parse_mode: 'HTML', ...replyMarkup },
      );
      return true;
    }
  }

  await ctx.reply(finalText, { parse_mode: 'HTML', ...replyMarkup });
  return true;
}
