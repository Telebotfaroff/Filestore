import { Telegraf, Markup } from 'telegraf';
import { config } from './config.js';
import { collection } from './database.js';
import { createToken, parsePayload } from './utils/tokens.js';
import { hashPassword, verifyPassword } from './security.js';
import { getAutoDeleteSeconds } from './maintenance.js';
import { createShortenerLink, needsVerification, shortenerEnabled } from './shortener.js';

const bot = new Telegraf(config.botToken);
const autoAlbumBuffers = new Map();
const now = () => new Date();
const isOwner = (ctx) => Number(ctx.from?.id) === config.ownerId;
const isAdmin = (ctx) => config.adminIds.includes(Number(ctx.from?.id));
const adminOnlyMessage = '⛔ Only bot admins can create file or batch links. You can still open links shared with you.';

function mainMenu(ctx) {
  return Markup.inlineKeyboard([
    ...(isAdmin(ctx) ? [
      [Markup.button.callback('📤 Create file link', 'menu:file'), Markup.button.callback('📦 Create batch', 'menu:batch')],
      [Markup.button.callback('🔐 Password settings', 'menu:password')],
      [Markup.button.callback('🖼 Create post', 'menu:post'), Markup.button.callback('📢 Posting channels', 'post:channels:manage')],
    ] : []),
    [Markup.button.callback('⭐ Premium', 'menu:premium'), Markup.button.callback('❔ Help', 'menu:help')],
    ...(isOwner(ctx) ? [[Markup.button.callback('🛠 Admin panel', 'menu:admin')]] : []),
    ...(config.updatesUrl ? [[Markup.button.url('📢 Updates', config.updatesUrl)]] : []),
    ...(config.supportUrl ? [[Markup.button.url('💬 Support', config.supportUrl)]] : []),
  ]);
}
function adminMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Statistics', 'admin:stats'), Markup.button.callback('🧹 Auto-delete', 'admin:auto')],
    [Markup.button.callback('📣 Broadcast', 'admin:broadcast')],
    [Markup.button.callback('🔒 Force subscription', 'fsub:manage')],
    [Markup.button.callback('🏠 Main menu', 'menu:home')],
  ]);
}
async function showMainMenu(ctx, edit = false) {
  const text = `👋 Welcome to Filestore, ${ctx.from.first_name || 'there'}!\n\n${isAdmin(ctx) ? 'Use the buttons below to create file links, batches, and password-protected links.' : 'You can open links shared with you. Link creation is restricted to admins.'}`;
  if (edit && ctx.callbackQuery) return ctx.editMessageText(text, mainMenu(ctx)).catch(() => {});
  return ctx.reply(text, mainMenu(ctx));
}
async function sendPremiumInvoice(ctx) {
  const price = config.starsPrice, days = config.starsDays;
  return ctx.replyWithInvoice({
    title: `Filestore Premium — ${days} days`,
    description: `Premium access for ${days} days. Premium users bypass configured shortener verification.`,
    payload: `premium_${days}d_${ctx.from.id}`,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: `Premium ${days} days`, amount: price }],
    start_parameter: 'premium',
  });
}


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


async function getPostChannels() {
  const saved = await collection('settings').findOne({ key: 'postChannels' });
  return Array.isArray(saved?.channels) ? saved.channels : [];
}

function postChannelsKeyboard(channels) {
  const rows = channels.map((channel) => [
    Markup.button.callback('📢 ' + String(channel.title || channel.username || channel.chatId).slice(0, 35), 'post:channel:' + encodeURIComponent(String(channel.chatId))),
  ]);
  rows.push([Markup.button.callback('🛠 Manage channels', 'post:channels:manage')]);
  rows.push([Markup.button.callback('🛑 Cancel post', 'post:cancel')]);
  return Markup.inlineKeyboard(rows);
}

async function promptPostChannels(ctx) {
  const channels = await getPostChannels();
  if (!channels.length) {
    return ctx.reply('⚠️ No posting channels configured yet. Use /channels to add a channel, then return to /post.', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Configure channels', 'post:channels:manage')],
      [Markup.button.callback('🛑 Cancel post', 'post:cancel')],
    ]));
  }
  return ctx.reply('📢 Choose which configured channel should receive this post:', postChannelsKeyboard(channels));
}

