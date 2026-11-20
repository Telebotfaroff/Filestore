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

export function registerFileIngestHandler(bot, pool, logger) {
  bot.on(['video', 'document', 'photo', 'audio', 'voice', 'video_note', 'animation'], async (ctx) => {
    const message = ctx.message;
    const metadata = extractMediaMetadata(message, 'TEMP');
    if (!metadata) return;

    const requestId = await claimIngestRequest(pool, message.chat.id, message.message_id);
    if (!requestId) return;

    let storageChannel;
    let copiedMessageId;
    try {
      const duplicate = await findDuplicateByUniqueId(pool, metadata.telegramFileUniqueId);
      if (duplicate) {
        await markIngestDuplicate(pool, requestId, duplicate.id);
        await ctx.reply(`Already indexed: ${duplicate.file_name}\nFile code: ${duplicate.file_code}`);
        return;
      }

      storageChannel = await getPrimaryStorageChannel(pool);
      if (!storageChannel) throw new Error('No tested, enabled primary storage channel. Configure one using /storage_add.');

      const copied = await ctx.telegram.copyMessage(storageChannel.telegram_chat_id, message.chat.id, message.message_id);
      copiedMessageId = copied.message_id;

      const fileCode = createFileCode();
      const finalMetadata = extractMediaMetadata(message, fileCode);
      const file = await persistIndexedFile(pool, requestId, storageChannel, copiedMessageId, finalMetadata, fileCode, ctx.from.id);
      await ctx.reply(`File indexed successfully.\n\nFile code: ${file.file_code}\nName: ${file.file_name}\nStorage: ${storageChannel.title ?? storageChannel.telegram_chat_id}`);
    } catch (error) {
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
      await ctx.reply('File indexing failed: ' + error.message);
    }
  });
}
