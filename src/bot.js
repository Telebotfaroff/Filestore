import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import { collection } from './database.js';
import { createToken, parsePayload } from './utils/tokens.js';

const bot = new Telegraf(config.botToken);
const now = () => new Date();
const isOwner = (ctx) => Number(ctx.from?.id) === config.ownerId;

function getFileInfo(message) {
  const candidates = [
    ['document', message.document],
    ['video', message.video],
    ['photo', message.photo?.at(-1)],
    ['audio', message.audio],
    ['voice', message.voice],
    ['video_note', message.video_note],
    ['animation', message.animation],
    ['sticker', message.sticker],
  ];
  const [type, media] = candidates.find(([, value]) => value) || [];
  if (!media) return null;
  return {
    fileType: type,
    fileId: media.file_id,
    fileUniqueId: media.file_unique_id,
    fileName: media.file_name || null,
    mimeType: media.mime_type || null,
    fileSize: media.file_size || null,
  };
}

function buildLink(username, prefix, token) {
  return `https://t.me/${username}?start=${prefix}_${token}`;
}

async function registerUser(ctx) {
  if (!ctx.from || ctx.from.is_bot) return;
  await collection('users').updateOne(
    { userId: ctx.from.id },
    {
      $set: {
        firstName: ctx.from.first_name || '',
        lastName: ctx.from.last_name || '',
        username: ctx.from.username || '',
        lastSeenAt: now(),
      },
      $setOnInsert: { userId: ctx.from.id, createdAt: now(), isBanned: false },
    },
    { upsert: true },
  );
}

async function isSubscribed(ctx) {
  if (!config.forceSubChannel || isOwner(ctx)) return true;
  try {
    const member = await ctx.telegram.getChatMember(config.forceSubChannel, ctx.from.id);
    return ['creator', 'administrator', 'member'].includes(member.status) ||
      (member.status === 'restricted' && member.is_member === true);
  } catch (error) {
    console.error('[fsub] Could not check membership:', error.message);
    return false;
  }
}

async function showJoinPrompt(ctx) {
  const joinUrl = config.forceSubUrl ||
    (config.forceSubChannel.startsWith('@') ? `https://t.me/${config.forceSubChannel.slice(1)}` : '');
  const rows = [];
  if (joinUrl) rows.push([Markup.button.url('📢 Join channel', joinUrl)]);
  rows.push([Markup.button.callback('✅ I have joined — check again', 'check_sub')]);
  const message = 'To use this bot, please join the required channel first.';
  if (ctx.callbackQuery) await ctx.answerCbQuery('Please join the channel first.', { show_alert: true }).catch(() => {});
  else await ctx.reply(message, Markup.inlineKeyboard(rows));
}

async function guardUser(ctx, next) {
  if (!ctx.from || ctx.from.is_bot) return next();
  try {
    await registerUser(ctx);
    const ban = await collection('bans').findOne({ userId: ctx.from.id });
    if (ban && !isOwner(ctx)) {
      if (ctx.callbackQuery) await ctx.answerCbQuery('You are blocked from using this bot.', { show_alert: true }).catch(() => {});
      else if (ctx.chat?.type === 'private') await ctx.reply('⛔ You are blocked from using this bot.');
      return;
    }
    const isCheckButton = ctx.callbackQuery?.data === 'check_sub';
    if (ctx.chat?.type === 'private' && !isCheckButton && !(await isSubscribed(ctx))) {
      await showJoinPrompt(ctx);
      return;
    }
    return next();
  } catch (error) {
    console.error('[middleware] Request failed:', error);
    if (ctx.chat?.type === 'private') await ctx.reply('Something went wrong. Please try again shortly.').catch(() => {});
  }
}

bot.use(guardUser);

bot.start(async (ctx) => {
  const parsed = parsePayload(ctx.startPayload || '');
  if (!parsed) {
    return ctx.reply(
      `👋 Hello ${ctx.from.first_name || 'there'}!\n\nSend me a file to get a permanent share link, or use /batch to create a link for multiple files.\n\nUse /help to see available commands.`,
      Markup.inlineKeyboard([
        ...(config.updatesUrl ? [[Markup.button.url('📢 Updates', config.updatesUrl)]] : []),
        ...(config.supportUrl ? [[Markup.button.url('💬 Support', config.supportUrl)]] : []),
      ]),
    );
  }

  if (parsed.type === 'F') return sendSingleFile(ctx, parsed.tokenHash);
  return sendBatch(ctx, parsed.tokenHash);
});

