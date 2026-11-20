import { listRecentFiles, searchIndexedFiles, getIndexedFile, formatFileSize } from './file-query.js';

function formatRows(rows) {
  return rows.map((file, index) => `${index + 1}. ${file.file_name.slice(0, 160)}\nCode: ${file.file_code} · ${file.file_type} · ${formatFileSize(file.file_size)}`).join('\n\n');
}

export function registerFileCommands(bot, pool, logger) {
  bot.command('files', async (ctx) => {
    try {
      const rows = await listRecentFiles(pool);
      await ctx.reply(rows.length ? 'Latest indexed files\n\n' + formatRows(rows) : 'No files have been indexed yet.');
    } catch (error) {
      logger.error({ error: error.message }, 'Recent file list failed');
      await ctx.reply('Could not list files.');
    }
  });

  bot.command('find', async (ctx) => {
    const query = ctx.message?.text?.trim().split(/\s+/).slice(1).join(' ') ?? '';
    if (!query) return ctx.reply('Usage: /find <filename or file code>');
    try {
      const rows = await searchIndexedFiles(pool, query);
      await ctx.reply(rows.length ? 'Search results for: ' + query + '\n\n' + formatRows(rows) : 'No matching files found.');
    } catch (error) {
      logger.error({ error: error.message }, 'File search failed');
      await ctx.reply('Search failed.');
    }
  });

  bot.command('fileinfo', async (ctx) => {
    const code = ctx.message?.text?.trim().split(/\s+/).slice(1)[0] ?? '';
    if (!code) return ctx.reply('Usage: /fileinfo <file_code>');
    try {
      const file = await getIndexedFile(pool, code);
      if (!file) return ctx.reply('File code not found.');
      await ctx.reply(
        `File information\n\nCode: ${file.file_code}\nName: ${file.file_name}\nType: ${file.file_type}\nSize: ${formatFileSize(file.file_size)}\nMIME: ${file.mime_type ?? 'unknown'}\nStorage channel: ${file.storage_title ?? file.storage_chat_id ?? 'unknown'}\nStorage message: ${file.telegram_message_id ?? 'unknown'}`,
      );
    } catch (error) {
      logger.error({ error: error.message }, 'File info lookup failed');
      await ctx.reply('Could not retrieve file information.');
    }
  });
}
