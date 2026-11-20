import { createFileCode } from './file-code.js';
import { extractMediaMetadata } from './media-metadata.js';
import {
  claimIngestRequest,
  findDuplicateByUniqueId,
  markIngestDuplicate,
  markIngestFailed,
  getPrimaryStorageChannel,
  persistIndexedFile,
} from './ingest-repository.js';

async function replySafely(ctx, text, logger, details = {}) {
  try { await ctx.reply(text); } catch (error) {
    logger.warn({ ...details, error: error.message }, 'File ingest status message could not be sent');
  }
}

export function registerFileIngestHandler(bot, pool, logger) {
  bot.on(['video', 'document', 'photo', 'audio', 'voice', 'video_note', 'animation'], async (ctx) => {
    const message = ctx.message;
    const metadata = extractMediaMetadata(message, 'TEMP');
    if (!metadata) return;

    const requestId = await claimIngestRequest(pool, message.chat.id, message.message_id);
    if (!requestId) return;

    let storageChannel;
    let copiedMessageId;
    let indexedFile;
    try {
      const duplicate = await findDuplicateByUniqueId(pool, metadata.telegramFileUniqueId);
      if (duplicate) {
        await markIngestDuplicate(pool, requestId, duplicate.id);
        return replySafely(ctx, `Already indexed: ${duplicate.file_name}\nFile code: ${duplicate.file_code}`, logger, { ingestId: requestId });
      }

      storageChannel = await getPrimaryStorageChannel(pool);
      if (!storageChannel) throw new Error('No tested, enabled primary storage channel. Configure one using /storage_add.');

      const copied = await ctx.telegram.copyMessage(storageChannel.telegram_chat_id, message.chat.id, message.message_id);
      copiedMessageId = copied.message_id;

      const fileCode = createFileCode();
      const finalMetadata = extractMediaMetadata(message, fileCode);
      indexedFile = await persistIndexedFile(pool, requestId, storageChannel, copiedMessageId, finalMetadata, fileCode, ctx.from.id);
    } catch (error) {
      if (error.code === '23505' && metadata.telegramFileUniqueId) {
        try {
          const duplicate = await findDuplicateByUniqueId(pool, metadata.telegramFileUniqueId);
          if (duplicate) {
            if (copiedMessageId !== undefined && storageChannel) {
              try { await ctx.telegram.deleteMessage(storageChannel.telegram_chat_id, copiedMessageId); } catch {}
            }
            await markIngestDuplicate(pool, requestId, duplicate.id);
            return replySafely(ctx, `Already indexed: ${duplicate.file_name}\nFile code: ${duplicate.file_code}`, logger, { ingestId: requestId });
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
      return replySafely(ctx, 'File indexing failed: ' + error.message, logger, { ingestId: requestId });
    }

    return replySafely(ctx, `File indexed successfully.\n\nFile code: ${indexedFile.file_code}\nName: ${indexedFile.file_name}\nStorage: ${storageChannel.title ?? storageChannel.telegram_chat_id}`, logger, { fileCode: indexedFile.file_code });
  });
}