bot.action('check_sub', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (await isSubscribed(ctx)) {
    await ctx.editMessageText('✅ Subscription verified. Send /start again or reopen your file link.').catch(() => {});
  } else {
    await showJoinPrompt(ctx);
  }
});

bot.command('help', (ctx) => ctx.reply(
  '📚 Available commands\n\n' +
  '/start — start the bot or open a share link\n' +
  '/batch — start collecting files for one batch link\n' +
  '/done — finish the current batch and get its link\n' +
  '/cancel — cancel batch creation\n' +
  '/help — show this help\n\n' +
  'Send a file or media message to create a permanent link. During batch mode, send the files you want included and use /done when finished.',
));

bot.command('batch', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('Please create batches in a private chat with me.');
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { batchDraft: [], batchStartedAt: now() } });
  return ctx.reply('📦 Batch mode started. Send or forward the files you want to include, then use /done. Use /cancel to stop.');
});

bot.command('cancel', async (ctx) => {
  await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { batchDraft: '', batchStartedAt: '' } });
  return ctx.reply('🛑 Batch mode cancelled.');
});

bot.command('done', async (ctx) => {
  const user = await collection('users').findOne({ userId: ctx.from.id });
  const ids = user?.batchDraft || [];
  if (!ids.length) {
    await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { batchDraft: '', batchStartedAt: '' } });
    return ctx.reply('Your batch is empty. Use /batch and send some files first.');
  }
  const tokenData = createToken();
  await collection('batches').insertOne({
    tokenHash: tokenData.tokenHash,
    ownerId: ctx.from.id,
    fileIds: ids,
    createdAt: now(),
    downloads: 0,
  });
  await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { batchDraft: '', batchStartedAt: '' } });
  const me = await ctx.telegram.getMe();
  const link = buildLink(me.username, 'B', tokenData.token);
  return ctx.reply(`✅ Batch link created\n\nFiles: ${ids.length}\n\n${link}`, Markup.inlineKeyboard([[Markup.button.url('🔗 Open batch link', link)]]));
});

bot.command('stats', async (ctx) => {
  if (!isOwner(ctx)) return;
  const [users, files, batches, bans] = await Promise.all([
    collection('users').countDocuments(),
    collection('files').countDocuments(),
    collection('batches').countDocuments(),
    collection('bans').countDocuments(),
  ]);
  return ctx.reply(`📊 Filestore statistics\n\nUsers: ${users}\nFiles: ${files}\nBatches: ${batches}\nBanned users: ${bans}`);
});

bot.command('ban', async (ctx) => {
  if (!isOwner(ctx)) return;
  const userId = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return ctx.reply('Usage: /ban USER_ID');
  await collection('bans').updateOne({ userId }, { $set: { userId, bannedAt: now(), bannedBy: ctx.from.id } }, { upsert: true });
  return ctx.reply(`⛔ User ${userId} has been banned.`);
});

bot.command('unban', async (ctx) => {
  if (!isOwner(ctx)) return;
  const userId = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return ctx.reply('Usage: /unban USER_ID');
  const result = await collection('bans').deleteOne({ userId });
  return ctx.reply(result.deletedCount ? `✅ User ${userId} has been unbanned.` : 'That user was not banned.');
});

