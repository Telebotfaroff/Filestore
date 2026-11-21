import { isAdmin } from '../bot/admin-guard.js';
import { listRecentFiles, searchIndexedFiles, getIndexedFile, formatFileSize } from './file-query.js';
import { getCommandArgs, getCommandArgText } from '../bot/telegram-utils.js';

function formatRows(rows) {
  return rows.map((file, index) => `${index + 1}. 📄 ${file.file_name.slice(0, 160)}\n   🔑 ${file.file_code} · ${file.file_type} · ${formatFileSize(file.file_size)}`).join('\n\n');
}

export function registerFileCommands(bot, pool, logger, config = null) {
  const scopeOwner = (ctx) => (Array.isArray(config?.adminIds) && !isAdmin(ctx.from?.id, config.adminIds) ? Number(ctx.from.id) : null);

  bot.command('files', async (ctx) => {
    try {
      const ownerId = scopeOwner(ctx);
      const rows = await listRecentFiles(pool, 8, ownerId);
      await ctx.reply(
        rows.length
          ? `${ownerId ? '📁 Your Latest Indexed Files' : '📁 Latest Indexed Files'}\n━━━━━━━━━━━━━━━━━━\n${formatRows(rows)}`
          : '📂 No files have been indexed yet.\n💡 Send or forward any media here to index it!',
      );
    } catch (error) {
      logger.error({ error: error.message }, 'Recent file list failed');
      await ctx.reply('❌ Could not list files.');
    }
  });

  bot.command('find', async (ctx) => {
    const query = getCommandArgText(ctx);
    if (!query) return ctx.reply('ℹ️ Usage: /find <filename or file code>');
    try {
      const rows = await searchIndexedFiles(pool, query, 8, scopeOwner(ctx));
      await ctx.reply(
        rows.length
          ? `🔍 Search results for: ${query}\n━━━━━━━━━━━━━━━━━━\n${formatRows(rows)}`
          : `🔍 No matching files found for "${query}".`,
      );
    } catch (error) {
      logger.error({ error: error.message }, 'File search failed');
      await ctx.reply('❌ Search failed.');
    }
  });

  bot.command('fileinfo', async (ctx) => {
    const code = getCommandArgs(ctx)[0] ?? '';
    if (!code) return ctx.reply('ℹ️ Usage: /fileinfo <file_code>');
    try {
      const file = await getIndexedFile(pool, code, scopeOwner(ctx));
      if (!file) return ctx.reply('❌ File code not found.');
      await ctx.reply(
        `📄 File Information\n━━━━━━━━━━━━━━━━━━\n🔑 Code: ${file.file_code}\n🏷 Name: ${file.file_name}\n🗂 Type: ${file.file_type}\n💾 Size: ${formatFileSize(file.file_size)}\n📎 MIME: ${file.mime_type ?? 'unknown'}\n🗄 Storage: ${file.storage_title ?? file.storage_chat_id ?? 'unknown'}\n💬 Msg ID: ${file.telegram_message_id ?? 'unknown'}`,
      );
    } catch (error) {
      logger.error({ error: error.message }, 'File info lookup failed');
      await ctx.reply('❌ Could not retrieve file information.');
    }
  });
}
