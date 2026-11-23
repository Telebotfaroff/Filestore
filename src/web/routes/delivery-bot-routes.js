// Creator/platform delivery-bot API routes.
export async function handleDeliveryBotRoutes({ req, res, method, pathname, auth, ownerScope, pool, state, config, sendJson, readJsonBody, MAX_START_IMAGE_BODY_BYTES, parsePositiveInt, serializeOwnerBotRow, listStorageChannels, getShareableBotUsername, getCreatorBotSlotQuota, getCreatorWalletSummary, loadFamPayConfig, loadStarsConfig, unlockSlotWithWallet, getBotSlotSettings, createFamPayCheckout, generateUpiQrDataUrl, verifyFamPaySession, getDeliveryBotStartConfig, saveDeliveryBotStartConfig, serializeStartConfig }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/bots') {
        const scopeWhere = ownerScope === null ? 'd.owner_telegram_id IS NULL' : 'd.owner_telegram_id = $1';
        const scopeParams = ownerScope === null ? [] : [Number(ownerScope)];
        const [botRes, storageChannels, sharedBotUsername, slots, walletSummary, fpCfg, starsCfg] = await Promise.all([
          pool.query(
            `SELECT d.id, d.telegram_bot_id, d.username, d.role, d.priority, d.is_enabled, d.runtime_status,
                    d.last_health_at, d.last_error, d.owner_telegram_id,
                    d.start_message, d.start_image_url, (d.start_image_data IS NOT NULL) AS has_start_image_upload,
                    d.start_image_mime, d.start_updated_at, d.created_at, d.updated_at,
                    COALESCE(u.total_users, 0)::int AS total_users,
                    COALESCE(u.active_users_7d, 0)::int AS active_users_7d,
                    COALESCE(u.total_interactions, 0)::int AS total_interactions
             FROM delivery_bots d
             LEFT JOIN (
               SELECT delivery_bot_id,
                      COUNT(*)::int AS total_users,
                      COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days')::int AS active_users_7d,
                      COALESCE(SUM(interaction_count), 0)::int AS total_interactions
               FROM delivery_bot_user_activity
               GROUP BY delivery_bot_id
             ) u ON u.delivery_bot_id = d.id
             WHERE ${scopeWhere}
             ORDER BY d.priority ASC, d.id ASC`,
            scopeParams,
          ).catch(async () => {
            const fallback = state.deliveryManager?.list ? await state.deliveryManager.list(ownerScope) : [];
            return { rows: fallback };
          }),
          listStorageChannels(pool, ownerScope),
          getShareableBotUsername(pool, null).catch(() => null),
          getCreatorBotSlotQuota(pool, ownerScope, auth.isOwner),
          getCreatorWalletSummary(pool, auth.userId).catch(() => ({ inrWallet: { available_minor: 0 } })),
          loadFamPayConfig(pool, config.tokenEncryptionKey).catch(() => ({ isEnabled: false, isConfigured: false })),
          loadStarsConfig(pool).catch(() => ({ isEnabled: false })),
        ]);
        const rows = (botRes.rows || []).map(serializeOwnerBotRow);
        const hasOwnStorage = storageChannels.some((c) => c.is_enabled);
        return respond(res, 200, {
          mainBotUsername: state.botUsername ?? null,
          sharedBotUsername: sharedBotUsername ?? null,
          hasOwnStorage,
          requiresStorageWarning: !auth.isOwner && rows.length > 0 && !hasOwnStorage,
          slots,
          walletAvailableMinor: Number(walletSummary?.inrWallet?.available_minor ?? 0),
          paymentMethods: {
            fampayEnabled: Boolean(fpCfg?.isEnabled && fpCfg?.isConfigured),
            starsEnabled: Boolean(starsCfg?.isEnabled && slots?.starsPrice),
          },
          bots: rows,
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/bots/slots/checkout') {
        if (auth.isOwner) {
          return respond(res, 400, { error: 'Platform owners already have unlimited delivery bot slots.' });
        }
        const body = await readJsonBody(req);
        const payMethod = String(body.method || 'fampay').trim().toLowerCase();
        if (payMethod === 'wallet') {
          const result = await unlockSlotWithWallet(pool, auth.userId);
          const slots = await getCreatorBotSlotQuota(pool, ownerScope, false);
          return respond(res, 200, { ok: true, paid: true, method: 'wallet', result, slots });
        }
        if (payMethod !== 'fampay') {
          return respond(res, 400, { error: 'Unsupported payment method. Use UPI (FamPay) or Wallet balance.' });
        }
        const slotSettings = await getBotSlotSettings(pool);
        const checkout = await createFamPayCheckout(pool, config, {
          userId: auth.userId,
          purpose: 'bot_slot',
          target: {},
          baseAmountMinor: slotSettings.priceMinor,
          currency: slotSettings.currency || 'INR',
          label: 'Extra Bot Slot',
        });
        const qrDataUrl = await generateUpiQrDataUrl(checkout.upiUri);
        return respond(res, 200, {
          ok: true,
          method: 'fampay',
          sessionId: Number(checkout.session.id),
          amountMinor: checkout.amountMinor,
          amountDisplay: checkout.amountDisplay,
          baseAmountMinor: slotSettings.priceMinor,
          upiId: checkout.upiId,
          txnRef: checkout.txnRef,
          upiUri: checkout.upiUri,
          qrDataUrl,
          expiresAt: checkout.session.expires_at,
        });
      }
  
      const slotCheckoutMatch = pathname.match(/^\/api\/panel\/bots\/slots\/checkout\/(\d+)\/(status|verify)$/);
      if (slotCheckoutMatch && (method === 'GET' || method === 'POST')) {
        const sessionId = Number(slotCheckoutMatch[1]);
        const action = slotCheckoutMatch[2];
        const sessRes = await pool.query(
          'SELECT id, user_telegram_id, purpose, status, expires_at FROM payment_sessions WHERE id = $1 LIMIT 1',
          [sessionId],
        );
        const sess = sessRes.rows[0];
        if (!sess || String(sess.user_telegram_id) !== String(auth.userId) || sess.purpose !== 'bot_slot') {
          return respond(res, 404, { error: 'Checkout session not found.' });
        }
        if (sess.status === 'applied') {
          const slots = await getCreatorBotSlotQuota(pool, ownerScope, auth.isOwner);
          return respond(res, 200, { status: 'applied', paid: true, slots });
        }
        if (sess.status === 'expired' || sess.status === 'failed') {
          return respond(res, 200, { status: sess.status, paid: false });
        }
        const body = method === 'POST' ? await readJsonBody(req) : {};
        const submittedUtr = action === 'verify' && body.utr ? String(body.utr).trim() : null;
        const result = await verifyFamPaySession(pool, config, sessionId, { userId: auth.userId, submittedUtr });
        const paid = result.status === 'verified' || result.status === 'applied';
        const slots = paid ? await getCreatorBotSlotQuota(pool, ownerScope, auth.isOwner) : null;
        return respond(res, 200, {
          status: paid ? 'applied' : result.status,
          paid,
          utr: result.utr ?? null,
          slots,
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/bots') {
        if (!state.deliveryManager?.addToken) {
          return respond(res, 503, { error: 'Delivery bot runtime manager is not active right now.' });
        }
        const body = await readJsonBody(req);
        const rawToken = String(body.token || '').trim();
        if (!rawToken || !/^\d{5,16}:[A-Za-z0-9_-]{20,}$/.test(rawToken)) {
          return respond(res, 400, { error: 'Please paste a valid @BotFather token (e.g. 123456789:ABCdef...).' });
        }
        const saved = await state.deliveryManager.addToken(rawToken, auth.userId, ownerScope);
        const [storageChannels, slots] = await Promise.all([
          listStorageChannels(pool, ownerScope),
          getCreatorBotSlotQuota(pool, ownerScope, auth.isOwner),
        ]);
        const hasOwnStorage = storageChannels.some((c) => c.is_enabled);
        return respond(res, 201, {
          ok: true,
          hasOwnStorage,
          requiresStorageChannel: !auth.isOwner && !hasOwnStorage,
          warning: !auth.isOwner && !hasOwnStorage
            ? 'Delivery bot connected! You MUST add your own Storage Channel and make both the Main Bot and your Delivery Bot administrators in it, otherwise delivery will not work.'
            : null,
          slots,
          bot: {
            id: Number(saved.id),
            telegramBotId: String(saved.telegram_bot_id),
            username: saved.username,
            role: saved.role,
            priority: Number(saved.priority ?? 10),
            isEnabled: Boolean(saved.is_enabled),
            runtimeStatus: saved.runtime_status,
          },
        });
      }
  
      const actorBotReplaceMatch = pathname.match(/^\/api\/panel\/bots\/(\d+)\/replace$/);
      if (method === 'POST' && actorBotReplaceMatch) {
        const botId = Number(actorBotReplaceMatch[1]);
        if (!state.deliveryManager?.replaceToken) {
          return respond(res, 503, { error: 'Delivery bot replacement is not available right now.' });
        }
        const body = await readJsonBody(req);
        const rawToken = String(body.token || '').trim();
        if (!rawToken || !/^\d{5,16}:[A-Za-z0-9_-]{20,}$/.test(rawToken)) {
          return respond(res, 400, { error: 'Please paste a valid @BotFather token (e.g. 123456789:ABCdef...).' });
        }
        const replaced = await state.deliveryManager.replaceToken(botId, rawToken, auth.userId, ownerScope);
        const storageChannels = await listStorageChannels(pool, ownerScope);
        const hasOwnStorage = storageChannels.some((c) => c.is_enabled);
        const checks = replaced.checks || [];
        const failedChecks = checks.filter((c) => c.status !== 'ok' && c.status !== 'force_sub_admin_ok');
        let warning = null;
        if (!auth.isOwner && !hasOwnStorage) {
          warning = `Bot updated to @${replaced.bot.username}. Add your own Storage Channel and make both bots administrators so deliveries work.`;
        } else if (failedChecks.length > 0) {
          warning = `Bot updated to @${replaced.bot.username}, and all your links remain active. Make sure @${replaced.bot.username} is added as Administrator in ${failedChecks.length} channel(s).`;
        }
        return respond(res, 200, {
          ok: true,
          hasOwnStorage,
          requiresStorageChannel: !auth.isOwner && !hasOwnStorage,
          warning,
          checks,
          bot: {
            id: Number(replaced.bot.id),
            telegramBotId: String(replaced.bot.telegram_bot_id),
            username: replaced.bot.username,
            role: replaced.bot.role,
            priority: Number(replaced.bot.priority ?? 10),
            isEnabled: Boolean(replaced.bot.is_enabled),
            runtimeStatus: replaced.bot.runtime_status,
          },
        });
      }
  
      const actorBotTestMatch = pathname.match(/^\/api\/panel\/bots\/(\d+)\/test$/);
      if (method === 'POST' && actorBotTestMatch) {
        const botId = Number(actorBotTestMatch[1]);
        if (!state.deliveryManager?.test) {
          return respond(res, 503, { error: 'Delivery bot runtime manager is not active.' });
        }
        const result = await state.deliveryManager.test(botId, ownerScope);
        return respond(res, 200, {
          ok: true,
          bot: { id: result.bot.id, username: result.bot.username, firstName: result.bot.first_name },
          checks: result.checks || [],
        });
      }
  
      const actorBotStartMatch = pathname.match(/^\/api\/panel\/bots\/(\d+)\/start-message$/);
      if (actorBotStartMatch) {
        const botId = Number(actorBotStartMatch[1]);
        if (method === 'GET') {
          const record = await getDeliveryBotStartConfig(pool, botId, ownerScope);
          if (!record) return respond(res, 404, { error: 'Delivery bot not found.' });
          return respond(res, 200, serializeStartConfig(record));
        }
        if (method === 'PUT' || method === 'POST') {
          const body = await readJsonBody(req, MAX_START_IMAGE_BODY_BYTES);
          const saved = await saveDeliveryBotStartConfig(pool, botId, ownerScope, body);
          if (!saved) return respond(res, 404, { error: 'Delivery bot not found.' });
          return respond(res, 200, { ok: true, ...serializeStartConfig(saved) });
        }
        if (method === 'DELETE') {
          const cleared = await saveDeliveryBotStartConfig(pool, botId, ownerScope, { clear: true });
          if (!cleared) return respond(res, 404, { error: 'Delivery bot not found.' });
          return respond(res, 200, { ok: true, ...serializeStartConfig(cleared) });
        }
      }
  
      const actorBotMatch = pathname.match(/^\/api\/panel\/bots\/(\d+)$/);
      if (actorBotMatch) {
        const botId = Number(actorBotMatch[1]);
        const scopeWhere = ownerScope === null ? 'owner_telegram_id IS NULL' : 'owner_telegram_id = $2';
        const scopeParams = ownerScope === null ? [botId] : [botId, Number(ownerScope)];
        const existingBotRes = await pool.query(
          `SELECT id, owner_telegram_id FROM delivery_bots WHERE id = $1 AND ${scopeWhere} LIMIT 1`,
          scopeParams,
        );
        if (!existingBotRes.rowCount) {
          return respond(res, 404, { error: 'Delivery bot not found.' });
        }
  
        if (method === 'PATCH') {
          if (!state.deliveryManager) {
            return respond(res, 503, { error: 'Delivery bot runtime manager is not active.' });
          }
          const body = await readJsonBody(req);
          if (body.priority !== undefined) {
            const prio = Number(body.priority);
            if (!Number.isInteger(prio) || prio < 0 || prio > 100000) {
              return respond(res, 400, { error: 'Priority must be an integer between 0 and 100000.' });
            }
            await state.deliveryManager.setPriority(botId, prio, ownerScope);
          }
          if (typeof body.isEnabled === 'boolean') {
            await state.deliveryManager.setEnabled(botId, body.isEnabled, ownerScope);
          }
          if (body.action === 'pause') await state.deliveryManager.pause(botId, ownerScope);
          else if (body.action === 'resume') await state.deliveryManager.resume(botId, ownerScope);
          else if (body.action === 'restart') await state.deliveryManager.restart(botId, ownerScope);
          else if (body.action === 'set_primary') await state.deliveryManager.promotePrimary(botId, ownerScope);
          return respond(res, 200, { ok: true });
        }
        if (method === 'DELETE') {
          if (!state.deliveryManager?.remove) {
            return respond(res, 503, { error: 'Delivery bot runtime manager is not active.' });
          }
          const removed = await state.deliveryManager.remove(botId, ownerScope);
          if (!removed) return respond(res, 404, { error: 'Delivery bot not found.' });
          return respond(res, 200, { ok: true });
        }
      }
  return false;
}