async function processAutoAlbum(ctx, messages) {
  const userId = ctx.from.id;
  const user = await collection('users').findOne({ userId }, { projection: { pendingAutoAlbum: 1 } });
  if (!user?.pendingAutoAlbum) return;

  await collection('users').updateOne({ userId }, { $unset: { pendingAutoAlbum: '' } });
  const album = [...messages].sort((a, b) => a.message_id - b.message_id);
  const photos = album.filter((message) => Array.isArray(message.photo) && message.photo.length);
  const videos = album.filter((message) =>
    Boolean(message.video) ||
    Boolean(message.document && String(message.document.mime_type || '').startsWith('video/')),
  );
  const captionMessage = album.find((message) => typeof message.caption === 'string' && message.caption.trim());
  const title = captionMessage?.caption.trim() || '';

  if (photos.length !== 1 || !videos.length) {
    return ctx.reply('❌ Album format not recognized. Send exactly one thumbnail photo and at least one video in the same media group, then run /auto again.');
  }
  if (!title) {
    return ctx.reply('❌ Please add the post title as the caption on your thumbnail (or another item in the album). Run /auto again and resend the album with a caption.');
  }
  if (title.length > 900) {
    return ctx.reply('❌ The title/caption must be 900 characters or fewer. Run /auto again with a shorter caption.');
  }

  const savedVideos = [];
  try {
    for (const message of videos) {
      const info = getFileInfo(message);
      const stored = await ctx.telegram.copyMessage(config.dbChannelId, ctx.chat.id, message.message_id);
      savedVideos.push({
        storageMessageId: stored.message_id,
        fileType: info?.fileType || 'video',
        fileName: info?.fileName || null,
        mimeType: info?.mimeType || null,
        fileSize: info?.fileSize || null,
      });
    }
  } catch (error) {
    console.error('[auto] Album video storage failed:', error.message);
    for (const video of savedVideos) {
      await ctx.telegram.deleteMessage(config.dbChannelId, video.storageMessageId).catch(() => {});
    }
    return ctx.reply('❌ Could not save every video. Check that the bot can post in the private storage channel, then run /auto again.');
  }

  await collection('users').updateOne(
    { userId },
    {
      $set: {
        postDraft: {
          step: 'pricing',
          title,
          thumbnailFileId: photos[0].photo.at(-1).file_id,
          videoFiles: savedVideos,
          createdAt: now(),
        },
      },
      $unset: { pendingAutoAlbum: '' },
    },
  );

  return ctx.reply(
    `✅ Album processed! Saved ${savedVideos.length} video(s). Choose pricing for this post:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🆓 Free post', 'post:pricing:free')],
      [Markup.button.callback('⭐ Paid post', 'post:pricing:paid')],
      [Markup.button.callback('🛑 Cancel', 'post:cancel')],
    ]),
  );
}

async function sendPostVideos(ctx, post) {
  const hashes = Array.isArray(post.fileTokenHashes) && post.fileTokenHashes.length
    ? post.fileTokenHashes
    : (post.fileTokenHash ? [post.fileTokenHash] : []);
  if (!hashes.length) return ctx.reply('❌ This post has no videos available.');
  let sent = 0;
  for (const tokenHash of hashes) {
    const file = await collection('files').findOne({ tokenHash });
    if (!file) continue;
    try {
      await ctx.telegram.copyMessage(ctx.chat.id, config.dbChannelId, file.storageMessageId);
      await collection('files').updateOne({ _id: file._id }, { $inc: { downloads: 1 }, $set: { lastAccessedAt: now() } });
      sent++;
    } catch (error) {
      console.error('[post] Video delivery failed:', error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!sent) return ctx.reply('❌ None of the videos in this post could be retrieved.');
  if (sent < hashes.length) return ctx.reply(`⚠️ Delivered ${sent} of ${hashes.length} videos. Some files may have been removed.`);
  if (hashes.length > 1) return ctx.reply(`✅ Delivered all ${sent} videos.`);
}

async function sendPost(ctx, tokenHash) {
  const post = await collection('posts').findOne({ tokenHash });
  if (!post) return ctx.reply('❌ This post link is invalid or no longer available.');
  if (post.stars > 0 && !(post.paidUsers || []).includes(ctx.from.id)) {
    return ctx.replyWithInvoice({
      title: ('🔒 ' + post.title).slice(0, 32),
      description: 'Pay ' + post.stars + ' Telegram Stars to unlock all videos in this post.',
      payload: 'post_' + post.tokenHash,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Video access', amount: post.stars }],
      start_parameter: 'post',
    });
  }
  return sendPostVideos(ctx, post);
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

async function getForceSubConfig() {
  const saved = await collection('settings').findOne({ key: 'forceSubConfig' });
  if (saved) return { enabled: saved.enabled === true, channels: Array.isArray(saved.channels) ? saved.channels : [] };
  const legacy = config.forceSubChannel;
  return {
    enabled: Boolean(legacy),
    channels: legacy ? [{
      chatId: /^-?\d+$/.test(legacy) ? Number(legacy) : legacy,
      title: legacy,
      username: legacy.startsWith('@') ? legacy.slice(1) : null,
      url: config.forceSubUrl || (legacy.startsWith('@') ? `https://t.me/${legacy.slice(1)}` : ''),
    }] : [],
  };
}

async function saveForceSubConfig(data, userId) {
  await collection('settings').updateOne(
    { key: 'forceSubConfig' },
    { $set: { key: 'forceSubConfig', enabled: Boolean(data.enabled), channels: data.channels || [], updatedAt: now(), updatedBy: userId } },
    { upsert: true },
  );
}

function forceSubKeyboard(data) {
  const rows = [[Markup.button.callback(data.enabled ? '🟢 Enabled — turn off' : '⚪ Disabled — turn on', 'fsub:toggle')]];
  rows.push([Markup.button.callback('➕ Add required channel', 'fsub:add')]);
  for (const channel of data.channels) {
    rows.push([Markup.button.callback('❌ Remove ' + String(channel.title || channel.username || channel.chatId).slice(0, 30), 'fsub:remove:' + encodeURIComponent(String(channel.chatId)))]);
  }
  rows.push([Markup.button.callback('↩ Admin panel', 'menu:admin')]);
  return Markup.inlineKeyboard(rows);
}

async function showForceSubSettings(ctx) {
  const data = await getForceSubConfig();
  const status = data.enabled ? 'ON' : 'OFF';
  const list = data.channels.length
    ? data.channels.map((channel, index) => `${index + 1}. ${channel.title || channel.username || channel.chatId}${channel.url ? ' — ' + channel.url : ''}`).join('\n')
    : 'No required channels configured.';
  return ctx.reply(`🔒 Force subscription: ${status}\n\nUsers must join every listed channel before using the bot.\n\n${list}\n\nThe bot must be an administrator in every required channel.`, forceSubKeyboard(data));
}

async function isSubscribed(ctx) {
  if (!ctx.from || isAdmin(ctx)) return true;
  const data = await getForceSubConfig();
  if (!data.enabled || !data.channels.length) return true;
  for (const channel of data.channels) {
    try {
      const member = await ctx.telegram.getChatMember(channel.chatId, ctx.from.id);
      const joined = ['creator', 'administrator', 'member'].includes(member.status) ||
        (member.status === 'restricted' && member.is_member === true);
      if (!joined) return false;
    } catch (error) {
      console.error('[fsub] Could not check membership for', channel.chatId, error.message);
      return false;
    }
  }
  return true;
}

async function showJoinPrompt(ctx) {
  const data = await getForceSubConfig();
  const rows = [];
  for (const channel of data.channels) {
    const url = channel.url || (channel.username ? `https://t.me/${String(channel.username).replace(/^@/, '')}` : '');
    if (url) rows.push([Markup.button.url('📢 Join ' + String(channel.title || channel.username || channel.chatId).slice(0, 28), url)]);
  }
  rows.push([Markup.button.callback('✅ I have joined — check again', 'check_sub')]);
  const message = '🔒 To use this bot, join every required channel below, then tap “I have joined — check again”.';
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('Please join all required channels first.', { show_alert: true }).catch(() => {});
    await ctx.editMessageText(message, Markup.inlineKeyboard(rows)).catch(() => ctx.reply(message, Markup.inlineKeyboard(rows)));
  } else {
    await ctx.reply(message, Markup.inlineKeyboard(rows));
  }
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