bot.command('broadcast', async (ctx) => {
  if (!isOwner(ctx)) return;
  const text = ctx.message.text.replace(/^\/broadcast(?:@\w+)?\s*/i, '').trim();
  if (!text) return ctx.reply('Usage: /broadcast Your message');
  const users = collection('users').find({ userId: { $ne: config.ownerId } }, { projection: { userId: 1 } });
  let sent = 0;
  let failed = 0;
  for await (const user of users) {
    try {
      if (await collection('bans').findOne({ userId: user.userId })) continue;
      await ctx.telegram.sendMessage(user.userId, text);
      sent++;
    } catch {
      failed++;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return ctx.reply(`📣 Broadcast finished.\nSent: ${sent}\nFailed: ${failed}`);
});

bot.on('message', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const info = getFileInfo(ctx.message);
  if (!info) {
    if (ctx.message.text && !ctx.message.text.startsWith('/')) {
      return ctx.reply('Send me a file, photo, video, audio, or other supported Telegram media to create a share link.');
    }
    return;
  }
  if (!config.privateUploadsEnabled && !isOwner(ctx)) {
    return ctx.reply('File uploads are currently disabled by the bot owner.');
  }

  const user = await collection('users').findOne({ userId: ctx.from.id });
  const inBatch = Array.isArray(user?.batchDraft);
  const status = await ctx.reply(inBatch ? '📥 Adding this file to your batch…' : '📥 Saving your file…');

  try {
    const stored = await ctx.telegram.copyMessage(config.dbChannelId, ctx.chat.id, ctx.message.message_id);
    const tokenData = createToken();
    const fileDoc = {
      tokenHash: tokenData.tokenHash,
      storageMessageId: stored.message_id,
      fileType: info.fileType,
      fileName: info.fileName,
      mimeType: info.mimeType,
      fileSize: info.fileSize,
      ownerId: ctx.from.id,
      createdAt: now(),
      downloads: 0,
    };
    const inserted = await collection('files').insertOne(fileDoc);

    if (inBatch) {
      await collection('users').updateOne(
        { userId: ctx.from.id },
        { $push: { batchDraft: inserted.insertedId } },
      );
      const count = (user.batchDraft || []).length + 1;
      return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `✅ Added to batch (${count} file${count === 1 ? '' : 's'}). Send more files or use /done.`);
    }

    const me = await ctx.telegram.getMe();
    const link = buildLink(me.username, 'F', tokenData.token);
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `✅ File saved successfully!\n\nType: ${info.fileType}${info.fileName ? `\nName: ${info.fileName}` : ''}${info.fileSize ? `\nSize: ${formatBytes(info.fileSize)}` : ''}\n\nPermanent link:\n${link}`,
      { reply_markup: Markup.inlineKeyboard([[Markup.button.url('🔗 Open file link', link)]]).reply_markup },
    );
  } catch (error) {
    console.error('[upload] Failed:', error);
    return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '❌ Could not save this file. Please check that the bot is an administrator in the storage channel and try again.').catch(() => {});
  }
});

async function sendSingleFile(ctx, tokenHash) {
  const file = await collection('files').findOne({ tokenHash });
  if (!file) return ctx.reply('❌ This link is invalid or the file is no longer available.');
  try {
    await ctx.telegram.copyMessage(ctx.chat.id, config.dbChannelId, file.storageMessageId);
    await collection('files').updateOne({ _id: file._id }, { $inc: { downloads: 1 }, $set: { lastAccessedAt: now() } });
  } catch (error) {
    console.error('[retrieve] Single file failed:', error.message);
    return ctx.reply('❌ I could not retrieve this file. It may have been removed from the storage channel.');
  }
}

async function sendBatch(ctx, tokenHash) {
  const batch = await collection('batches').findOne({ tokenHash });
  if (!batch) return ctx.reply('❌ This batch link is invalid or no longer available.');
  if (!batch.fileIds?.length) return ctx.reply('This batch is empty.');
  if (batch.fileIds.length > 100) return ctx.reply('This batch is too large to send in one request. Please contact the owner.');
  let sent = 0;
  for (const id of batch.fileIds) {
    const file = await collection('files').findOne({ _id: id });
    if (!file) continue;
    try {
      await ctx.telegram.copyMessage(ctx.chat.id, config.dbChannelId, file.storageMessageId);
      await collection('files').updateOne({ _id: file._id }, { $inc: { downloads: 1 }, $set: { lastAccessedAt: now() } });
      sent++;
    } catch (error) {
      console.error('[retrieve] Batch item failed:', error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  await collection('batches').updateOne({ _id: batch._id }, { $inc: { downloads: 1 }, $set: { lastAccessedAt: now() } });
  if (!sent) return ctx.reply('❌ None of the files in this batch could be retrieved.');
  return ctx.reply(`✅ Batch delivered: ${sent} of ${batch.fileIds.length} files.`);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

bot.catch((error, ctx) => {
  console.error(`[bot] Update ${ctx.update?.update_id ?? 'unknown'} failed:`, error);
});

export default bot;
