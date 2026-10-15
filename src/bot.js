import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import { collection } from './database.js';
import { createToken, parsePayload } from './utils/tokens.js';
import { hashPassword, verifyPassword } from './security.js';
import { getAutoDeleteSeconds } from './maintenance.js';
import { createShortenerLink, needsVerification, shortenerEnabled } from './shortener.js';

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

  if (await needsVerification(ctx.from.id)) {
    const me = await ctx.telegram.getMe();
    const destination = buildLink(me.username, parsed.type, parsed.token);
    try {
      const shortUrl = await createShortenerLink(ctx.from.id, destination);
      if (shortUrl) {
        return ctx.reply(
          '🔐 Please complete the link verification to access files. After completing it, reopen your original file link. Verification lasts 6 hours.',
          Markup.inlineKeyboard([[Markup.button.url('✅ Verify and continue', shortUrl)]]),
        );
      }
    } catch (error) {
      console.error('[shortener] Could not create verification link:', error.message);
      return ctx.reply('Verification is temporarily unavailable. Please try again later.');
    }
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
  '/setpassword PASSWORD — protect your next file or batch link\n' +
  '/clearpasword — clear a pending password\n' +
  '/premium — buy 30 days of premium with Telegram Stars\n' +
  '/help — show this help\n\n' +
  'Send a file or media message to create a permanent link. During batch mode, send the files you want included and use /done when finished.',
));


bot.command('setpassword', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('Please set passwords in a private chat.');
  const password = ctx.message.text.replace(/^\/setpassword(?:@\w+)?\s*/i, '').trim();
  if (!password) return ctx.reply('Usage: /setpassword YOUR_PASSWORD\nThe password will protect your next single-file link, or the batch link if you are in batch mode.');
  try {
    const passwordHash = hashPassword(password);
    await collection('users').updateOne({ userId: ctx.from.id }, { $set: { pendingPasswordHash: passwordHash } });
    return ctx.reply('🔐 Password saved for your next file link or batch link. It is stored as a salted hash, not plain text.');
  } catch (error) {
    return ctx.reply(error.message);
  }
});

bot.command('clearpasword', async (ctx) => {
  await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingPasswordHash: '' } });
  return ctx.reply('Pending link password cleared.');
});

bot.command('autodelete', async (ctx) => {
  if (!isOwner(ctx)) return;
  const arg = ctx.message.text.split(/\s+/)[1];
  if (arg === undefined) {
    const seconds = await getAutoDeleteSeconds();
    return ctx.reply(`🧹 Auto-delete is currently ${seconds ? `enabled for ${seconds} seconds` : 'disabled'} for newly uploaded files.\n\nUsage: /autodelete SECONDS\nUse 0 to disable auto-delete for new uploads.`);
  }
  const seconds = Number(arg);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 31_536_000) {
    return ctx.reply('Usage: /autodelete SECONDS (0 to disable; maximum 31536000 seconds / 365 days).');
  }
  await collection('settings').updateOne(
    { key: 'autoDeleteSeconds' },
    { $set: { key: 'autoDeleteSeconds', value: seconds, updatedAt: now(), updatedBy: ctx.from.id } },
    { upsert: true },
  );
  return ctx.reply(seconds ? `🧹 Auto-delete set to ${seconds} seconds for new uploads.` : '🧹 Auto-delete disabled for new uploads. Existing expiry times are unchanged.');
});

bot.command('premium', async (ctx) => {
  const price = config.starsPrice;
  const days = config.starsDays;
  return ctx.replyWithInvoice(
    `Filestore Premium — ${days} days`,
    `Premium access for ${days} days. Premium users bypass configured shortener verification.`,
    `premium_${days}d_${ctx.from.id}`,
    '',
    'XTR',
    [{ label: `Premium ${days} days`, amount: price }],
    { start_parameter: 'premium', provider_token: '' },
  );
});

bot.on('pre_checkout_query', async (ctx) => {
  const query = ctx.update.pre_checkout_query;
  const expected = `premium_${config.starsDays}d_${query.from.id}`;
  if (query.currency !== 'XTR' || query.invoice_payload !== expected) {
    return ctx.answerPreCheckoutQuery(false, 'This payment invoice is invalid or expired.');
  }
  return ctx.answerPreCheckoutQuery(true);
});

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
  const autoDeleteSeconds = await getAutoDeleteSeconds();
  const batchDoc = {
    tokenHash: tokenData.tokenHash,
    ownerId: ctx.from.id,
    fileIds: ids,
    passwordHash: user.pendingPasswordHash || null,
    createdAt: now(),
    downloads: 0,
  };
  if (autoDeleteSeconds > 0) batchDoc.expiresAt = new Date(Date.now() + autoDeleteSeconds * 1000);
  await collection('batches').insertOne(batchDoc);
  await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { batchDraft: '', batchStartedAt: '', pendingPasswordHash: '' } });
  const me = await ctx.telegram.getMe();
  const link = buildLink(me.username, 'B', tokenData.token);
  return ctx.reply(`✅ Batch link created\n\nFiles: ${ids.length}\n\n${link}`, Markup.inlineKeyboard([[Markup.button.url('🔗 Open batch link', link)]]));
});