bot.action('menu:post', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  if (ctx.chat?.type !== 'private') return ctx.reply('Please create posts in a private chat with me.');
  const user = await collection('users').findOne({ userId: ctx.from.id }, { projection: { postDraft: 1 } });
  for (const video of (user?.postDraft?.videoFiles || [])) {
    if (video.storageMessageId) await ctx.telegram.deleteMessage(config.dbChannelId, video.storageMessageId).catch(() => {});
  }
  if (user?.postDraft?.storageMessageId) await ctx.telegram.deleteMessage(config.dbChannelId, user.postDraft.storageMessageId).catch(() => {});
  await collection('users').updateOne(
    { userId: ctx.from.id },
    { $set: { postDraft: { step: 'thumbnail', videoFiles: [], createdAt: now() } }, $unset: { batchDraft: '', batchStartedAt: '', pendingAutoAlbum: '' } },
  );
  return ctx.reply('🖼 Step 1/3: Send the thumbnail image for your post. Use /cancel to stop.');
});

bot.action(/^menu:(home|file|batch|password|premium|help|admin)$/, async (ctx) => {
  const action = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  if (action === 'home') return showMainMenu(ctx, true);
  if (action === 'file') {
    if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
    return ctx.reply('📤 Send your file, video, photo, audio, or document now. I will save it and return a share link.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
  }
  if (action === 'batch') {
    if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
    if (ctx.chat?.type !== 'private') return ctx.reply('Please create batches in a private chat with me.');
    await collection('users').updateOne({ userId: ctx.from.id }, { $set: { batchDraft: [], batchStartedAt: now() } });
    return ctx.reply('📦 Batch started. Send files, then tap Finish batch.', Markup.inlineKeyboard([[Markup.button.callback('✅ Finish batch', 'menu:finish')],[Markup.button.callback('🛑 Cancel batch', 'menu:cancel')]]));
  }
  if (action === 'password') {
    if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
    return ctx.reply('🔐 Password settings', Markup.inlineKeyboard([[Markup.button.callback('Set next-link password', 'menu:setpass')],[Markup.button.callback('Clear pending password', 'menu:clearpass')],[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
  }
  if (action === 'premium') return sendPremiumInvoice(ctx);
  if (action === 'help') return ctx.reply('📚 Help\n\nOpen links shared with you. Admins can create links using the menu or by sending media. For batches, send files and tap Finish batch. Password settings protect the next link. Premium uses Telegram Stars.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
  if (action === 'admin') {
    if (!isOwner(ctx)) return ctx.reply('⛔ Owner only.');
    return ctx.reply('🛠 Filestore Admin Panel', adminMenu());
  }
});
bot.action('menu:finish', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  const user = await collection('users').findOne({ userId: ctx.from.id });
  const ids = user?.batchDraft || [];
  if (!ids.length) return ctx.reply('Batch is empty. Send files first.');
  const tokenData = createToken(), seconds = await getAutoDeleteSeconds();
  const doc = { tokenHash: tokenData.tokenHash, ownerId: ctx.from.id, fileIds: ids, passwordHash: user.pendingPasswordHash || null, createdAt: now(), downloads: 0 };
  if (seconds > 0) doc.expiresAt = new Date(Date.now() + seconds * 1000);
  await collection('batches').insertOne(doc);
  await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { batchDraft: '', batchStartedAt: '', pendingPasswordHash: '' } });
  const me = await ctx.telegram.getMe(), link = buildLink(me.username, 'B', tokenData.token);
  return ctx.reply(`✅ Batch link created\nFiles: ${ids.length}\n\n${link}`, Markup.inlineKeyboard([[Markup.button.url('🔗 Open batch link', link)],[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
});
bot.action('menu:cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { batchDraft: '', batchStartedAt: '' } });
  return ctx.reply('🛑 Batch cancelled.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
});
bot.action('menu:setpass', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { pendingPasswordPrompt: true } });
  return ctx.reply('Send the password in your next normal message. It will be stored as a salted hash. /cancel aborts.');
});
bot.action('menu:clearpass', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingPasswordHash: '', pendingPasswordPrompt: '' } });
  return ctx.reply('✅ Pending password cleared.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
});
bot.action(/^admin:(stats|auto|broadcast)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isOwner(ctx)) return ctx.reply('⛔ Owner only.');
  if (ctx.match[1] === 'stats') {
    const [users, files, batches, bans, payments] = await Promise.all([collection('users').countDocuments(), collection('files').countDocuments(), collection('batches').countDocuments(), collection('bans').countDocuments(), collection('payments').countDocuments()]);
    return ctx.reply(`📊 Statistics\nUsers: ${users}\nFiles: ${files}\nBatches: ${batches}\nBanned: ${bans}\nStar payments: ${payments}`, adminMenu());
  }
  if (ctx.match[1] === 'auto') {
    const seconds = await getAutoDeleteSeconds();
    return ctx.reply(`🧹 Current auto-delete: ${seconds ? seconds + ' seconds' : 'off'}\nChoose expiry for new links:`, Markup.inlineKeyboard([[Markup.button.callback('Off', 'admin:expiry:0'),Markup.button.callback('1 hour', 'admin:expiry:3600')],[Markup.button.callback('1 day', 'admin:expiry:86400'),Markup.button.callback('7 days', 'admin:expiry:604800')],[Markup.button.callback('↩ Admin panel', 'menu:admin')]]));
  }
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { pendingBroadcast: true } });
  return ctx.reply('📣 Send your broadcast as the next normal text message. Send /cancel to abort.');
});
bot.action(/^admin:expiry:(0|3600|86400|604800)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isOwner(ctx)) return ctx.reply('⛔ Owner only.');
  const seconds = Number(ctx.match[1]);
  await collection('settings').updateOne({ key: 'autoDeleteSeconds' }, { $set: { key: 'autoDeleteSeconds', value: seconds, updatedAt: now(), updatedBy: ctx.from.id } }, { upsert: true });
  return ctx.reply(seconds ? `🧹 Auto-delete set to ${seconds} seconds for new links.` : '🧹 Auto-delete disabled for new links.', adminMenu());
});



