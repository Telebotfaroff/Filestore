import { createFileCode } from './file-code.js';
import { extractMediaMetadata } from './media-metadata.js';
import { escapeHtml } from '../bot/telegram-utils.js';
import {
  claimIngestRequest,
  findDuplicateByUniqueId,
  markIngestDuplicate,
  markIngestFailed,
  getPrimaryStorageChannel,
  persistIndexedFile,
} from './ingest-repository.js';

async function replySafely(ctx, text, logger, details = {}, extra = {}) {
  try { await ctx.reply(text, extra); } catch (error) {
    logger.warn({ ...details, error: error.message }, 'File ingest status message could not be sent');
  }
}

export async function ingestTelegramMedia(ctx, pool, logger) {
  const message = ctx.message;
  const metadata = extractMediaMetadata(message, 'TEMP');
  if (!metadata) return { status: 'ignored', file: null, storageChannel: null };

  const requestId = await claimIngestRequest(pool, message.chat.id, message.message_id);
  if (!requestId) return { status: 'ignored', file: null, storageChannel: null };

  let storageChannel;
  let copiedMessageId;
  const uploaderId = ctx.from?.id ?? null;
  try {
    const duplicate = await findDuplicateByUniqueId(pool, metadata.telegramFileUniqueId, uploaderId);
    if (duplicate) {
      await markIngestDuplicate(pool, requestId, duplicate.id);
      return { status: 'duplicate', file: duplicate, storageChannel: null, requestId };
    }

    storageChannel = await getPrimaryStorageChannel(pool, uploaderId);
    if (!storageChannel) throw new Error('No enabled storage channel found. Add your own Telegram channel in Control Center -> My Storage Channel (or /storage_add).');

    const copied = await ctx.telegram.copyMessage(storageChannel.telegram_chat_id, message.chat.id, message.message_id);
    copiedMessageId = copied.message_id;

    const fileCode = createFileCode();
    const finalMetadata = extractMediaMetadata(message, fileCode);
    const indexedFile = await persistIndexedFile(pool, requestId, storageChannel, copiedMessageId, finalMetadata, fileCode, uploaderId);
    return { status: 'indexed', file: indexedFile, storageChannel, requestId };
  } catch (error) {
    if (error.code === '23505' && metadata.telegramFileUniqueId) {
      try {
        const duplicate = await findDuplicateByUniqueId(pool, metadata.telegramFileUniqueId, uploaderId);
        if (duplicate) {
          if (copiedMessageId !== undefined && storageChannel) {
            try { await ctx.telegram.deleteMessage(storageChannel.telegram_chat_id, copiedMessageId); } catch {}
          }
          await markIngestDuplicate(pool, requestId, duplicate.id);
          return { status: 'duplicate', file: duplicate, storageChannel: null, requestId };
        }
      } catch (lookupError) {
        logger.error({ ingestId: requestId, error: lookupError.message }, 'Duplicate reconciliation failed');
      }
    }

    if (copiedMessageId !== undefined && storageChannel) {
      try {
        await ctx.telegram.deleteMessage(storageChannel.telegram_chat_id, copiedMessageId);
      } catch (cleanupError) {
        logger.warn({ channelId: storageChannel.telegram_chat_id, messageId: copiedMessageId, error: cleanupError.message }, 'Failed to clean orphan storage message after ingest error');
      }
    }
    try { await markIngestFailed(pool, requestId, error.message); } catch (dbError) {
      logger.error({ ingestId: requestId, error: dbError.message }, 'Failed to mark ingest request as failed');
    }
    logger.error({ ingestId: requestId, error: error.message }, 'File indexing failed');
    throw error;
  }
}

export function registerFileIngestHandler(bot, pool, logger) {
  bot.on(['video', 'document', 'photo', 'audio', 'voice', 'video_note', 'animation'], async (ctx) => {
    let result;
    try {
      result = await ingestTelegramMedia(ctx, pool, logger);
    } catch (error) {
      return replySafely(ctx, '❌ <b>File Indexing Failed</b>\n\n' + escapeHtml(error.message), logger, {}, { parse_mode: 'HTML' });
    }
    if (result.status === 'ignored' || !result.file) return;

    const quickKeyboard = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔗 Generate Share Link', callback_data: `cc:mklink:${result.file.file_code}` },
            { text: '✏ Rename File', callback_data: `cc:frename:${result.file.file_code}` },
          ],
          [{ text: '📄 File Details', callback_data: `cc:file:${result.file.file_code}` }],
        ],
      },
    };

    if (result.status === 'duplicate') {
      return replySafely(
        ctx,
        [
          '♻️ <b>File Already Indexed</b>',
          '━━━━━━━━━━━━━━━━━━',
          '',
          `📄 <b>Name:</b> ${escapeHtml(result.file.file_name)}`,
          `🏷 <b>File Code:</b> <code>${escapeHtml(result.file.file_code)}</code>`,
          '',
          '💡 <i>Tap a button below to generate a share link or view details.</i>',
        ].join('\n'),
        logger,
        { ingestId: result.requestId },
        quickKeyboard,
      );
    }

    const storageLabel = result.storageChannel?.title ?? result.storageChannel?.telegram_chat_id;
    return replySafely(
      ctx,
      [
        '✅ <b>File Indexed Successfully!</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `🏷 <b>File Code:</b> <code>${escapeHtml(result.file.file_code)}</code>`,
        `📄 <b>Name:</b> ${escapeHtml(result.file.file_name)}`,
        `📦 <b>Storage:</b> ${escapeHtml(storageLabel)}`,
        '',
        '🚀 <i>Ready to share! Tap below to create a link, or use <code>/plink</code> to sell it.</i>',
      ].join('\n'),
      logger,
      { fileCode: result.file.file_code },
      quickKeyboard,
    );
  });
}
