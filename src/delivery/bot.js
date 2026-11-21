import { Telegraf, Markup } from 'telegraf';
import { isAdmin } from '../bot/admin-guard.js';
import { getIndexedFile } from '../storage/file-query.js';
import { createSingleDeliveryJob, createBatchDeliveryJob, getDeliveryStats } from './repository.js';
import { getPaidBatch, requestPaidBatchPurchase, getBatchItems } from '../paid-files/batch-repository.js';
import { recordLinkOpen } from '../web/link-analytics-repository.js';
import { createDeliveryWorker } from './worker.js';
import { createAutoDeleteWorker } from './auto-delete-worker.js';
import { checkForceSubscription } from '../access/force-subscription.js';
import { upsertTelegramUser } from '../access/user-repository.js';
import { trackDeliveryBotUser } from '../web/user-management-repository.js';
import { evaluateAccess } from '../access/access-manager.js';
import { getCheckpointRequirement, createCheckpointChallenge, applyVerifiedCheckpoint } from '../access/checkpoint-engine.js';
import { getPaidFileLink, requestPaidFilePurchase, hasPaidFileEntitlement } from '../paid-files/repository.js';
import { listPremiumPlans, getPremiumPlanById } from '../premium/repository.js';
import { sendStarsInvoice, handleStarsPreCheckout, handleStarsSuccessfulPayment, getTelegramStarsPrice } from '../payments/telegram-stars.js';
import {
  loadFamPayConfig,
  createFamPayCheckout,
  verifyFamPaySession,
  cancelFamPaySession,
} from '../payments/fampay.js';
import { startFamPayVerificationWorker } from '../payments/fampay-worker.js';
import { getShareLinkByCode } from '../storage/share-links-repository.js';
import { escapeHtml, getCommandArgs, inspectBotChannelAccess, safeAnswer } from '../bot/telegram-utils.js';
import { formatMoney } from '../utils/validation.js';

const HTML = { parse_mode: 'HTML' };

async function getStarsConfig(pool) {
  const result = await pool.query('SELECT public_config,is_enabled FROM payment_methods WHERE method=$1', ['telegram_stars']);
  if (!result.rowCount || !result.rows[0].is_enabled) return null;
  return result.rows[0].public_config ?? {};
}


function getMissingSubscriptionMarkup(missing, ownerId = null) {
  const rows = missing.slice(0, 20).map((channel) => [Markup.button.url('📢 Join ' + String(channel.title ?? 'channel').slice(0, 40), channel.join_url)]);
  const cb = ownerId ? `fs_verify:${ownerId}` : 'fs_verify';
  rows.push([Markup.button.callback('✅ I Joined — Verify', cb)]);
  return Markup.inlineKeyboard(rows);
}

async function logForceSubEvent(pool, logger, eventType, userId, result) {
  try {
    await pool.query('INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details) VALUES ($1, $2, $2, $3::jsonb)', [eventType, userId, JSON.stringify({ missingChannelIds: result.missing.map((channel) => channel.telegram_chat_id) })]);
  } catch (error) {
    logger.warn({ userId, error: error.message }, 'Force-sub activity log write failed');
  }
}


async function enforceForceSub(ctx, telegram, pool, userId, logger, promptSuffix = 'Then tap ✅ I Joined — Verify.', ownerId = null) {
  const forceSub = await checkForceSubscription(telegram, pool, userId, ownerId);
  await logForceSubEvent(pool, logger, forceSub.passed ? 'force_sub_verified' : 'force_sub_blocked', userId, forceSub);
  if (!forceSub.passed) {
    const labels = forceSub.missing.slice(0, 20).map((channel) => `• 📢 <b>${escapeHtml(channel.title ?? channel.telegram_chat_id)}</b>`).join('\n');
    await ctx.reply(
      `🔒 <b>Channel Subscription Required</b>\n━━━━━━━━━━━━━━━━━━\n\nPlease join the required channel(s) below to unlock access:\n\n${labels}\n\n👉 <i>${escapeHtml(promptSuffix)}</i>`,
      { ...HTML, ...getMissingSubscriptionMarkup(forceSub.missing, ownerId) },
    );
  }
  return forceSub;
}

async function verifyFileDeliveryAccess(ctx, pool, config, logger, botInfo, userId, fileId, forceSub, lockedPurchaseMessage = '🔒 This file is locked. Use /paid <link_code> to request purchase.', ownerId = null) {
  const paidEntitled = await hasPaidFileEntitlement(pool, userId, fileId);
  const paidLink = await pool.query(
    'SELECT EXISTS (SELECT 1 FROM paid_file_links WHERE file_id = $1 AND is_enabled = TRUE AND (expires_at IS NULL OR expires_at > NOW())) OR EXISTS (SELECT 1 FROM paid_batch_items i JOIN paid_batch_links b ON b.id = i.batch_link_id WHERE i.file_id = $1 AND b.is_enabled = TRUE AND (b.expires_at IS NULL OR b.expires_at > NOW())) AS locked',
    [fileId],
  );
  const paidLocked = paidLink.rows[0]?.locked === true;
  const access = await evaluateAccess(pool, { userId, type: (paidEntitled || paidLocked) ? 'paid_file' : 'free_file', resourceId: fileId, ownerId }, forceSub);
  if (!access.allowed) {
    if (access.reason === 'purchase_required') {
      await ctx.reply(lockedPurchaseMessage);
    } else if (access.reason === 'checkpoint_required') {
      const candidates = access.candidates?.length ? access.candidates : (access.provider ? [access.provider] : []);
      let botUsername = ctx.botInfo?.username ?? botInfo?.username;
      if (!botUsername) {
        try { botUsername = (await ctx.telegram.getMe())?.username; } catch {}
      }
      let challenge = null;
      let lastError = null;
      for (const candidate of candidates) {
        try {
          challenge = await createCheckpointChallenge(pool, config, userId, candidate, botUsername);
          break;
        } catch (error) {
          lastError = error;
          logger?.warn?.({ error: error.message, providerId: candidate.id, provider: candidate.name, userId }, 'Shortener checkpoint link generation failed');
        }
      }
      if (challenge) {
        const kbRows = [
          [Markup.button.url(`🔗 Verify via ${String(challenge.provider.name).slice(0, 24)}`, challenge.shortUrl)],
        ];
        let hasCreatorPlans = false;
        if (ownerId !== null && ownerId !== undefined) {
          try {
            const [cPlans, starsCfg, fpConfig] = await Promise.all([
              listPremiumPlans(pool, ownerId),
              getStarsConfig(pool),
              loadFamPayConfig(pool, config.tokenEncryptionKey),
            ]);
            const famPayAvailable = fpConfig.isEnabled && fpConfig.isConfigured;
            hasCreatorPlans = cPlans.some((plan) => {
              if (!plan.is_enabled) return false;
              const stars = starsCfg ? getTelegramStarsPrice(starsCfg, 'premium', { planId: plan.id }) : null;
              const upi = famPayAvailable && String(plan.currency).toUpperCase() === 'INR' && Number(plan.price_minor) > 0;
              return Boolean(stars || upi);
            });
            if (hasCreatorPlans) {
              kbRows.push([Markup.button.callback('💎 Skip Ads — Creator Premium', `fs_cprem_list:${ownerId}`)]);
            }
          } catch {}
        }
        await ctx.reply(
          [
            '🔐 <b>Quick Verification Required</b>',
            '━━━━━━━━━━━━━━━━━━',
            '',
            `🌐 <b>Provider:</b> ${escapeHtml(challenge.provider.name)}${access.total > 1 ? ` (<b>Step ${access.step}/${access.total}</b>)` : ''}`,
            `⏳ <b>Access Duration:</b> ${challenge.provider.checkpoint_minutes ?? 1440} minute(s)`,
            '',
            '👇 <i>Tap the button below, complete the quick step, and return here to unlock free delivery!</i>',
            hasCreatorPlans
              ? '💎 <i>Tip: Tap <b>Creator Premium</b> below (or /premium) to skip verification checkpoints.</i>'
              : '💎 <i>Tip: Upgrade with /premium to skip verification checkpoints.</i>',
          ].join('\n'),
          {
            ...HTML,
            ...Markup.inlineKeyboard(kbRows),
          },
        );
      } else {
        await ctx.reply(
          `⚠️ Could not generate verification link (${lastError?.message ?? 'shortener unavailable'}). Please try again shortly.`,
        );
      }
    } else if (access.reason === 'checkpoint_provider_unavailable' || access.reason === 'checkpoint_verification_unavailable') {
      await ctx.reply('⚠️ Checkpoint verification is unavailable right now. Access remains locked; please try later.');
    } else {
      await ctx.reply('❌ Access check failed (' + access.reason + '). Please try again later.');
    }
    return { allowed: false, paidEntitled };
  }
  return { allowed: true, paidEntitled };
}