bot.start(async (ctx) => {
  const parsed = parsePayload(ctx.startPayload || '');
  if (!parsed) return showMainMenu(ctx);

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
  if (parsed.type === 'B') return sendBatch(ctx, parsed.tokenHash);
  return sendPost(ctx, parsed.tokenHash);
});

bot.command('fsub', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage force subscription.');
  if (ctx.chat.type !== 'private') return ctx.reply('Please manage force subscription in a private chat.');
  return showForceSubSettings(ctx);
});

bot.action('fsub:manage', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage force subscription.');
  return showForceSubSettings(ctx);
});

bot.action('fsub:toggle', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage force subscription.');
  const data = await getForceSubConfig();
  data.enabled = !data.enabled;
  await saveForceSubConfig(data, ctx.from.id);
  return showForceSubSettings(ctx);
});

bot.action('fsub:add', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage force subscription.');
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { pendingForceSubAdd: true }, $unset: { pendingChannelAdd: '' } });
  return ctx.reply('Send the channel @username or numeric channel ID. I will automatically generate an invite link because the bot is an administrator there. Make sure the bot has permission to invite users. /cancel aborts.');
});

bot.action(/^fsub:remove:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage force subscription.');
  let chatId;
  try { chatId = decodeURIComponent(ctx.match[1]); } catch { return ctx.reply('Invalid channel selection.'); }
  const data = await getForceSubConfig();
  data.channels = data.channels.filter((channel) => String(channel.chatId) !== chatId);
  await saveForceSubConfig(data, ctx.from.id);
  return showForceSubSettings(ctx);
});

bot.action('check_sub', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (await isSubscribed(ctx)) {
    await ctx.editMessageText('✅ Subscription verified. Send /start again or reopen your file link.').catch(() => {});
  } else {
    await showJoinPrompt(ctx);
  }
});

bot.command('help', async (ctx) => {
  const text = '📚 Filestore help\n\n/start — interactive menu or open a share link\n/premium — buy premium with Stars\n/help — show help\n' +
    (isAdmin(ctx) ? '/batch — start batch\n/done — finish batch\n/cancel — cancel current action\n/setpassword PASSWORD — protect next link\n/clearpassword — clear password\n/post — publish a free or paid video post\n/auto — create a post from a thumbnail/video album\n/channels — manage posting channels\n/fsub — manage required membership channels\n' : '') +
    (isOwner(ctx) ? '/stats — statistics\n/autodelete SECONDS — expiry setting\n/broadcast MESSAGE — broadcast\n' : '') +
    '\nUse the buttons for guided actions.';
  return ctx.reply(text, mainMenu(ctx));
});

bot.command('setpassword', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
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

bot.command('clearpassword', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
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


bot.command('auto', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  if (ctx.chat.type !== 'private') return ctx.reply('Please use /auto in a private chat with me.');

  const oldUser = await collection('users').findOne({ userId: ctx.from.id }, { projection: { postDraft: 1 } });
  for (const video of (oldUser?.postDraft?.videoFiles || [])) {
    if (video.storageMessageId) await ctx.telegram.deleteMessage(config.dbChannelId, video.storageMessageId).catch(() => {});
  }
  if (oldUser?.postDraft?.storageMessageId) {
    await ctx.telegram.deleteMessage(config.dbChannelId, oldUser.postDraft.storageMessageId).catch(() => {});
  }
  await collection('users').updateOne(
    { userId: ctx.from.id },
    {
      $set: { pendingAutoAlbum: true },
      $unset: { postDraft: '', pendingChannelAdd: '', pendingForceSubAdd: '' },
    },
  );
  return ctx.reply(
    '⚡ Auto-post mode enabled. Send ONE Telegram media group containing exactly one thumbnail photo and one or more videos. Add the post title as the album caption (preferably on the thumbnail). I will save the videos, then ask you to choose Free or Paid and the posting channel. Use /cancel to stop.',
  );
});

bot.command('post', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  if (ctx.chat.type !== 'private') return ctx.reply('Please create posts in a private chat with me.');
  const oldDraft = await collection('users').findOne({ userId: ctx.from.id }, { projection: { postDraft: 1 } });
  for (const video of (oldDraft?.postDraft?.videoFiles || [])) {
    if (video.storageMessageId) await ctx.telegram.deleteMessage(config.dbChannelId, video.storageMessageId).catch(() => {});
  }
  await collection('users').updateOne(
    { userId: ctx.from.id },
    { $set: { postDraft: { step: 'thumbnail', videoFiles: [], createdAt: now() } }, $unset: { batchDraft: '', batchStartedAt: '', pendingAutoAlbum: '' } },
  );
  return ctx.reply('🖼 Step 1/3: Send the thumbnail image for your post. Use /cancel to stop.');
});

bot.command('channels', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage posting channels.');
  if (ctx.chat.type !== 'private') return ctx.reply('Please manage posting channels in a private chat.');
  const channels = await getPostChannels();
  const rows = channels.map((channel) => [
    Markup.button.callback('❌ Remove ' + String(channel.title || channel.username || channel.chatId).slice(0, 24), 'post:channels:remove:' + encodeURIComponent(String(channel.chatId))),
  ]);
  rows.unshift([Markup.button.callback('➕ Add channel', 'post:channels:add')]);
  rows.push([Markup.button.callback('🏠 Main menu', 'menu:home')]);
  const summary = channels.length
    ? '📢 Configured posting channels:\n\n' + channels.map((channel, index) => (index + 1) + '. ' + (channel.title || channel.username || channel.chatId) + ' (' + channel.chatId + ')').join('\n')
    : '📢 No posting channels configured yet.';
  return ctx.reply(summary + '\n\nThe bot must be an administrator in each channel.', Markup.inlineKeyboard(rows));
});

bot.action('post:channels:manage', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage posting channels.');
  const channels = await getPostChannels();
  const rows = channels.map((channel) => [
    Markup.button.callback('❌ Remove ' + String(channel.title || channel.username || channel.chatId).slice(0, 24), 'post:channels:remove:' + encodeURIComponent(String(channel.chatId))),
  ]);
  rows.unshift([Markup.button.callback('➕ Add channel', 'post:channels:add')]);
  rows.push([Markup.button.callback('🏠 Main menu', 'menu:home')]);
  return ctx.reply(
    (channels.length ? '📢 Configured posting channels:\n\n' + channels.map((channel, index) => (index + 1) + '. ' + (channel.title || channel.username || channel.chatId)).join('\n') : '📢 No posting channels configured yet.') + '\n\nThe bot must be an administrator in each channel.',
    Markup.inlineKeyboard(rows),
  );
});

