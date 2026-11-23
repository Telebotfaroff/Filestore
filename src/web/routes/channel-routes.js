// Storage and force-subscription channel API routes.
export async function handleChannelRoutes({ req, res, method, pathname, auth, ownerScope, pool, state, sendJson, readJsonBody, parseStorageIdentifier, validateStorageChannel, validateForceSubChannel, listStorageChannels, getStorageChannelForOwner, saveStorageChannel, updateStorageTest, setStorageEnabled, setPrimaryStorageChannel, removeStorageChannel, listForceSubChannels, getForceSubGlobal, saveForceSubChannel, setForceSubEnabled, removeForceSubChannel, setForceSubGlobal, cacheDeletePrefix }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/channels') {
        const [storage, forceSub, forceSubEnabled] = await Promise.all([
          listStorageChannels(pool, ownerScope),
          listForceSubChannels(pool, ownerScope),
          getForceSubGlobal(pool, ownerScope),
        ]);
        return respond(res, 200, {
          forceSubEnabled,
          mainBotUsername: state.botUsername ?? null,
          storageChannels: storage.map((c) => ({
            id: c.id,
            chatId: String(c.telegram_chat_id),
            title: c.title || c.username || String(c.telegram_chat_id),
            username: c.username,
            isEnabled: Boolean(c.is_enabled),
            isPrimary: c.role === 'primary' || Boolean(c.is_primary),
            lastTestStatus: c.last_test_status,
          })),
          forceSubChannels: forceSub.map((c) => ({
            id: c.id,
            chatId: String(c.telegram_chat_id),
            title: c.title || c.username || String(c.telegram_chat_id),
            joinUrl: c.join_url,
            isEnabled: Boolean(c.is_enabled),
            lastTestStatus: c.last_test_status,
          })),
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/channels/storage') {
        if (!state.notifyTelegram) {
          return respond(res, 503, { error: 'Telegram Main Bot is not connected right now. Please try again shortly.' });
        }
        const body = await readJsonBody(req);
        const parsed = parseStorageIdentifier(body.channelInput);
        const chat = await validateStorageChannel(
          { telegram: state.notifyTelegram, from: { id: auth.userId } },
          parsed,
          { requireUserAdmin: !auth.isOwner },
        );
        const saved = await saveStorageChannel(pool, chat, auth.userId, ownerScope);
        return respond(res, 201, {
          ok: true,
          channel: {
            id: saved.id,
            chatId: String(saved.telegram_chat_id),
            title: saved.title || saved.username || String(saved.telegram_chat_id),
            username: saved.username ?? null,
            isEnabled: Boolean(saved.is_enabled),
            isPrimary: saved.role === 'primary',
            lastTestStatus: 'ok',
          },
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/channels/force_sub') {
        if (!state.notifyTelegram) {
          return respond(res, 503, { error: 'Telegram Main Bot is not connected right now. Please try again shortly.' });
        }
        const body = await readJsonBody(req);
        const parsed = parseStorageIdentifier(body.channelInput);
        const chat = await validateForceSubChannel(
          { telegram: state.notifyTelegram, from: { id: auth.userId } },
          parsed,
          { requireUserAdmin: !auth.isOwner },
        );
  
        let joinUrl = String(body.joinUrl || '').trim();
        if (joinUrl) {
          let parsedUrlObj;
          try {
            parsedUrlObj = new URL(joinUrl);
          } catch {
            return respond(res, 400, { error: 'Join URL must be a valid https:// invite link.' });
          }
          if (parsedUrlObj.protocol !== 'https:') {
            return respond(res, 400, { error: 'Join URL must start with https://.' });
          }
          joinUrl = parsedUrlObj.toString();
        } else if (chat.username) {
          joinUrl = `https://t.me/${chat.username}`;
        } else if (chat.invite_link) {
          joinUrl = chat.invite_link;
        } else if (typeof state.notifyTelegram.exportChatInviteLink === 'function') {
          try {
            joinUrl = await state.notifyTelegram.exportChatInviteLink(chat.id);
          } catch {
            return respond(res, 400, { error: 'Private channel detected. Please paste an https://t.me/... invite link.' });
          }
        } else {
          return respond(res, 400, { error: 'Join URL is required for private channels without a @username.' });
        }
  
        const saved = await saveForceSubChannel(pool, chat, joinUrl, auth.userId, ownerScope);
        return respond(res, 201, {
          ok: true,
          channel: {
            id: saved.id,
            chatId: String(saved.telegram_chat_id),
            title: saved.title || saved.username || String(saved.telegram_chat_id),
            joinUrl: saved.join_url,
            isEnabled: Boolean(saved.is_enabled),
          },
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/channels/force-sub-global') {
        const body = await readJsonBody(req);
        const enabled = Boolean(body.enabled);
        await setForceSubGlobal(pool, enabled, auth.userId, ownerScope);
        return respond(res, 200, { ok: true, forceSubEnabled: enabled });
      }
  
      const channelTestMatch = pathname.match(/^\/api\/panel\/channels\/(storage|force_sub)\/(-?\d+)\/test$/);
      if (method === 'POST' && channelTestMatch) {
        if (!state.notifyTelegram) {
          return respond(res, 503, { error: 'Telegram Main Bot is not connected right now.' });
        }
        const type = channelTestMatch[1];
        const chatId = Number(channelTestMatch[2]);
        if (type === 'storage') {
          const owned = await getStorageChannelForOwner(pool, chatId, ownerScope);
          if (!owned) return respond(res, 404, { error: 'Storage channel not found.' });
          try {
            const chat = await validateStorageChannel(
              { telegram: state.notifyTelegram, from: { id: auth.userId } },
              chatId,
              { requireUserAdmin: !auth.isOwner },
            );
            await updateStorageTest(pool, chatId, 'ok', null, ownerScope);
            return respond(res, 200, { ok: true, title: chat.title || String(chatId) });
          } catch (error) {
            await updateStorageTest(pool, chatId, 'failed', error.message, ownerScope).catch(() => {});
            return respond(res, 400, { error: error.message });
          }
        }
        const list = await listForceSubChannels(pool, ownerScope);
        const owned = list.find((c) => Number(c.telegram_chat_id) === chatId);
        if (!owned) return respond(res, 404, { error: 'Force-sub channel not found.' });
        try {
          const chat = await validateForceSubChannel(
            { telegram: state.notifyTelegram, from: { id: auth.userId } },
            chatId,
            { requireUserAdmin: !auth.isOwner },
          );
          await pool.query(
            "UPDATE force_sub_channels SET last_test_status = 'ok', last_test_error = NULL, updated_at = NOW() WHERE telegram_chat_id = $1",
            [chatId],
          ).catch(() => {});
          cacheDeletePrefix('force-sub:');
          return respond(res, 200, { ok: true, title: chat.title || String(chatId) });
        } catch (error) {
          await pool.query(
            "UPDATE force_sub_channels SET last_test_status = 'failed', last_test_error = $2, updated_at = NOW() WHERE telegram_chat_id = $1",
            [chatId, String(error.message).slice(0, 500)],
          ).catch(() => {});
          cacheDeletePrefix('force-sub:');
          return respond(res, 400, { error: error.message });
        }
      }
  
      const channelMatch = pathname.match(/^\/api\/panel\/channels\/(storage|force_sub)\/(-?\d+)$/);
      if (channelMatch) {
        const type = channelMatch[1];
        const targetId = Number(channelMatch[2]);
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          if (type === 'storage') {
            if (body.isPrimary === true) {
              const row = await setPrimaryStorageChannel(pool, targetId, ownerScope);
              if (!row) return respond(res, 404, { error: 'Storage channel not found.' });
              return respond(res, 200, { ok: true });
            }
            if (typeof body.isEnabled === 'boolean') {
              const row = await setStorageEnabled(pool, targetId, body.isEnabled, ownerScope);
              if (!row) return respond(res, 404, { error: 'Storage channel not found.' });
              return respond(res, 200, { ok: true });
            }
          } else if (type === 'force_sub' && typeof body.isEnabled === 'boolean') {
            const row = await setForceSubEnabled(pool, targetId, body.isEnabled, ownerScope);
            if (!row) return respond(res, 404, { error: 'Force-sub channel not found.' });
            return respond(res, 200, { ok: true });
          }
          return respond(res, 400, { error: 'Unsupported channel update.' });
        }
        if (method === 'DELETE') {
          const removed = type === 'storage'
            ? await removeStorageChannel(pool, targetId, ownerScope)
            : await removeForceSubChannel(pool, targetId, ownerScope);
          if (!removed) return respond(res, 404, { error: 'Channel not found.' });
          return respond(res, 200, { ok: true });
        }
      }
  return false;
}