async function showForceSubStatus(ctx, telegram, pool, userId, logger) {
  const result = await checkForceSubscription(telegram, pool, userId, null);
  await logForceSubEvent(pool, logger, result.passed ? 'force_sub_verified' : 'force_sub_blocked', userId, result);
  if (result.passed) {
    await ctx.reply('✅ <b>Subscription Check Passed!</b>\n\nAll required channels are joined — you are good to go! 🚀', HTML);
    return result;
  }
  const labels = result.missing.slice(0, 20).map((channel) => `• 📢 <b>${escapeHtml(channel.title ?? channel.telegram_chat_id)}</b>${channel.checkStatus === 'check_failed' ? ' <i>(verification temporarily unavailable)</i>' : ''}`).join('\n');
  await ctx.reply(
    `🔒 <b>Join Required Channels First</b>\n━━━━━━━━━━━━━━━━━━\n\n${labels}\n\n👉 <i>Join the channel(s) above, then tap Verify.</i>`,
    { ...HTML, ...getMissingSubscriptionMarkup(result.missing, null) },
  );
  return result;
}

export function createDeliveryBot(config, logger, pool, token = config.deliveryBotToken, botMeta = {}) {
  if (!token) return null;
  const bot = new Telegraf(token);
  const pendingUtrInputs = new Map();
  let worker;
  let autoDeleteWorker;
  let famPayWorker;
  let identity = 'delivery-bot';
  let botNumericId = null;
  const workerScope = {
    deliveryBotId: botMeta.deliveryBotId ?? null,
    includeGlobal: botMeta.includeGlobal !== false,
  };
  const botOwnerScope = botMeta.ownerTelegramId ?? null;

  function resolveCreatorScope(creatorId) {
    const id = Number(creatorId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return isAdmin(id, config.adminIds) ? null : id;
  }

  function setUtrPrompt(userId, sessionId) {
    pendingUtrInputs.set(String(userId), { sessionId, expiresAt: Date.now() + 5 * 60 * 1000 });
  }
  function getUtrPrompt(userId) {
    const entry = pendingUtrInputs.get(String(userId));
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      pendingUtrInputs.delete(String(userId));
      return null;
    }
    return entry.sessionId;
  }

  bot.use(async (ctx, next) => {
    if (ctx.from && workerScope.deliveryBotId) {
      try { await trackDeliveryBotUser(pool, workerScope.deliveryBotId, ctx.from); }
      catch (error) { logger.warn({ userId: ctx.from.id, error: error.message }, 'Delivery bot user tracking failed'); }
    }
    if (isAdmin(ctx.from?.id, config.adminIds)) return next();
    const command = ctx.message?.text?.trim().split(/\s+/)[0]?.split('@')[0] ?? '';
    const cbData = ctx.callbackQuery?.data ?? '';
    const hasPendingUtr = Boolean(ctx.from?.id && ctx.message?.text && !command.startsWith('/') && getUtrPrompt(ctx.from.id));
    const allowed = ['/start', '/verify', '/get', '/paid', '/batch', '/batch_get', '/premium', '/checkpoint_status', '/access_status', '/cancel', '/help'].includes(command)
      || Boolean(ctx.message?.successful_payment)
      || Boolean(ctx.preCheckoutQuery)
      || hasPendingUtr
      || cbData === 'fs_verify'
      || cbData.startsWith('fs_verify:')
      || cbData.startsWith('fs_premium_')
      || cbData.startsWith('fs_prem_')
      || cbData.startsWith('fs_cprem_')
      || cbData.startsWith('fs_paid_')
      || cbData.startsWith('fs_batch_')
      || cbData.startsWith('fs_fp_');
    if (allowed) return next();
    if (ctx.chat?.type === 'private') await ctx.reply('🤖 Open a valid FileStore share link, or send /start to see available commands.');
  });

  bot.on('pre_checkout_query', (ctx) => handleStarsPreCheckout(bot, pool, ctx, token, logger));
  bot.on('message', async (ctx, next) => {
    if (!ctx.message?.successful_payment) return next();
    return handleStarsSuccessfulPayment(pool, ctx, token, logger, config.adminIds ?? [], config.notifyTelegram ?? bot.telegram);
  });

  async function loadPremiumCheckoutOptions(ownerId = botOwnerScope) {
    const [starsCfg, fpConfig, plans] = await Promise.all([
      getStarsConfig(pool),
      loadFamPayConfig(pool, config.tokenEncryptionKey),
      listPremiumPlans(pool, ownerId),
    ]);
    const famPayAvailable = fpConfig.isEnabled && fpConfig.isConfigured;
    const options = [];
    for (const plan of plans) {
      if (!plan.is_enabled) continue;
      const starsPrice = starsCfg ? getTelegramStarsPrice(starsCfg, 'premium', { planId: plan.id }) : null;
      const upiAvailable = famPayAvailable && String(plan.currency).toUpperCase() === 'INR' && Number(plan.price_minor) > 0;
      if (starsPrice || upiAvailable) {
        options.push({ plan, starsPrice, upiAvailable });
      }
    }
    const enabledPlanCount = plans.filter((p) => p.is_enabled).length;
    return { starsEnabled: Boolean(starsCfg), famPayAvailable, enabledPlanCount, options };
  }

  async function loadSinglePlanCheckoutOption(planId) {
    const [starsCfg, fpConfig, plan] = await Promise.all([
      getStarsConfig(pool),
      loadFamPayConfig(pool, config.tokenEncryptionKey),
      getPremiumPlanById(pool, planId),
    ]);
    if (!plan || !plan.is_enabled) return null;
    const famPayAvailable = fpConfig.isEnabled && fpConfig.isConfigured;
    const starsPrice = starsCfg ? getTelegramStarsPrice(starsCfg, 'premium', { planId: plan.id }) : null;
    const upiAvailable = famPayAvailable && String(plan.currency).toUpperCase() === 'INR' && Number(plan.price_minor) > 0;
    if (!starsPrice && !upiAvailable) return { plan, starsPrice: null, upiAvailable: false, unconfigured: true };
    return { plan, starsPrice, upiAvailable, unconfigured: false };
  }

  async function renderPremiumPlans(ctx, edit = false, ownerId = botOwnerScope) {
    const { enabledPlanCount, options } = await loadPremiumCheckoutOptions(ownerId);
    const isCreatorPlans = ownerId !== null && ownerId !== undefined;
    if (!options.length) {
      const msg = enabledPlanCount > 0
        ? '⚙️ Premium plans are currently being configured (no online payment method or Stars price is active yet). Please check back soon!'
        : (isCreatorPlans
            ? 'ℹ️ This creator does not have any active Premium plans available right now.'
            : 'ℹ️ No Premium plans are currently available for online checkout.');
      return edit ? ctx.editMessageText(msg) : ctx.reply(msg);
    }
    const buttons = options.map(({ plan, starsPrice, upiAvailable }) => {
      const parts = [];
      if (upiAvailable) parts.push(`UPI ${formatMoney(plan.price_minor, plan.currency)}`);
      if (starsPrice) parts.push(`${starsPrice} ⭐`);
      return [Markup.button.callback(`💎 ${plan.name} (${plan.duration_days}d) · ${parts.join(' / ')}`, `fs_premium_${plan.id}`)];
    });
    const text = isCreatorPlans
      ? [
          '💎 <b>Creator Premium Plans</b>',
          '━━━━━━━━━━━━━━━━━━',
          '',
          '⚡ <b>Skip this creator’s shortener checkpoints for instant ad-free downloads!</b>',
          '💳 Pay securely via <b>UPI QR Code</b> or <b>Telegram Stars ⭐</b>.',
          '',
          '👇 <i>Select a membership plan below:</i>',
        ].join('\n')
      : [
          '💎 <b>Upgrade to FileStore Premium</b>',
          '━━━━━━━━━━━━━━━━━━',
          '',
          '⚡ <b>Enjoy instant access with zero verification checkpoints!</b>',
          '💳 Pay seamlessly via <b>UPI QR Code</b> or <b>Telegram Stars ⭐</b>.',
          '',
          '👇 <i>Select a plan below:</i>',
        ].join('\n');
    const kb = { ...HTML, ...Markup.inlineKeyboard(buttons) };
    return edit ? ctx.editMessageText(text, kb) : ctx.reply(text, kb);
  }

  async function openPlanCheckout(ctx, planId, edit = false) {
    const match = await loadSinglePlanCheckoutOption(planId);
    if (!match) return ctx.reply('⚠️ This Premium plan is unavailable or disabled.');
    if (match.unconfigured) {
      return ctx.reply('⚙️ Online checkout is not active for this Premium plan yet. Please check back soon!');
    }
    const { plan, starsPrice, upiAvailable } = match;
    const backCb = plan.owner_telegram_id ? `fs_cprem_list:${plan.owner_telegram_id}` : 'fs_prem_list';
    if (upiAvailable && starsPrice) {
      const scopeTag = plan.owner_telegram_id ? 'Creator Premium Plan' : 'FileStore Premium Plan';
      const msg = `💎 <b>${escapeHtml(plan.name)}</b> (${plan.duration_days} days)\n<i>${scopeTag}</i>\n━━━━━━━━━━━━━━━━━━\n\n👇 <i>Choose your preferred payment method:</i>`;
      const kb = {
        ...HTML,
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`📲 Pay with UPI QR (${formatMoney(plan.price_minor, plan.currency)})`, `fs_prem_upi_${plan.id}`)],
          [Markup.button.callback(`⭐ Pay with Telegram Stars (${starsPrice} ⭐)`, `fs_prem_stars_${plan.id}`)],
          [Markup.button.callback('← Back to Plans', backCb)],
        ]),
      };
      return edit ? ctx.editMessageText(msg, kb).catch(() => ctx.reply(msg, kb)) : ctx.reply(msg, kb);
    }
    if (upiAvailable) {
      return await startFamPayPlanCheckout(ctx, plan);
    }
    return await sendStarsInvoice(bot, pool, ctx, 'premium', { planId: plan.id }, plan.name + ' Premium', plan.name + ' · ' + plan.duration_days + ' days access', token);
  }

  function formatVerificationSuccessMessage(result, utrOverride = null) {
    const utrText = escapeHtml(utrOverride ?? result.utr ?? 'matched');
    const fulfilled = result.fulfilled;
    if (fulfilled?.type === 'paid_batch') {
      return `🎉 <b>FamPay UPI Payment Verified!</b>\n━━━━━━━━━━━━━━━━━━\n\n🧾 <b>UTR:</b> <code>${utrText}</code>\n📦 All <b>${escapeHtml(fulfilled.fileCount ?? '')}</b> files in your batch are now unlocked!\n\n👉 Use <code>/batch_get &lt;code&gt;</code> or reopen your link to receive all files.`.trim();
    }
    if (fulfilled?.type === 'paid_file') {
      return `🎉 <b>FamPay UPI Payment Verified!</b>\n━━━━━━━━━━━━━━━━━━\n\n🧾 <b>UTR:</b> <code>${utrText}</code>\n🔓 Your file is now unlocked!\n\n👉 Use <code>/get &lt;file_code&gt;</code> or reopen your share link to receive it.`;
    }
    return `🎉 <b>FamPay UPI Payment Verified!</b>\n━━━━━━━━━━━━━━━━━━\n\n🧾 <b>UTR:</b> <code>${utrText}</code>\n💎 <b>Plan:</b> ${escapeHtml(fulfilled?.plan ?? 'Premium')}\n✨ Your Premium membership is now active!`;
  }

  async function startFamPayCheckout(ctx, { purpose, target, priceMinor, currency, label, itemSummary }) {
    const checkout = await createFamPayCheckout(pool, config, {
      userId: ctx.from.id,
      purpose,
      target,
      baseAmountMinor: priceMinor,
      currency,
      label,
      deliveryBotId: botNumericId ?? bot.botInfo?.id ?? null,
    });
    const caption = [
      `<b>💳 FamPay UPI Checkout</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      ``,
      `📦 <b>Item:</b> ${escapeHtml(itemSummary)}`,
      `💰 <b>Exact Amount to Pay:</b> <code>${escapeHtml(checkout.amountDisplay)}</code>`,
      `📲 <b>UPI ID:</b> <code>${escapeHtml(checkout.upiId)}</code>`,
      `🧾 <b>Reference:</b> <code>${escapeHtml(checkout.txnRef)}</code>`,
      ``,
      `⚠️ Pay the <b>exact amount</b> (<code>${escapeHtml(checkout.amountDisplay)}</code>) including paise so payment auto-verifies instantly.`,
      `⏳ <i>Expires in 15 minutes.</i>`,
    ].join('\n');

    await ctx.replyWithPhoto(
      { source: checkout.qrBuffer },
      {
        caption,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ I Paid — Verify Now', `fs_fp_chk:${checkout.session.id}`)],
          [
            Markup.button.callback('🔢 Enter 12-Digit UTR', `fs_fp_utr:${checkout.session.id}`),
            Markup.button.callback('✖ Cancel', `fs_fp_can:${checkout.session.id}`),
          ],
        ]),
      },
    );
  }

  async function startFamPayPlanCheckout(ctx, plan) {
    return startFamPayCheckout(ctx, {
      purpose: 'premium',
      target: { planId: plan.id },
      priceMinor: plan.price_minor,
      currency: plan.currency,
      label: `${plan.name} (${plan.duration_days}d)`,
      itemSummary: `${plan.name} (${plan.duration_days} days)`,
    });
  }

  bot.command('premium', async (ctx) => {
    try {
      await upsertTelegramUser(pool, ctx.from);
      await renderPremiumPlans(ctx, false);
    } catch (error) {
      logger.warn({ error: error.message }, 'Premium listing failed');
      return ctx.reply('❌ Could not load Premium plans.');
    }
  });

  bot.action('fs_prem_list', async (ctx) => {
    await safeAnswer(ctx);
    try { await renderPremiumPlans(ctx, true, botOwnerScope); }
    catch { await ctx.reply('❌ Could not load Premium plans.'); }
  });

  bot.action(/^fs_cprem_list:(\d+)$/, async (ctx) => {
    await safeAnswer(ctx);
    const creatorId = Number(ctx.match[1]);
    try { await renderPremiumPlans(ctx, true, creatorId); }
    catch { await ctx.reply('❌ Could not load creator Premium plans.'); }
  });

  bot.action(/^fs_premium_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await upsertTelegramUser(pool, ctx.from);
      const planId = Number(ctx.match[1]);
      return await openPlanCheckout(ctx, planId, true);
    } catch (error) {
      logger.warn({ error: error.message, userId: ctx.from.id }, 'Premium checkout failed');
      return ctx.reply('❌ Premium checkout unavailable: ' + error.message);
    }
  });

  bot.action(/^fs_prem_stars_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await upsertTelegramUser(pool, ctx.from);
      const planId = Number(ctx.match[1]);
      const planResult = await pool.query('SELECT id,name,duration_days FROM premium_plans WHERE id=$1 AND is_enabled=TRUE', [planId]);
      if (!planResult.rowCount) return ctx.reply('⚠️ Plan is unavailable.');
      const plan = planResult.rows[0];
      await sendStarsInvoice(bot, pool, ctx, 'premium', { planId }, plan.name + ' Premium', plan.name + ' · ' + plan.duration_days + ' days access', token);
    } catch (error) {
      logger.warn({ error: error.message, userId: ctx.from.id }, 'Premium Stars invoice failed');
      return ctx.reply('❌ Stars checkout unavailable: ' + error.message);
    }
  });

  bot.action(/^fs_prem_upi_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('Generating UPI QR code… 📲');
      await upsertTelegramUser(pool, ctx.from);
      const planId = Number(ctx.match[1]);
      const planResult = await pool.query('SELECT id,name,price_minor,currency,duration_days FROM premium_plans WHERE id=$1 AND is_enabled=TRUE', [planId]);
      if (!planResult.rowCount) return ctx.reply('⚠️ Plan is unavailable.');
      await startFamPayPlanCheckout(ctx, planResult.rows[0]);
    } catch (error) {
      logger.warn({ error: error.message, userId: ctx.from.id }, 'FamPay UPI QR generation failed');
      return ctx.reply('❌ UPI QR checkout unavailable: ' + error.message);
    }
  });

  bot.action(/^fs_fp_chk:(\d+)$/, async (ctx) => {
    const sessionId = Number(ctx.match[1]);
    try {
      await ctx.answerCbQuery('Checking FamPay payment via Gmail… 🔍');
      const result = await verifyFamPaySession(pool, config, sessionId, { userId: ctx.from.id });
      if (result.status === 'verified' || result.status === 'already_applied') {
        pendingUtrInputs.delete(String(ctx.from.id));
        return ctx.reply(formatVerificationSuccessMessage(result), HTML);
      }
      if (result.status === 'expired') {
        pendingUtrInputs.delete(String(ctx.from.id));
        return ctx.reply('⏳ This UPI checkout session has expired. Start a new checkout whenever you are ready.');
      }
      return ctx.reply('⏳ Payment email not detected yet. Wait 10–20 seconds after completing the UPI transfer and tap "✅ I Paid — Verify Now" again, or tap "🔢 Enter 12-Digit UTR".');
    } catch (error) {
      logger.warn({ error: error.message, sessionId, userId: ctx.from.id }, 'FamPay verification check failed');
      return ctx.reply('❌ Verification error: ' + error.message);
    }
  });

  bot.action(/^fs_fp_utr:(\d+)$/, async (ctx) => {
    const sessionId = Number(ctx.match[1]);
    setUtrPrompt(ctx.from.id, sessionId);
    await safeAnswer(ctx);
    return ctx.reply('🔢 <b>Enter Your UPI UTR</b>\n\nSend your 12-digit UPI UTR / Reference number for this payment:', HTML);
  });

  bot.action(/^fs_fp_can:(\d+)$/, async (ctx) => {
    const sessionId = Number(ctx.match[1]);
    pendingUtrInputs.delete(String(ctx.from.id));
    const cancelled = await cancelFamPaySession(pool, sessionId, ctx.from.id);
    await safeAnswer(ctx, cancelled ? 'Payment cancelled.' : 'Session already closed.');
    if (cancelled) {
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      await ctx.reply('✖ UPI checkout cancelled.');
    }
  });

  bot.on('text', async (ctx, next) => {
    const text = ctx.message?.text?.trim() ?? '';
    if (text.startsWith('/')) {
      if (ctx.from?.id) pendingUtrInputs.delete(String(ctx.from.id));
      return next();
    }
    const sessionId = ctx.from?.id ? getUtrPrompt(ctx.from.id) : null;
    if (!sessionId) return next();

    try {
      const result = await verifyFamPaySession(pool, config, sessionId, {
        userId: ctx.from.id,
        submittedUtr: text,
      });
      if (result.status === 'verified' || result.status === 'already_applied') {
        pendingUtrInputs.delete(String(ctx.from.id));
        return ctx.reply(formatVerificationSuccessMessage(result, text), HTML);
      }
      if (result.status === 'expired') {
        pendingUtrInputs.delete(String(ctx.from.id));
        return ctx.reply('⏳ This UPI checkout session has expired. Please start a new checkout.');
      }
      return ctx.reply('⏳ No matching payment email with that UTR and exact amount was found yet. Wait a few seconds and send the 12-digit UTR again or tap Verify Now.');
    } catch (error) {
      return ctx.reply('❌ UTR check failed: ' + error.message);
    }
  });


  async function openPaidFileCheckout(ctx, linkCode, { deliverIfAlreadyPaid = false } = {}) {
    await upsertTelegramUser(pool, ctx.from);
    const link = await getPaidFileLink(pool, linkCode);
    if (!link || !link.is_active) return ctx.reply('⚠️ Paid link is invalid, expired, or disabled.');
    await recordLinkOpen(pool, 'paid_file', link.id, ctx.from.id, workerScope.deliveryBotId).catch((error) => logger.warn({ error: error.message }, 'Paid link view tracking failed'));
    const creatorOwnerScope = resolveCreatorScope(link.created_by);
    const forceSub = await enforceForceSub(ctx, ctx.telegram, pool, ctx.from.id, logger, 'Then use /verify and retry.', creatorOwnerScope);
    if (!forceSub.passed) return;
    const purchase = await requestPaidFilePurchase(pool, linkCode, ctx.from);
    if (purchase.alreadyPaid) {
      if (deliverIfAlreadyPaid) {
        const file = await getIndexedFile(pool, link.file_code);
        if (!file?.telegram_message_id || !file.storage_chat_id || !file.storage_channel_enabled) {
          return ctx.reply('⚠️ You already unlocked this file, but storage is currently unavailable.');
        }
        const jobId = await createSingleDeliveryJob(pool, ctx.from.id, file.id, ctx.from.id, workerScope.deliveryBotId);
        return ctx.reply(
          `✅ <b>Paid access verified. Delivery queued.</b>\n━━━━━━━━━━━━━━━━━━\n\n📄 <b>File:</b> ${escapeHtml(file.file_name)}\n🆔 <b>Job ID: ${jobId}</b>\n\n🚀 <i>Your file is on the way!</i>`,
          HTML,
        );
      }
      return ctx.reply(`🔓 You already unlocked this file! Use <code>/get ${escapeHtml(link.file_code)}</code> to request delivery.`, HTML);
    }

    const [starsCfg, fpConfig] = await Promise.all([
      getStarsConfig(pool),
      loadFamPayConfig(pool, config.tokenEncryptionKey),
    ]);
    const starsPrice = starsCfg ? getTelegramStarsPrice(starsCfg, 'paid_file', { paidLinkId: link.id }) : null;
    const upiAvailable = fpConfig.isEnabled && fpConfig.isConfigured && String(link.currency).toUpperCase() === 'INR' && Number(link.price_minor) > 0;

    if (upiAvailable && starsPrice) {
      return ctx.reply(
        `🏷 <b>Unlock File:</b> ${escapeHtml(link.file_name)}\n━━━━━━━━━━━━━━━━━━\n\n👇 <i>Choose your preferred payment method:</i>`,
        {
          ...HTML,
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`📲 Pay with UPI QR (${formatMoney(link.price_minor, link.currency)})`, `fs_paid_upi_${link.id}`)],
            [Markup.button.callback(`⭐ Pay with Telegram Stars (${starsPrice} ⭐)`, `fs_paid_stars_${link.id}`)],
          ]),
        },
      );
    }
    if (upiAvailable) {
      return await startFamPayCheckout(ctx, {
        purpose: 'paid_file',
        target: { paidLinkId: link.id, fileId: link.file_id },
        priceMinor: link.price_minor,
        currency: link.currency,
        label: `File ${link.file_code}`,
        itemSummary: `${link.file_name} (${link.file_code})`,
      });
    }
    if (starsPrice) {
      return await sendStarsInvoice(bot, pool, ctx, 'paid_file', { paidLinkId: link.id, fileId: link.file_id }, 'Unlock file', 'Unlock ' + String(link.file_name).slice(0, 100), token);
    }
    return ctx.reply(
      `🏷 <b>Purchase Request Recorded</b>\n━━━━━━━━━━━━━━━━━━\n\n📄 <b>File:</b> ${escapeHtml(link.file_name)}\n💰 <b>Price:</b> ${escapeHtml(formatMoney(link.price_minor, link.currency))}\n🔑 <b>Link Code:</b> <code>${escapeHtml(link.public_code)}</code>\n\n⏳ <i>Online checkout is not enabled for this item yet. Ask the administrator to confirm your purchase.</i>`,
      HTML,
    );
  }

  async function openPaidBatchCheckout(ctx, code, { deliverIfAlreadyPaid = false } = {}) {
    await upsertTelegramUser(pool, ctx.from);
    const batch = await getPaidBatch(pool, code);
    if (!batch || !batch.is_active) return ctx.reply('⚠️ Batch link invalid, expired, or disabled.');
    await recordLinkOpen(pool, 'paid_batch', batch.id, ctx.from.id, workerScope.deliveryBotId).catch((error) => logger.warn({ error: error.message }, 'Paid batch view tracking failed'));
    const creatorOwnerScope = resolveCreatorScope(batch.created_by);
    const forceSub = await enforceForceSub(ctx, ctx.telegram, pool, ctx.from.id, logger, 'Then verify and retry.', creatorOwnerScope);
    if (!forceSub.passed) return;
    const result = await requestPaidBatchPurchase(pool, code, ctx.from);
    if (result.alreadyPaid) {
      if (deliverIfAlreadyPaid) {
        const items = await getBatchItems(pool, code);
        if (!items.length) return ctx.reply('⚠️ This batch has no files.');
        for (const item of items) {
          if (!item.telegram_message_id || !item.storage_chat_id || !item.storage_channel_enabled) {
            return ctx.reply('⚠️ You already unlocked this batch, but one or more files have no usable storage message.');
          }
        }
        const jobId = await createBatchDeliveryJob(pool, ctx.from.id, items.map((i) => i.id), ctx.from.id, workerScope.deliveryBotId);
        return ctx.reply(
          `✅ <b>Paid batch verified. Delivery queued.</b>\n━━━━━━━━━━━━━━━━━━\n\n📚 <b>Collection:</b> ${escapeHtml(batch.title)}\n📦 <b>Files:</b> ${items.length}\n🆔 <b>Job ID: ${jobId}</b>\n\n🚀 <i>Your files are being sent now!</i>`,
          HTML,
        );
      }
      return ctx.reply(`🔓 You have already unlocked this batch! Use <code>/batch_get ${escapeHtml(code)}</code> to deliver all files.`, HTML);
    }

    const [starsCfg, fpConfig] = await Promise.all([
      getStarsConfig(pool),
      loadFamPayConfig(pool, config.tokenEncryptionKey),
    ]);
    const starsPrice = starsCfg ? getTelegramStarsPrice(starsCfg, 'paid_batch', { batchLinkId: batch.id }) : null;
    const upiAvailable = fpConfig.isEnabled && fpConfig.isConfigured && String(batch.currency).toUpperCase() === 'INR' && Number(batch.price_minor) > 0;

    if (upiAvailable && starsPrice) {
      return ctx.reply(
        `📚 <b>Unlock Batch:</b> ${escapeHtml(batch.title)} (${batch.item_count} files)\n━━━━━━━━━━━━━━━━━━\n\n👇 <i>Choose your preferred payment method:</i>`,
        {
          ...HTML,
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`📲 Pay with UPI QR (${formatMoney(batch.price_minor, batch.currency)})`, `fs_batch_upi_${batch.id}`)],
            [Markup.button.callback(`⭐ Pay with Telegram Stars (${starsPrice} ⭐)`, `fs_batch_stars_${batch.id}`)],
          ]),
        },
      );
    }
    if (upiAvailable) {
      return await startFamPayCheckout(ctx, {
        purpose: 'paid_batch',
        target: { batchLinkId: batch.id },
        priceMinor: batch.price_minor,
        currency: batch.currency,
        label: `Batch ${batch.title}`,
        itemSummary: `${batch.title} (${batch.item_count} files)`,
      });
    }
    if (starsPrice) {
      return await sendStarsInvoice(bot, pool, ctx, 'paid_batch', { batchLinkId: batch.id }, 'Unlock batch', 'Unlock ' + String(batch.title).slice(0, 100) + ' (' + batch.item_count + ' files)', token);
    }
    return ctx.reply(
      `📚 <b>Batch Purchase Request Recorded</b>\n━━━━━━━━━━━━━━━━━━\n\n🏷 <b>Collection:</b> ${escapeHtml(batch.title)} (${batch.item_count} files)\n💰 <b>Price:</b> ${escapeHtml(formatMoney(batch.price_minor, batch.currency))}\n🔑 <b>Batch Code:</b> <code>${escapeHtml(batch.public_code)}</code>\n\n⏳ <i>Online checkout is not enabled for this batch yet. Ask the administrator to confirm your purchase.</i>`,
      HTML,
    );
  }

  bot.command('start', async (ctx) => {
    await upsertTelegramUser(pool, ctx.from);
    const payload = (ctx.startPayload ?? getCommandArgs(ctx)[0] ?? '').trim();
    if (!payload) {
      if (Array.isArray(config?.adminIds) && config.adminIds.length > 0 && isAdmin(ctx.from.id, config.adminIds)) {
        await ctx.reply(
          [
            '🤖 <b>FileStore Delivery Bot</b> <i>(Owner Mode)</i>',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '🛡 <code>/admin</code> — Owner diagnostics menu',
            '📊 <code>/admin status</code> — Inspect delivery queue stats',
            '🧪 <code>/admin test</code> — Test storage &amp; force-sub access',
            '📥 <code>/get &lt;file_code&gt;</code> — Queue a file delivery',
            '✅ <code>/verify</code> — Check channel subscriptions',
            '💎 <code>/premium</code> — Test Premium checkout',
            '🔐 <code>/checkpoint_status</code> — Check verification state',
            '🔎 <code>/access_status</code> — Full access &amp; Premium status',
          ].join('\n'),
          HTML,
        );
      } else {
        await ctx.reply(
          [
            '✨ <b>Welcome to FileStore Delivery!</b>',
            '━━━━━━━━━━━━━━━━━━',
            '',
            '📥 Tap any FileStore share link to receive your files instantly.',
            '',
            '⚡ <b>Useful Commands</b>',
            '• <code>/verify</code> — Check required channel subscriptions',
            '• <code>/get &lt;file_code&gt;</code> — Request a file by code',
            '• <code>/premium</code> — Upgrade for ad-free instant access 💎',
            '• <code>/paid &lt;code&gt;</code> or <code>/batch &lt;code&gt;</code> — Unlock paid items',
            '• <code>/access_status</code> — Check your current access level',
          ].join('\n'),
          HTML,
        );
      }
      return;
    }

    try {
      if (/^chk_/i.test(payload)) {
        const chkToken = payload.slice(4);
        if (!chkToken) return ctx.reply('⚠️ Invalid verification link.');
        try {
          const verified = await applyVerifiedCheckpoint(pool, chkToken, 'signed_callback');
          await pool.query(
            'INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details) VALUES ($1, $2, $2, $3::jsonb)',
            ['checkpoint_verified', ctx.from.id, JSON.stringify({ providerId: verified.providerId, providerName: verified.providerName, checkpointMinutes: verified.checkpointMinutes })],
          ).catch(() => {});
          return ctx.reply(
            [
              `🎉 <b>Verification Complete!</b> (${escapeHtml(verified.providerName)})`,
              '━━━━━━━━━━━━━━━━━━',
              '',
              `🔓 Free file access is now unlocked for <b>${verified.checkpointMinutes} minute(s)</b>`,
              `⏳ <b>Valid until:</b> ${escapeHtml(new Date(verified.expiresAt).toLocaleString())}`,
              '',
              '🚀 <i>Tap your file link again or use <code>/get &lt;file_code&gt;</code> to receive your files!</i>',
            ].join('\n'),
            HTML,
          );
        } catch (err) {
          logger.warn({ error: err.message, userId: ctx.from.id }, 'Checkpoint callback verification failed');
          return ctx.reply('⚠️ Verification link is invalid, already used, or expired. Request the file again to get a new verification link.');
        }
      }
      if (/^paid_/i.test(payload)) {
        return await openPaidFileCheckout(ctx, payload.slice(5), { deliverIfAlreadyPaid: true });
      }
      if (/^pbatch_/i.test(payload)) {
        return await openPaidBatchCheckout(ctx, payload.slice(7), { deliverIfAlreadyPaid: true });
      }
      const premPlanMatch = /^prem_(\d+)$/i.exec(payload);
      if (premPlanMatch) {
        return await openPlanCheckout(ctx, Number(premPlanMatch[1]), false);
      }
      const creatorPremMatch = /^cprem_(\d+)$/i.exec(payload);
      if (creatorPremMatch) {
        return await renderPremiumPlans(ctx, false, Number(creatorPremMatch[1]));
      }

      const adminUser = isAdmin(ctx.from.id, config.adminIds);
      const shareLink = await getShareLinkByCode(pool, payload);
      if (shareLink) {
        if (!shareLink.is_enabled) {
          return ctx.reply('⏸ This share link is currently disabled.');
        }
        await recordLinkOpen(pool, 'share', shareLink.id, ctx.from.id, workerScope.deliveryBotId).catch((error) => logger.warn({ error: error.message }, 'Share link view tracking failed'));
        const activeItems = shareLink.items.filter((item) => item.file_status === 'active');
        if (!activeItems.length) {
          return ctx.reply('📭 No active media files remain in this share link.');
        }

        const creatorOwnerScope = resolveCreatorScope(shareLink.created_by);
        if (!adminUser) {
          const forceSub = await enforceForceSub(ctx, ctx.telegram, pool, ctx.from.id, logger, 'Then tap Verify and open the link again.', creatorOwnerScope);
          if (!forceSub.passed) return;

          for (const item of activeItems) {
            const check = await verifyFileDeliveryAccess(ctx, pool, config, logger, bot.botInfo, ctx.from.id, item.file_id, forceSub, '🔒 One or more files in this link require purchase first.', creatorOwnerScope);
            if (!check.allowed) return;
          }
        }

        for (const item of activeItems) {
          if (!item.telegram_message_id || !item.storage_chat_id || !item.storage_channel_enabled) {
            return ctx.reply('⚠️ One or more files currently have no usable storage message.');
          }
        }

        if (activeItems.length === 1) {
          const jobId = await createSingleDeliveryJob(pool, ctx.from.id, activeItems[0].file_id, ctx.from.id, workerScope.deliveryBotId);
          return ctx.reply(
            `🚀 <b>Delivery queued.</b>\n━━━━━━━━━━━━━━━━━━\n\n🏷 <b>Title:</b> ${escapeHtml(shareLink.title)}\n📄 <b>File:</b> ${escapeHtml(activeItems[0].file_name)}\n🆔 <b>Job ID: ${jobId}</b>`,
            HTML,
          );
        }

        const jobId = await createBatchDeliveryJob(pool, ctx.from.id, activeItems.map((i) => i.file_id), ctx.from.id, workerScope.deliveryBotId);
        return ctx.reply(
          `📦 <b>Batch delivery queued.</b>\n━━━━━━━━━━━━━━━━━━\n\n📚 <b>Collection:</b> ${escapeHtml(shareLink.title)}\n📄 <b>Files:</b> ${activeItems.length}\n🆔 <b>Job ID: ${jobId}</b>`,
          HTML,
        );
      }

      // Fallback: direct /start <FILE_CODE>
      const directFile = await getIndexedFile(pool, payload);
      if (!directFile) {
        return ctx.reply('🔍 Share link not found or expired.');
      }
      const creatorOwnerScope = resolveCreatorScope(directFile.uploaded_by);
      if (!adminUser) {
        const forceSub = await enforceForceSub(ctx, ctx.telegram, pool, ctx.from.id, logger, 'Then tap Verify.', creatorOwnerScope);
        if (!forceSub.passed) return;
        const check = await verifyFileDeliveryAccess(ctx, pool, config, logger, bot.botInfo, ctx.from.id, directFile.id, forceSub, undefined, creatorOwnerScope);
        if (!check.allowed) return;
      }
      if (!directFile.telegram_message_id || !directFile.storage_chat_id || !directFile.storage_channel_enabled) {
        return ctx.reply('⚠️ This file currently has no usable storage message.');
      }
      const jobId = await createSingleDeliveryJob(pool, ctx.from.id, directFile.id, ctx.from.id, workerScope.deliveryBotId);
      return ctx.reply(
        `🚀 <b>Delivery queued.</b>\n━━━━━━━━━━━━━━━━━━\n\n📄 <b>File:</b> ${escapeHtml(directFile.file_name)}\n🆔 <b>Job ID: ${jobId}</b>`,
        HTML,
      );
    } catch (error) {
      logger.error({ error: error.message, userId: ctx.from.id }, 'Deep-link start fulfillment failed');
      return ctx.reply('❌ Could not process this link right now. Please try again later.');
    }
  });

  bot.command('paid', async (ctx) => {
    const linkCode = getCommandArgs(ctx)[0] ?? '';
    if (!linkCode) return ctx.reply('ℹ️ Usage: /paid <paid_link_code>');
    try {
      return await openPaidFileCheckout(ctx, linkCode, { deliverIfAlreadyPaid: false });
    } catch (error) {
      logger.error({ error: error.message, userId: ctx.from.id }, 'Paid file request failed');
      await ctx.reply('❌ Could not create purchase request: ' + error.message);
    }
  });

  bot.action(/^fs_paid_(upi|stars)_(\d+)$/, async (ctx) => {
    const mode = ctx.match[1];
    const linkId = Number(ctx.match[2]);
    try {
      await ctx.answerCbQuery(mode === 'upi' ? 'Generating UPI QR code… 📲' : undefined);
      await upsertTelegramUser(pool, ctx.from);
      const res = await pool.query(
        `SELECT pfl.id, pfl.public_code, pfl.file_id, pfl.price_minor, pfl.currency, pfl.is_enabled, pfl.expires_at,
                f.file_code, f.file_name
         FROM paid_file_links pfl JOIN files f ON f.id = pfl.file_id
         WHERE pfl.id = $1 LIMIT 1`,
        [linkId],
      );
      const link = res.rows[0];
      if (!link || !link.is_enabled || (link.expires_at && new Date(link.expires_at) <= new Date())) {
        return ctx.reply('⚠️ Paid link is invalid, expired, or disabled.');
      }
      if (mode === 'upi') {
        return await startFamPayCheckout(ctx, {
          purpose: 'paid_file',
          target: { paidLinkId: link.id, fileId: link.file_id },
          priceMinor: link.price_minor,
          currency: link.currency,
          label: `File ${link.file_code}`,
          itemSummary: `${link.file_name} (${link.file_code})`,
        });
      }
      return await sendStarsInvoice(bot, pool, ctx, 'paid_file', { paidLinkId: link.id, fileId: link.file_id }, 'Unlock file', 'Unlock ' + String(link.file_name).slice(0, 100), token);
    } catch (error) {
      logger.warn({ error: error.message, userId: ctx.from.id, linkId }, 'Paid file checkout option failed');
      return ctx.reply('❌ Checkout unavailable: ' + error.message);
    }
  });

  bot.command('batch', async (ctx) => {
    const code = getCommandArgs(ctx)[0] ?? '';
    if (!code) return ctx.reply('ℹ️ Usage: /batch <batch_link_code>');
    try {
      return await openPaidBatchCheckout(ctx, code, { deliverIfAlreadyPaid: false });
    } catch (error) {
      logger.error({ userId: ctx.from.id, error: error.message }, 'Batch purchase request failed');
      return ctx.reply('❌ Could not create batch purchase request: ' + error.message);
    }
  });

  bot.action(/^fs_batch_(upi|stars)_(\d+)$/, async (ctx) => {
    const mode = ctx.match[1];
    const batchId = Number(ctx.match[2]);
    try {
      await ctx.answerCbQuery(mode === 'upi' ? 'Generating UPI QR code… 📲' : undefined);
      await upsertTelegramUser(pool, ctx.from);
      const res = await pool.query(
        `SELECT b.id, b.public_code, b.title, b.price_minor, b.currency, b.is_enabled, b.expires_at,
                COUNT(i.file_id)::int AS item_count
         FROM paid_batch_links b LEFT JOIN paid_batch_items i ON i.batch_link_id = b.id
         WHERE b.id = $1 GROUP BY b.id LIMIT 1`,
        [batchId],
      );
      const batch = res.rows[0];
      if (!batch || !batch.is_enabled || (batch.expires_at && new Date(batch.expires_at) <= new Date())) {
        return ctx.reply('⚠️ Batch link invalid, expired, or disabled.');
      }
      if (mode === 'upi') {
        return await startFamPayCheckout(ctx, {
          purpose: 'paid_batch',
          target: { batchLinkId: batch.id },
          priceMinor: batch.price_minor,
          currency: batch.currency,
          label: `Batch ${batch.title}`,
          itemSummary: `${batch.title} (${batch.item_count} files)`,
        });
      }
      return await sendStarsInvoice(bot, pool, ctx, 'paid_batch', { batchLinkId: batch.id }, 'Unlock batch', 'Unlock ' + String(batch.title).slice(0, 100) + ' (' + batch.item_count + ' files)', token);
    } catch (error) {
      logger.warn({ error: error.message, userId: ctx.from.id, batchId }, 'Paid batch checkout option failed');
      return ctx.reply('❌ Checkout unavailable: ' + error.message);
    }
  });

  bot.command('batch_get', async (ctx) => {
    const code = getCommandArgs(ctx)[0] ?? '';
    if (!code) return ctx.reply('ℹ️ Usage: /batch_get <batch_link_code>');
    try {
      await upsertTelegramUser(pool, ctx.from);
      const batch = await getPaidBatch(pool, code);
      if (!batch || !batch.is_active) return ctx.reply('⚠️ Batch link invalid, expired, or disabled.');
      const creatorOwnerScope = resolveCreatorScope(batch.created_by);
      const forceSub = await enforceForceSub(ctx, ctx.telegram, pool, ctx.from.id, logger, 'Verify before requesting delivery.', creatorOwnerScope);
      if (!forceSub.passed) return;
      const items = await getBatchItems(pool, code);
      if (!items.length) return ctx.reply('📭 This batch has no files.');
      for (const item of items) {
        const entitled = await hasPaidFileEntitlement(pool, ctx.from.id, item.id);
        if (!entitled) return ctx.reply(`🔒 Batch is not unlocked for your account. Request it using <code>/batch ${escapeHtml(code)}</code> and complete payment first.`, HTML);
        if (!item.telegram_message_id || !item.storage_chat_id || !item.storage_channel_enabled) return ctx.reply('⚠️ One or more files have no usable storage message. Admin needs to repair the batch storage.');
      }
      const jobId = await createBatchDeliveryJob(pool, ctx.from.id, items.map((item) => item.id), ctx.from.id, workerScope.deliveryBotId);
      return ctx.reply(
        `📦 <b>Batch delivery queued.</b> Files will be delivered sequentially.\n━━━━━━━━━━━━━━━━━━\n\n📚 <b>Collection:</b> ${escapeHtml(batch.title)}\n📄 <b>Files:</b> ${items.length}\n🆔 <b>Job ID: ${jobId}</b>`,
        HTML,
      );
    } catch (error) {
      logger.error({ userId: ctx.from.id, error: error.message }, 'Batch delivery request failed');
      return ctx.reply('❌ Could not queue this batch.');
    }
  });

  bot.command('verify', async (ctx) => {
    try {
      await upsertTelegramUser(pool, ctx.from);
      await showForceSubStatus(ctx, ctx.telegram, pool, ctx.from.id, logger);
    } catch (error) {
      logger.warn({ userId: ctx.from.id, error: error.message }, 'Force-sub verification command failed');
      await ctx.reply('⚠️ Subscription verification is temporarily unavailable. Please try again later.');
    }
  });

  bot.action(/^fs_verify(?::(\d+))?$/, async (ctx) => {
    try {
      await ctx.answerCbQuery('Checking subscriptions… 🔍');
      await upsertTelegramUser(pool, ctx.from);
      const ownerScope = ctx.match?.[1] ? Number(ctx.match[1]) : null;
      const result = await checkForceSubscription(ctx.telegram, pool, ctx.from.id, ownerScope);
      await logForceSubEvent(pool, logger, result.passed ? 'force_sub_verified' : 'force_sub_blocked', ctx.from.id, result);
      if (result.passed) {
        try { await ctx.editMessageText('✅ <b>Subscription verification passed!</b>\n\nAll required channels are joined — open your link again to receive your files! 🚀', HTML); } catch {}
      } else {
        const labels = result.missing.map((channel) => `• 📢 <b>${escapeHtml(channel.title ?? channel.telegram_chat_id)}</b>${channel.checkStatus === 'check_failed' ? ' <i>(verification unavailable)</i>' : ''}`).join('\n');
        try {
          await ctx.editMessageText(
            `🔒 <b>Some channels are still missing:</b>\n\n${labels}\n\n👉 <i>Join them and tap Verify again.</i>`,
            { ...HTML, ...getMissingSubscriptionMarkup(result.missing, ownerScope) },
          );
        } catch {}
      }
    } catch (error) {
      logger.warn({ userId: ctx.from.id, error: error.message }, 'Force-sub callback verification failed');
      await ctx.answerCbQuery('Verification temporarily unavailable. Try again.', { show_alert: true }).catch(() => {});
    }
  });

  bot.command('get', async (ctx) => {
    const code = getCommandArgs(ctx)[0] ?? '';
    if (!code) return ctx.reply('ℹ️ Usage: /get <file_code>');
    try {
      const file = await getIndexedFile(pool, code);
      if (!file) return ctx.reply('🔍 File code not found.');
      const creatorOwnerScope = resolveCreatorScope(file.uploaded_by);
      if (!isAdmin(ctx.from.id, config.adminIds)) {
        await upsertTelegramUser(pool, ctx.from);
        const forceSub = await enforceForceSub(ctx, ctx.telegram, pool, ctx.from.id, logger, 'Then tap Verify.', creatorOwnerScope);
        if (!forceSub.passed) return;
        const access = await verifyFileDeliveryAccess(ctx, pool, config, logger, bot.botInfo, ctx.from.id, file.id, forceSub, undefined, creatorOwnerScope);
        if (!access.allowed) return;
        if (!file.telegram_message_id || !file.storage_chat_id || !file.storage_channel_enabled) return ctx.reply('⚠️ This file currently has no usable storage message.');
        const jobId = await createSingleDeliveryJob(pool, ctx.from.id, file.id, ctx.from.id, workerScope.deliveryBotId);
        const prefix = access.paidEntitled ? 'Paid access verified.' : 'Access verified.';
        return ctx.reply(
          `✅ <b>${prefix} Delivery queued.</b>\n━━━━━━━━━━━━━━━━━━\n\n📄 <b>File:</b> ${escapeHtml(file.file_name)}\n🆔 <b>Job ID: ${jobId}</b>`,
          HTML,
        );
      }
      if (!file.telegram_message_id || !file.storage_chat_id || !file.storage_channel_enabled) return ctx.reply('⚠️ This file has no usable message in an enabled storage channel.');
      const jobId = await createSingleDeliveryJob(pool, ctx.from.id, file.id, ctx.from.id, workerScope.deliveryBotId);
      await ctx.reply(
        `🚀 <b>Delivery queued.</b>\n━━━━━━━━━━━━━━━━━━\n\n📄 <b>File:</b> ${escapeHtml(file.file_name)}\n🆔 <b>Job ID: ${jobId}</b>`,
        HTML,
      );
    } catch (error) {
      logger.error({ error: error.message, userId: ctx.from.id }, 'Delivery request creation failed');
      await ctx.reply('❌ Could not queue this delivery.');
    }
  });

  bot.command('checkpoint_status', async (ctx) => {
    try {
      await upsertTelegramUser(pool, ctx.from);
      const setting = await pool.query("SELECT value FROM app_settings WHERE key = 'checkpoint_enabled' LIMIT 1");
      if (!setting.rowCount || setting.rows[0].value !== true) return ctx.reply('🟢 Checkpoint enforcement is currently <b>OFF</b>.', HTML);
      const requirement = await getCheckpointRequirement(pool, ctx.from.id);
      if (requirement.reason === 'checkpoint_active') return ctx.reply(`✅ <b>Checkpoint Active</b>\n⏳ Unlocked until: ${escapeHtml(new Date(requirement.expiresAt).toLocaleString())}`, HTML);
      if (requirement.reason === 'no_active_providers') return ctx.reply('🟢 No active checkpoint providers. Checkpoints are not currently required.');
      if (requirement.blocked) return ctx.reply(`⚠️ Checkpoint provider <b>${escapeHtml(requirement.provider?.name ?? 'unknown')}</b> is unverified. Admin needs to configure verification mode.`, HTML);
      return ctx.reply(
        `🔐 <b>Checkpoint Required</b>\n━━━━━━━━━━━━━━━━━━\n\n🌐 <b>Provider:</b> ${escapeHtml(requirement.provider.name)} (${requirement.step}/${requirement.total})\n\n👉 <i>Open a file link or run <code>/get &lt;file_code&gt;</code> to receive your verification link.</i>`,
        HTML,
      );
    } catch (error) {
      logger.warn({ userId: ctx.from.id, error: error.message }, 'Checkpoint status failed');
      return ctx.reply('⚠️ Checkpoint status unavailable. Try again later.');
    }
  });

  bot.command('access_status', async (ctx) => {
    try {
      await upsertTelegramUser(pool, ctx.from);
      const forceSub = await checkForceSubscription(ctx.telegram, pool, ctx.from.id);
      const premium = await pool.query(
        `SELECT p.name, m.expires_at, m.owner_telegram_id, u.username AS creator_username
         FROM premium_memberships m
         LEFT JOIN premium_plans p ON p.id = m.plan_id
         LEFT JOIN users u ON u.telegram_id = m.owner_telegram_id
         WHERE m.user_telegram_id = $1 AND m.status = 'active' AND m.starts_at <= NOW() AND (m.expires_at IS NULL OR m.expires_at > NOW())
         ORDER BY m.owner_telegram_id NULLS FIRST, m.expires_at DESC NULLS FIRST LIMIT 10`,
        [ctx.from.id],
      );
      const checkpointSetting = await pool.query("SELECT value FROM app_settings WHERE key = 'checkpoint_enabled' LIMIT 1");
      const checkpointEnabled = checkpointSetting.rowCount && checkpointSetting.rows[0].value === true;
      const checkpoint = checkpointEnabled ? await getCheckpointRequirement(pool, ctx.from.id) : { reason: 'checkpoint_disabled' };
      const platformPrem = premium.rows.find((r) => r.owner_telegram_id === null || r.owner_telegram_id === undefined);
      const creatorPrems = premium.rows.filter((r) => r.owner_telegram_id !== null && r.owner_telegram_id !== undefined);
      const lines = [
        '🔎 <b>Your Access Status</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        '📢 <b>Force-Sub:</b> ' + (forceSub.passed ? '✅ Passed' : `🔒 Required (${forceSub.missing.length} channel(s))`),
        '💎 <b>Platform Premium:</b> ' + (platformPrem ? '🌟 Active' + (platformPrem.expires_at ? ' until ' + escapeHtml(new Date(platformPrem.expires_at).toLocaleString()) : ' (permanent)') : '⚪ Inactive'),
      ];
      if (creatorPrems.length) {
        lines.push('✨ <b>Creator Premium Memberships:</b>');
        for (const cp of creatorPrems) {
          const ownerLabel = cp.creator_username ? `@${escapeHtml(cp.creator_username)}` : `Creator #${escapeHtml(cp.owner_telegram_id)}`;
          const expLabel = cp.expires_at ? `until ${escapeHtml(new Date(cp.expires_at).toLocaleString())}` : 'permanent';
          lines.push(`• 💎 <b>${escapeHtml(cp.name ?? 'Premium')}</b> (${ownerLabel}) — ${expLabel}`);
        }
      }
      lines.push('🔐 <b>Checkpoint:</b> ' + (checkpoint.reason === 'checkpoint_disabled' ? '🟢 Off' : checkpoint.reason === 'checkpoint_active' ? '✅ Active until ' + escapeHtml(new Date(checkpoint.expiresAt).toLocaleString()) : checkpoint.reason === 'no_active_providers' ? '🟢 No provider available' : checkpoint.blocked ? '⚠️ Unavailable (provider unverified)' : `⏳ Required (${escapeHtml(checkpoint.provider?.name ?? 'shortener')} · tap a file link to verify)`));
      return ctx.reply(lines.join('\n'), HTML);
    } catch (error) {
      logger.warn({ userId: ctx.from.id, error: error.message }, 'Access status failed');
      return ctx.reply('⚠️ Access status unavailable. Try again later.');
    }
  });

  const isDeliveryOwner = (ctx) => Array.isArray(config?.adminIds) && config.adminIds.length > 0 && isAdmin(ctx.from?.id, config.adminIds);

  const deliveryAdminMenuText = [
    '🛡 <b>Delivery Bot Owner Admin</b>',
    '━━━━━━━━━━━━━━━━━━',
    '',
    '👇 <i>Tap an action below to inspect delivery health:</i>',
    '',
    '📊 <b>Queue Status</b> — Pending, active, completed &amp; failed counts',
    '🧪 <b>Test Channels</b> — Verify storage &amp; force-sub permissions',
    '',
    '<i>All other owner controls live under /admin on the Main Bot.</i>',
  ].join('\n');

  const deliveryAdminMenuKeyboard = {
    inline_keyboard: [
      [
        { text: '📊 Queue Status', callback_data: 'dbadm:status' },
        { text: '🧪 Test Channels', callback_data: 'dbadm:test' },
      ],
      [{ text: '↻ Refresh Menu', callback_data: 'dbadm:home' }],
    ],
  };

  async function renderDeliveryAdminStatus(ctx, edit = false) {
    try {
      const stats = await getDeliveryStats(pool);
      const text = [
        '📬 <b>Delivery Queue Status</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        `⏳ <b>Pending:</b> <code>${stats.pending}</code>`,
        `⚡ <b>Processing:</b> <code>${stats.processing}</code>`,
        `✅ <b>Completed:</b> <code>${stats.completed}</code>`,
        `❌ <b>Failed:</b> <code>${stats.failed}</code>`,
        `⚠️ <b>Uncertain:</b> <code>${stats.uncertain}</code>`,
      ].join('\n');
      const markup = {
        inline_keyboard: [
          [
            { text: '↻ Refresh Status', callback_data: 'dbadm:status' },
            { text: '🧪 Test Channels', callback_data: 'dbadm:test' },
          ],
          [{ text: '← Admin Menu', callback_data: 'dbadm:home' }],
        ],
      };
      if (edit && ctx.editMessageText) {
        try { return await ctx.editMessageText(text, { ...HTML, reply_markup: markup }); } catch {}
      }
      return await ctx.reply(text, { ...HTML, reply_markup: markup });
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery status query failed');
      return await ctx.reply('❌ Could not read delivery queue.');
    }
  }

  async function renderDeliveryAdminTest(ctx, edit = false) {
    try {
      const me = ctx.botInfo ?? await ctx.telegram.getMe();
      const { storage, forceSub } = await inspectBotChannelAccess(ctx.telegram, pool, me.id);
      const results = [
        ...storage.map((c) => {
          if (c.status === 'error') return `❌ <b>Storage FAILED</b> · ${escapeHtml(String(c.channel).slice(0, 90))} · ${escapeHtml(c.message)}`;
          return `${c.status === 'ok' ? '✅' : '⚠️'} <b>Storage ${c.status === 'ok' ? 'OK' : 'NOT A MEMBER'}</b> · ${escapeHtml(String(c.channel).slice(0, 90))}`;
        }),
        ...forceSub.map((c) => {
          if (c.status === 'force_sub_error') return `❌ <b>Force-sub FAILED</b> · ${escapeHtml(String(c.channel).slice(0, 90))} · ${escapeHtml(c.message)}`;
          return `${c.status === 'force_sub_admin_ok' ? '✅' : '⚠️'} <b>Force-sub ${c.status === 'force_sub_admin_ok' ? 'ADMIN OK' : 'NEEDS ADMIN'}</b> · ${escapeHtml(String(c.channel).slice(0, 90))}`;
        }),
      ];
      const text = '🧪 <b>Delivery Bot Permission Test</b>\n━━━━━━━━━━━━━━━━━━\n\n' + (results.join('\n') || '<i>No channels configured</i>');
      const markup = {
        inline_keyboard: [
          [
            { text: '↻ Re-run Test', callback_data: 'dbadm:test' },
            { text: '📊 Queue Status', callback_data: 'dbadm:status' },
          ],
          [{ text: '← Admin Menu', callback_data: 'dbadm:home' }],
        ],
      };
      if (edit && ctx.editMessageText) {
        try { return await ctx.editMessageText(text, { ...HTML, reply_markup: markup }); } catch {}
      }
      return await ctx.reply(text, { ...HTML, reply_markup: markup });
    } catch (error) {
      logger.error({ error: error.message }, 'Delivery bot permission test failed');
      return await ctx.reply('❌ Could not run channel access test.');
    }
  }

  bot.action(/^dbadm:(home|status|test)$/, async (ctx) => {
    if (!isDeliveryOwner(ctx)) {
      try { await ctx.answerCbQuery('🔒 Restricted to platform owner.', { show_alert: true }); } catch {}
      return;
    }
    const mode = ctx.match[1];
    try { await ctx.answerCbQuery(); } catch {}
    if (mode === 'status') return renderDeliveryAdminStatus(ctx, true);
    if (mode === 'test') return renderDeliveryAdminTest(ctx, true);
    try {
      return await ctx.editMessageText(deliveryAdminMenuText, { ...HTML, reply_markup: deliveryAdminMenuKeyboard });
    } catch {
      return ctx.reply(deliveryAdminMenuText, { ...HTML, reply_markup: deliveryAdminMenuKeyboard });
    }
  });

  bot.command('admin', async (ctx) => {
    if (!isDeliveryOwner(ctx)) {
      return ctx.reply('🔒 This command is restricted to the platform owner.');
    }
    const args = getCommandArgs(ctx);
    const sub = String(args[0] ?? '').trim().replace(/^\//, '').toLowerCase();

    if (!sub || sub === 'help' || sub === 'commands') {
      return ctx.reply(deliveryAdminMenuText, { ...HTML, reply_markup: deliveryAdminMenuKeyboard });
    }

    if (sub === 'status' || sub === 'delivery_status') {
      return renderDeliveryAdminStatus(ctx, false);
    }

    if (sub === 'test' || sub === 'delivery_test') {
      return renderDeliveryAdminTest(ctx, false);
    }

    return ctx.reply(
      `❓ Unknown delivery admin subcommand: <code>${escapeHtml(sub)}</code>\n\nUse <code>/admin status</code> or <code>/admin test</code>.`,
      { ...HTML, reply_markup: deliveryAdminMenuKeyboard },
    );
  });

  bot.catch((error, ctx) => {
    logger.error({ updateId: ctx.update?.update_id, error: error.message }, 'Delivery Bot handler error');
  });

  return {
    bot,
    async startWorker(workerOptions = {}) {
      if (workerOptions.deliveryBotId !== undefined) workerScope.deliveryBotId = workerOptions.deliveryBotId;
      if (workerOptions.includeGlobal !== undefined) workerScope.includeGlobal = workerOptions.includeGlobal;
      const me = await bot.telegram.getMe();
      botNumericId = me.id;
      identity = me.username ? '@' + me.username : String(me.id);
      if (worker) return;
      worker = createDeliveryWorker(bot, pool, logger, identity, workerScope);
      worker.start();
      autoDeleteWorker = createAutoDeleteWorker(bot, pool, logger, identity);
      autoDeleteWorker.start();
      famPayWorker = startFamPayVerificationWorker(pool, config, logger, bot.telegram, me.id);
    },
    stopWorker() {
      worker?.stop();
      autoDeleteWorker?.stop();
      famPayWorker?.stop();
      worker = undefined;
      autoDeleteWorker = undefined;
      famPayWorker = undefined;
    },
  };
}