bot.action('post:channels:add', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage posting channels.');
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { pendingChannelAdd: true } });
  return ctx.reply('Send the channel @username or numeric channel ID. Make sure the bot is already an administrator there. /cancel aborts.');
});

bot.action(/^post:channels:remove:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage posting channels.');
  let chatId;
  try { chatId = decodeURIComponent(ctx.match[1]); } catch { return ctx.reply('Invalid channel selection.'); }
  const channels = await getPostChannels();
  const updated = channels.filter((channel) => String(channel.chatId) !== chatId);
  await collection('settings').updateOne({ key: 'postChannels' }, { $set: { key: 'postChannels', channels: updated, updatedAt: now(), updatedBy: ctx.from.id } }, { upsert: true });
  return ctx.reply('✅ Channel removed from the posting list.', Markup.inlineKeyboard([[Markup.button.callback('📢 Manage channels', 'post:channels:manage')]]));
});

bot.action('post:videos:add', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  const user = await collection('users').findOne({ userId: ctx.from.id }, { projection: { postDraft: 1 } });
  if (!user?.postDraft || user.postDraft.step !== 'videoChoices') return ctx.reply('This video step expired. Start again with /post.');
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { 'postDraft.step': 'video' } });
  return ctx.reply('🎬 Send the next video. When finished, tap Finish videos.');
});

bot.action('post:videos:done', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  const user = await collection('users').findOne({ userId: ctx.from.id }, { projection: { postDraft: 1 } });
  const draft = user?.postDraft;
  if (!draft || draft.step !== 'videoChoices' || !draft.videoFiles?.length) return ctx.reply('Send at least one video first.');
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { 'postDraft.step': 'pricing' } });
  return ctx.reply(`✅ ${draft.videoFiles.length} video(s) ready. Choose whether this post is free or paid:`, Markup.inlineKeyboard([
    [Markup.button.callback('🆓 Free link', 'post:pricing:free')],
    [Markup.button.callback('⭐ Paid link', 'post:pricing:paid')],
    [Markup.button.callback('🛑 Cancel post', 'post:cancel')],
  ]));
});

bot.action(/^post:pricing:(free|paid)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  const user = await collection('users').findOne({ userId: ctx.from.id });
  const draft = user?.postDraft;
  if (!draft || draft.step !== 'pricing' || !draft.videoFiles?.length) return ctx.reply('This post draft expired. Start again with /post.');
  if (ctx.match[1] === 'free') {
    await collection('users').updateOne({ userId: ctx.from.id }, { $set: { 'postDraft.stars': 0, 'postDraft.step': 'channel' } });
    return promptPostChannels(ctx);
  }
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { 'postDraft.step': 'stars' } });
  return ctx.reply('⭐ How many Telegram Stars should users pay to unlock this video? Send a whole number, for example: 5. /cancel aborts.');
});

bot.action('post:cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  const user = await collection('users').findOne({ userId: ctx.from.id }, { projection: { postDraft: 1 } });
  if (user?.postDraft?.storageMessageId) {
    await ctx.telegram.deleteMessage(config.dbChannelId, user.postDraft.storageMessageId).catch(() => {});
  }
  await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { postDraft: '', pendingAutoAlbum: '' } });
  return ctx.reply('🛑 Post creation cancelled.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
});

bot.action(/^post:channel:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  let selectedId;
  try { selectedId = decodeURIComponent(ctx.match[1]); } catch { return ctx.reply('Invalid channel selection.'); }
  const user = await collection('users').findOne({ userId: ctx.from.id });
  const draft = user?.postDraft;
  if (!draft || draft.step !== 'channel' || !Array.isArray(draft.videoFiles) || !draft.videoFiles.length) return ctx.reply('This post draft expired. Start again with /post.');
  const channels = await getPostChannels();
  const channel = channels.find((item) => String(item.chatId) === selectedId);
  if (!channel) return ctx.reply('That channel is no longer configured. Please choose again.', postChannelsKeyboard(channels));
  const postToken = createToken();
  const videoDocs = draft.videoFiles.map((video) => {
    const token = createToken();
    return {
      tokenHash: token.tokenHash,
      storageMessageId: video.storageMessageId,
      fileType: video.fileType || 'video',
      fileName: video.fileName || null,
      mimeType: video.mimeType || null,
      fileSize: video.fileSize || null,
      ownerId: ctx.from.id,
      passwordHash: null,
      createdAt: now(),
      downloads: 0,
    };
  });
  const fileResult = await collection('files').insertMany(videoDocs);
  const postDoc = {
    tokenHash: postToken.tokenHash,
    fileTokenHashes: videoDocs.map((video) => video.tokenHash),
    title: draft.title,
    thumbnailFileId: draft.thumbnailFileId,
    stars: Number(draft.stars || 0),
    paidUsers: [],
    channelId: channel.chatId,
    ownerId: ctx.from.id,
    videoCount: videoDocs.length,
    createdAt: now(),
  };
  await collection('posts').insertOne(postDoc);
  const me = await ctx.telegram.getMe();
  const link = buildLink(me.username, 'P', postToken.token);
  const buttonLabel = postDoc.stars > 0 ? '⭐ Unlock for ' + postDoc.stars + ' Stars' : '▶️ Open video';
  try {
    const published = await ctx.telegram.sendPhoto(channel.chatId, draft.thumbnailFileId, {
      caption: draft.title,
      reply_markup: Markup.inlineKeyboard([[Markup.button.url(buttonLabel, link)]]).reply_markup,
    });
    await collection('posts').updateOne({ tokenHash: postToken.tokenHash }, { $set: { channelPostMessageId: published.message_id } });
    await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { postDraft: '' } });
    return ctx.reply(
      '✅ Post published to ' + (channel.title || channel.username || channel.chatId) + '.\n\nTitle: ' + draft.title + '\nVideos: ' + videoDocs.length + '\nAccess: ' + (postDoc.stars > 0 ? postDoc.stars + ' Stars' : 'Free') + '\n\nLink: ' + link,
      Markup.inlineKeyboard([[Markup.button.url('🔗 Open post link', link)], [Markup.button.callback('📢 Manage channels', 'post:channels:manage')]]),
    );
  } catch (error) {
    await collection('posts').deleteOne({ tokenHash: postToken.tokenHash });
    await collection('files').deleteMany({ _id: { $in: Object.values(fileResult.insertedIds) } });
    console.error('[post] Publish failed:', error.message);
    return ctx.reply('❌ I could not publish to that channel. Check that the bot can post photos and messages there. Your draft is still saved; choose a channel again.', postChannelsKeyboard(channels));
  }
});