bot.command('stats', async (ctx) => {
  if (!isOwner(ctx)) return;
  const [users, files, batches, bans, payments] = await Promise.all([
    collection('users').countDocuments(),
    collection('files').countDocuments(),
    collection('batches').countDocuments(),
    collection('bans').countDocuments(),
    collection('payments').countDocuments(),
  ]);
  return ctx.reply(`📊 Filestore statistics\n\nUsers: ${users}\nFiles: ${files}\nBatches: ${batches}\nBanned users: ${bans}\nStar payments: ${payments}`);
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

  if (ctx.message.successful_payment) {
    const payment = ctx.message.successful_payment;
    const expectedPayload = `premium_${config.starsDays}d_${ctx.from.id}`;
    if (payment.currency !== 'XTR' || payment.invoice_payload !== expectedPayload) {
      return ctx.reply('❌ Payment details did not match this account. Please contact support.');
    }
    try {
      await collection('payments').insertOne({
        telegramPaymentChargeId: payment.telegram_payment_charge_id,
        providerPaymentChargeId: payment.provider_payment_charge_id || null,
        userId: ctx.from.id,
        currency: payment.currency,
        totalAmount: payment.total_amount,
        payload: payment.invoice_payload,
        createdAt: now(),
      });
    } catch (error) {
      if (error?.code === 11000) return ctx.reply('✅ This payment has already been processed.');
      throw error;
    }
    const user = await collection('users').findOne({ userId: ctx.from.id }, { projection: { premiumUntil: 1 } });
    const base = user?.premiumUntil && user.premiumUntil > now() ? user.premiumUntil : now();
    const premiumUntil = new Date(base.getTime() + config.starsDays * 24 * 60 * 60 * 1000);
    await collection('users').updateOne({ userId: ctx.from.id }, { $set: { premiumUntil } });
    return ctx.reply(`🎉 Payment successful! Premium is active until ${premiumUntil.toUTCString()}.`);
  }

  if (ctx.message.text) {
    const userWithUnlock = await collection('users').findOne({ userId: ctx.from.id }, { projection: { pendingUnlock: 1 } });
    const pending = userWithUnlock?.pendingUnlock;
    if (pending) {
      if (pending.expiresAt <= now()) {
        await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingUnlock: '' } });
        return ctx.reply('This password request expired. Open the share link again.');
      }
      if (ctx.message.text.startsWith('/')) return ctx.reply('Enter the link password as a normal message, or reopen the share link.');
      const target = pending.type === 'F'
        ? await collection('files').findOne({ tokenHash: pending.tokenHash })
        : await collection('batches').findOne({ tokenHash: pending.tokenHash });
      if (!target || !target.passwordHash) {
        await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingUnlock: '' } });
        return ctx.reply('This protected link is no longer available. Please reopen the link.');
      }
      if (!verifyPassword(ctx.message.text, target.passwordHash)) {
        const attempts = (pending.attempts || 0) + 1;
        if (attempts >= 5) {
          await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingUnlock: '' } });
          return ctx.reply('❌ Too many incorrect attempts. Reopen the share link to try again.');
        }
        await collection('users').updateOne({ userId: ctx.from.id }, { $set: { 'pendingUnlock.attempts': attempts } });
        return ctx.reply(`❌ Incorrect password. Attempts remaining: ${5 - attempts}.`);
      }
      await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingUnlock: '' } });
      if (pending.type === 'F') return sendSingleFile(ctx, pending.tokenHash, { unlocked: true });
      return sendBatch(ctx, pending.tokenHash, { unlocked: true });
    }
  }

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
    const autoDeleteSeconds = await getAutoDeleteSeconds();
    const fileDoc = {
      tokenHash: tokenData.tokenHash,
      storageMessageId: stored.message_id,
      fileType: info.fileType,
      fileName: info.fileName,
      mimeType: info.mimeType,
      fileSize: info.fileSize,
      ownerId: ctx.from.id,
      passwordHash: inBatch ? null : (user?.pendingPasswordHash || null),
      createdAt: now(),
      downloads: 0,
    };
    if (autoDeleteSeconds > 0) fileDoc.expiresAt = new Date(Date.now() + autoDeleteSeconds * 1000);
    const inserted = await collection('files').insertOne(fileDoc);
    if (!inBatch && user?.pendingPasswordHash) {
      await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingPasswordHash: '' } });
    }

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

async function sendSingleFile(ctx, tokenHash, options = {}) {
  const file = await collection('files').findOne({ tokenHash });
  if (!file) return ctx.reply('❌ This link is invalid or the file is no longer available.');
  if (file.expiresAt && file.expiresAt <= now()) return ctx.reply('⌛ This file link has expired.');
  if (file.passwordHash && !options.unlocked) {
    await collection('users').updateOne(
      { userId: ctx.from.id },
      { $set: { pendingUnlock: { type: 'F', tokenHash, attempts: 0, expiresAt: new Date(Date.now() + 10 * 60 * 1000) } } },
    );
    return ctx.reply('🔐 This file is password-protected. Send the password in your next message (valid for 10 minutes).');
  }
  try {
    await ctx.telegram.copyMessage(ctx.chat.id, config.dbChannelId, file.storageMessageId);
    await collection('files').updateOne({ _id: file._id }, { $inc: { downloads: 1 }, $set: { lastAccessedAt: now() } });
  } catch (error) {
    console.error('[retrieve] Single file failed:', error.message);
    return ctx.reply('❌ I could not retrieve this file. It may have been removed from the storage channel.');
  }
}

async function sendBatch(ctx, tokenHash, options = {}) {
  const batch = await collection('batches').findOne({ tokenHash });
  if (!batch) return ctx.reply('❌ This batch link is invalid or no longer available.');
  if (batch.expiresAt && batch.expiresAt <= now()) return ctx.reply('⌛ This batch link has expired.');
  if (batch.passwordHash && !options.unlocked) {
    await collection('users').updateOne(
      { userId: ctx.from.id },
      { $set: { pendingUnlock: { type: 'B', tokenHash, attempts: 0, expiresAt: new Date(Date.now() + 10 * 60 * 1000) } } },
    );
    return ctx.reply('🔐 This batch is password-protected. Send the password in your next message (valid for 10 minutes).');
  }
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