bot.command('premium', async (ctx) => sendPremiumInvoice(ctx));

bot.on('pre_checkout_query', async (ctx) => {
  const query = ctx.update.pre_checkout_query;
  if (query.invoice_payload.startsWith('post_')) {
    const postHash = query.invoice_payload.slice(5);
    const post = /^[a-f0-9]{64}$/i.test(postHash) ? await collection('posts').findOne({ tokenHash: postHash }) : null;
    if (!post || post.stars < 1 || query.currency !== 'XTR' || query.total_amount !== post.stars) {
      return ctx.answerPreCheckoutQuery(false, 'This paid-post invoice is invalid or expired.');
    }
    return ctx.answerPreCheckoutQuery(true);
  }
  const expected = 'premium_' + config.starsDays + 'd_' + query.from.id;
  if (query.currency !== 'XTR' || query.total_amount !== config.starsPrice || query.invoice_payload !== expected) {
    return ctx.answerPreCheckoutQuery(false, 'This payment invoice is invalid or expired.');
  }
  return ctx.answerPreCheckoutQuery(true);
});

bot.command('batch', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  if (ctx.chat.type !== 'private') return ctx.reply('Please create batches in a private chat with me.');
  await collection('users').updateOne({ userId: ctx.from.id }, { $set: { batchDraft: [], batchStartedAt: now() } });
  return ctx.reply('📦 Batch mode started. Send or forward the files you want to include, then use /done. Use /cancel to stop.');
});

bot.command('cancel', async (ctx) => {
  const user = await collection('users').findOne({ userId: ctx.from.id }, { projection: { postDraft: 1 } });
  for (const video of (user?.postDraft?.videoFiles || [])) {
    if (video.storageMessageId) await ctx.telegram.deleteMessage(config.dbChannelId, video.storageMessageId).catch(() => {});
  }
  if (user?.postDraft?.storageMessageId) await ctx.telegram.deleteMessage(config.dbChannelId, user.postDraft.storageMessageId).catch(() => {});
  await collection('users').updateOne(
    { userId: ctx.from.id },
    { $unset: { batchDraft: '', batchStartedAt: '', pendingPasswordPrompt: '', pendingBroadcast: '', pendingChannelAdd: '', pendingForceSubAdd: '', pendingAutoAlbum: '', postDraft: '' } },
  );
  return ctx.reply('🛑 Current action cancelled.');
});

bot.command('done', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
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
  return ctx.reply(`${batchDoc.passwordHash ? '🔐 Password-protected batch link created' : '✅ Batch link created'}\n\nFiles: ${ids.length}\n\n${link}`, Markup.inlineKeyboard([[Markup.button.url('🔗 Open batch link', link)]]));
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
    if (payment.invoice_payload.startsWith('post_')) {
      const postHash = payment.invoice_payload.slice(5);
      const post = /^[a-f0-9]{64}$/i.test(postHash) ? await collection('posts').findOne({ tokenHash: postHash }) : null;
      if (!post || post.stars < 1 || payment.currency !== 'XTR' || payment.total_amount !== post.stars) {
        return ctx.reply('❌ Payment details did not match this paid post. Please contact the bot owner.');
      }
      let record;
      try {
        const inserted = await collection('payments').insertOne({
          telegramPaymentChargeId: payment.telegram_payment_charge_id,
          providerPaymentChargeId: payment.provider_payment_charge_id || null,
          userId: ctx.from.id,
          currency: payment.currency,
          totalAmount: payment.total_amount,
          payload: payment.invoice_payload,
          postTokenHash: postHash,
          status: 'pending',
          createdAt: now(),
        });
        record = await collection('payments').findOne({ _id: inserted.insertedId });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        record = await collection('payments').findOne({ telegramPaymentChargeId: payment.telegram_payment_charge_id });
        if (!record) throw error;
        if (record.status === 'processed') {
          await collection('posts').updateOne({ tokenHash: postHash }, { $addToSet: { paidUsers: ctx.from.id } });
          return sendPostVideos(ctx, post);
        }
      }
      await collection('posts').updateOne({ tokenHash: postHash }, { $addToSet: { paidUsers: ctx.from.id } });
      await collection('payments').updateOne(
        { _id: record._id, status: 'pending' },
        { $set: { status: 'processed', processedAt: now(), postTokenHash: postHash } },
      );
      return sendPostVideos(ctx, post);
    }
    const expectedPayload = 'premium_' + config.starsDays + 'd_' + ctx.from.id;
    if (payment.currency !== 'XTR' || payment.total_amount !== config.starsPrice || payment.invoice_payload !== expectedPayload) {
      return ctx.reply('❌ Payment details did not match this account. Please contact support.');
    }
    if (payment.total_amount !== config.starsPrice) {
      return ctx.reply('❌ The payment amount did not match the configured plan. Please contact support.');
    }
    let paymentRecord;
    try {
      const inserted = await collection('payments').insertOne({
        telegramPaymentChargeId: payment.telegram_payment_charge_id,
        providerPaymentChargeId: payment.provider_payment_charge_id || null,
        userId: ctx.from.id,
        currency: payment.currency,
        totalAmount: payment.total_amount,
        payload: payment.invoice_payload,
        status: 'pending',
        createdAt: now(),
      });
      paymentRecord = await collection('payments').findOne({ _id: inserted.insertedId });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      paymentRecord = await collection('payments').findOne({ telegramPaymentChargeId: payment.telegram_payment_charge_id });
      if (!paymentRecord || paymentRecord.status === 'processed') {
        return ctx.reply('✅ This payment has already been processed.');
      }
    }
    const user = await collection('users').findOne({ userId: ctx.from.id }, { projection: { premiumUntil: 1 } });
    const base = user?.premiumUntil && user.premiumUntil > now() ? user.premiumUntil : now();
    const premiumUntil = new Date(base.getTime() + config.starsDays * 24 * 60 * 60 * 1000);
    await collection('users').updateOne({ userId: ctx.from.id }, { $set: { premiumUntil } });
    await collection('payments').updateOne(
      { _id: paymentRecord._id, status: 'pending' },
      { $set: { status: 'processed', processedAt: now(), premiumUntil } },
    );
    return ctx.reply(`🎉 Payment successful! Premium is active until ${premiumUntil.toUTCString()}.`);
  }


  const workflowUser = await collection('users').findOne(
    { userId: ctx.from.id },
    { projection: { postDraft: 1, pendingChannelAdd: 1, pendingForceSubAdd: 1, pendingAutoAlbum: 1 } },
  );

  if (workflowUser?.pendingAutoAlbum && !ctx.message.media_group_id && !ctx.message.text?.startsWith('/')) {
    return ctx.reply('Please send the thumbnail and videos together as one Telegram media group. Run /cancel to stop auto-post mode.');
  }

  if (workflowUser?.pendingAutoAlbum && ctx.message.media_group_id) {
    const key = `${ctx.from.id}:${ctx.message.media_group_id}`;
    let buffer = autoAlbumBuffers.get(key);
    if (!buffer) buffer = { ctx, messages: [], timer: null };
    if (!buffer.messages.some((message) => message.message_id === ctx.message.message_id)) {
      buffer.messages.push(ctx.message);
    }
    if (buffer.timer) clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => {
      autoAlbumBuffers.delete(key);
      processAutoAlbum(buffer.ctx, buffer.messages).catch((error) => {
        console.error('[auto] Album processing failed:', error.message);
        buffer.ctx.reply('❌ Auto-post failed unexpectedly. Please run /auto and try again.').catch(() => {});
      });
    }, 1400);
    autoAlbumBuffers.set(key, buffer);
    return;
  }

  if (workflowUser?.pendingForceSubAdd && ctx.message.text && !ctx.message.text.startsWith('/')) {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage force subscription.');
    const rawChatPart = ctx.message.text.trim();
    const requestedChat = /^-?\d+$/.test(rawChatPart) ? Number(rawChatPart) : rawChatPart;
    try {
      const chat = await ctx.telegram.getChat(requestedChat);
      if (chat.type !== 'channel') return ctx.reply('That is not a Telegram channel. Send a channel @username or numeric channel ID.');
      const me = await ctx.telegram.getMe();
      const botMember = await ctx.telegram.getChatMember(chat.id, me.id);
      if (!['administrator', 'creator'].includes(botMember.status)) {
        return ctx.reply('❌ The bot is not an administrator in that channel. Promote it, then try again.');
      }
      const data = await getForceSubConfig();
      if (data.channels.some((channel) => String(channel.chatId) === String(chat.id))) {
        await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingForceSubAdd: '' } });
        return ctx.reply('That channel is already in the required-membership list.', forceSubKeyboard(data));
      }
      let inviteLink;
      try {
        const invite = await ctx.telegram.createChatInviteLink(chat.id, {
          name: 'Filestore Force Sub',
        });
        inviteLink = invite.invite_link;
      } catch (error) {
        console.error('[fsub] Could not generate invite link:', error.message);
        return ctx.reply('❌ I could not generate an invite link. Confirm the bot has permission to invite users in that channel, then try again.');
      }
      const record = {
        chatId: chat.id,
        title: chat.title || chat.username || String(chat.id),
        username: chat.username || null,
        url: inviteLink,
        addedAt: now(),
        addedBy: ctx.from.id,
      };
      data.channels.push(record);
      await saveForceSubConfig(data, ctx.from.id);
      await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingForceSubAdd: '' } });
      return ctx.reply('✅ Required channel added: ' + record.title + '\nForce subscription is currently ' + (data.enabled ? 'ON' : 'OFF') + '.', forceSubKeyboard(data));
    } catch (error) {
      console.error('[fsub] Channel validation failed:', error.message);
      return ctx.reply('❌ Could not access that channel. Check the ID or @username and confirm the bot is an administrator.');
    }
  }

  if (workflowUser?.pendingChannelAdd && ctx.message.text && !ctx.message.text.startsWith('/')) {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Only admins can manage posting channels.');
    const raw = ctx.message.text.trim();
    const requestedChat = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    try {
      const chat = await ctx.telegram.getChat(requestedChat);
      if (chat.type !== 'channel') return ctx.reply('That is not a Telegram channel. Send a channel @username or numeric channel ID.');
      const me = await ctx.telegram.getMe();
      const member = await ctx.telegram.getChatMember(chat.id, me.id);
      if (!['administrator', 'creator'].includes(member.status)) {
        return ctx.reply('❌ The bot is not an administrator in that channel. Promote the bot, then try again.');
      }
      const channels = await getPostChannels();
      if (channels.some((channel) => String(channel.chatId) === String(chat.id))) {
        await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingChannelAdd: '' } });
        return ctx.reply('That channel is already configured.', Markup.inlineKeyboard([[Markup.button.callback('📢 Manage channels', 'post:channels:manage')]]));
      }
      const channelRecord = {
        chatId: chat.id,
        title: chat.title || chat.username || String(chat.id),
        username: chat.username || null,
        addedAt: now(),
        addedBy: ctx.from.id,
      };
      await collection('settings').updateOne(
        { key: 'postChannels' },
        { $set: { key: 'postChannels', channels: [...channels, channelRecord], updatedAt: now(), updatedBy: ctx.from.id } },
        { upsert: true },
      );
      await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingChannelAdd: '' } });
      if (workflowUser.postDraft?.step === 'channel') {
        await ctx.reply('✅ Added channel: ' + channelRecord.title);
        return promptPostChannels(ctx);
      }
      return ctx.reply('✅ Added channel: ' + channelRecord.title, Markup.inlineKeyboard([[Markup.button.callback('📢 Manage channels', 'post:channels:manage')]]));
    } catch (error) {
      console.error('[post] Channel validation failed:', error.message);
      return ctx.reply('❌ Could not access that channel. Send a valid channel ID or @username and confirm the bot is an administrator.');
    }
  }

  if (workflowUser?.postDraft) {
    const draft = workflowUser.postDraft;
    if (draft.step === 'thumbnail') {
      const image = ctx.message.photo?.at(-1);
      if (!image) return ctx.reply('🖼 Please send the thumbnail as a Telegram photo (not as a file/document). Use /cancel to stop.');
      await collection('users').updateOne(
        { userId: ctx.from.id },
        { $set: { 'postDraft.thumbnailFileId': image.file_id, 'postDraft.step': 'title' } },
      );
      return ctx.reply('✍️ Step 2/3: Now send the post title as text.');
    }
    if (draft.step === 'title') {
      if (!ctx.message.text || ctx.message.text.startsWith('/')) return ctx.reply('Please send the title as a normal text message. Use /cancel to stop.');
      const title = ctx.message.text.trim();
      if (!title || title.length > 900) return ctx.reply('Title must be between 1 and 900 characters. Please send it again.');
      await collection('users').updateOne(
        { userId: ctx.from.id },
        { $set: { 'postDraft.title': title, 'postDraft.step': 'video' } },
      );
      return ctx.reply('🎬 Step 3/3: Send the first video (as a Telegram video or a video document). You can add multiple videos to this one post.');
    }
    if (draft.step === 'video' || draft.step === 'videoChoices') {
      if (draft.step === 'videoChoices') {
        return ctx.reply('Choose Add another video or Finish videos below before sending another video.', Markup.inlineKeyboard([
          [Markup.button.callback('➕ Add another video', 'post:videos:add')],
          [Markup.button.callback('✅ Finish videos', 'post:videos:done')],
          [Markup.button.callback('🛑 Cancel post', 'post:cancel')],
        ]));
      }
      const info = getFileInfo(ctx.message);
      const isVideo = info && (info.fileType === 'video' || (info.fileType === 'document' && String(info.mimeType || '').startsWith('video/')));
      if (!isVideo) return ctx.reply('🎬 Please send a video or a document with a video MIME type. Use /cancel to stop.');
      const status = await ctx.reply('📥 Saving video to the private storage channel…');
      try {
        const stored = await ctx.telegram.copyMessage(config.dbChannelId, ctx.chat.id, ctx.message.message_id);
        const video = {
          storageMessageId: stored.message_id,
          fileType: info.fileType,
          fileName: info.fileName,
          mimeType: info.mimeType,
          fileSize: info.fileSize,
        };
        await collection('users').updateOne(
          { userId: ctx.from.id },
          { $push: { 'postDraft.videoFiles': video }, $set: { 'postDraft.step': 'videoChoices' } },
        );
        const updated = await collection('users').findOne({ userId: ctx.from.id }, { projection: { postDraft: 1 } });
        const count = updated?.postDraft?.videoFiles?.length || 1;
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          status.message_id,
          undefined,
          `✅ Video ${count} saved. Add more videos or finish to continue.`,
          { reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add another video', 'post:videos:add')],
            [Markup.button.callback('✅ Finish videos', 'post:videos:done')],
            [Markup.button.callback('🛑 Cancel post', 'post:cancel')],
          ]).reply_markup },
        );
      } catch (error) {
        console.error('[post] Video storage failed:', error.message);
        return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '❌ Could not save the video. Check that the bot is an admin in the private storage channel and try again.').catch(() => {});
      }
    }
    if (draft.step === 'stars') {
      if (!ctx.message.text || ctx.message.text.startsWith('/')) return ctx.reply('Send a whole number of Stars, for example 5. Use /cancel to stop.');
      const stars = Number(ctx.message.text.trim());
      if (!Number.isSafeInteger(stars) || stars < 1 || stars > 100000) return ctx.reply('Stars must be a whole number between 1 and 100000. Try again.');
      await collection('users').updateOne({ userId: ctx.from.id }, { $set: { 'postDraft.stars': stars, 'postDraft.step': 'channel' } });
      return promptPostChannels(ctx);
    }
    if (draft.step === 'channel') return promptPostChannels(ctx);
  }

  if (ctx.message.text) {
    const menuState = await collection('users').findOne({ userId: ctx.from.id }, { projection: { pendingPasswordPrompt: 1, pendingBroadcast: 1 } });
    if (ctx.message.text === '/cancel' && (menuState?.pendingPasswordPrompt || menuState?.pendingBroadcast)) {
      await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingPasswordPrompt: '', pendingBroadcast: '' } });
      return ctx.reply('🛑 Action cancelled.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
    }
    if (menuState?.pendingPasswordPrompt && !ctx.message.text.startsWith('/')) {
      if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
      try {
        const passwordHash = hashPassword(ctx.message.text);
        await collection('users').updateOne({ userId: ctx.from.id }, { $set: { pendingPasswordHash: passwordHash }, $unset: { pendingPasswordPrompt: '' } });
        return ctx.reply('🔐 Password saved for your next file or batch link.', Markup.inlineKeyboard([[Markup.button.callback('🏠 Main menu', 'menu:home')]]));
      } catch (error) { return ctx.reply(error.message); }
    }
    if (menuState?.pendingBroadcast && !ctx.message.text.startsWith('/')) {
      if (!isOwner(ctx)) return ctx.reply('⛔ Owner only.');
      await collection('users').updateOne({ userId: ctx.from.id }, { $unset: { pendingBroadcast: '' } });
      let sent = 0, failed = 0;
      const users = collection('users').find({ userId: { $ne: config.ownerId } }, { projection: { userId: 1 } });
      for await (const user of users) {
        try { if (await collection('bans').findOne({ userId: user.userId })) continue; await ctx.telegram.sendMessage(user.userId, ctx.message.text); sent++; }
        catch { failed++; }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return ctx.reply(`📣 Broadcast finished.\nSent: ${sent}\nFailed: ${failed}`, adminMenu());
    }
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
  if (!isAdmin(ctx)) return ctx.reply(adminOnlyMessage);
  if (!config.privateUploadsEnabled) {
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
      `${fileDoc.passwordHash ? '🔐 Password-protected file saved!' : '✅ File saved successfully!'}\n\nType: ${info.fileType}${info.fileName ? `\nName: ${info.fileName}` : ''}${info.fileSize ? `\nSize: ${formatBytes(info.fileSize)}` : ''}\n\nPermanent link:\n${link}`,
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
