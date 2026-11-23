// Creator/owner shortener provider API routes.
export async function handleShortenerRoutes({ req, res, method, pathname, auth, ownerScope, pool, config, sendJson, readJsonBody, listShortenerProviders, getGlobalCheckpointEnabled, getCreatorSettings, normalizeShortenerUrls, deriveUniqueShortenerName, addShortenerProvider, setGlobalCheckpointEnabled, setCreatorCheckpointEnabled, getShortenerProviderById, decryptShortenerApiKey, shortenUrlWithProvider, markShortenerTest, updateShortenerName, updateShortenerCredentials, setShortenerEnabled, setShortenerPriority, setShortenerDuration, removeShortenerProvider }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/shorteners') {
        const [providers, checkpointEnabled] = await Promise.all([
          listShortenerProviders(pool, ownerScope),
          auth.isOwner
            ? getGlobalCheckpointEnabled(pool)
            : getCreatorSettings(pool, auth.userId).then((s) => Boolean(s.checkpoint_enabled)),
        ]);
        return respond(res, 200, {
          checkpointEnabled,
          providers: providers.map((p) => ({
            id: p.id,
            name: p.name,
            baseUrl: p.base_url,
            apiEndpoint: p.api_endpoint,
            isEnabled: Boolean(p.is_enabled),
            priority: Number(p.priority),
            durationMinutes: Number(p.checkpoint_duration_minutes),
            lastTestStatus: p.last_test_status,
            lastTestError: p.last_test_error,
            lastTestedAt: p.last_tested_at,
          })),
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/shorteners') {
        const body = await readJsonBody(req);
        const baseUrlRaw = String(body.baseUrl || '').trim();
        const apiKey = String(body.apiKey || '').trim();
        const apiEndpointRaw = body.apiEndpoint ? String(body.apiEndpoint).trim() : null;
        if (!baseUrlRaw || apiKey.length < 4) {
          return respond(res, 400, { error: 'Base URL and API key (min 4 chars) are required.' });
        }
        const durationMinutes = body.durationMinutes !== undefined ? Number(body.durationMinutes) : 1440;
        const priority = body.priority !== undefined ? Number(body.priority) : 100;
        if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) {
          return respond(res, 400, { error: 'Duration must be 1–10080 minutes.' });
        }
        if (!Number.isInteger(priority) || priority < 1 || priority > 100000) {
          return respond(res, 400, { error: 'Priority must be 1–100000.' });
        }
        const existing = await listShortenerProviders(pool, ownerScope);
        const urls = normalizeShortenerUrls(baseUrlRaw, apiEndpointRaw);
        const name = String(body.name || '').trim() || deriveUniqueShortenerName(urls.hostname, existing);
        const created = await addShortenerProvider(
          pool,
          config,
          {
            name: name.slice(0, 48),
            baseUrl: urls.baseUrl,
            apiEndpoint: urls.apiEndpoint,
            apiKey,
            durationMinutes,
            priority,
          },
          auth.userId,
          ownerScope,
        );
        return respond(res, 201, {
          ok: true,
          provider: {
            id: created.id,
            name: created.name,
            baseUrl: created.base_url,
            apiEndpoint: created.api_endpoint,
            isEnabled: Boolean(created.is_enabled),
            priority: Number(created.priority),
            durationMinutes: Number(created.checkpoint_duration_minutes),
          },
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/shorteners/checkpoint') {
        const body = await readJsonBody(req);
        const enabled = Boolean(body.enabled);
        if (auth.isOwner) {
          await setGlobalCheckpointEnabled(pool, enabled, auth.userId);
        } else {
          await setCreatorCheckpointEnabled(pool, auth.userId, enabled);
        }
        return respond(res, 200, { ok: true, checkpointEnabled: enabled });
      }
  
      const shortenerTestMatch = pathname.match(/^\/api\/panel\/shorteners\/(\d+)\/test$/);
      if (method === 'POST' && shortenerTestMatch) {
        const id = Number(shortenerTestMatch[1]);
        const provider = await getShortenerProviderById(pool, id, ownerScope);
        if (!provider) return respond(res, 404, { error: 'Shortener provider not found.' });
        try {
          const apiKey = decryptShortenerApiKey(provider, config);
          const result = await shortenUrlWithProvider(provider, apiKey, 'https://t.me/Telegram');
          await markShortenerTest(pool, id, 'ok', null, ownerScope);
          return respond(res, 200, { ok: true, shortUrl: result.shortUrl });
        } catch (error) {
          await markShortenerTest(pool, id, 'failed', error.message, ownerScope).catch(() => {});
          return respond(res, 400, { error: `Shortener test failed: ${error.message}` });
        }
      }
  
      const shortenerMatch = pathname.match(/^\/api\/panel\/shorteners\/(\d+)$/);
      if (shortenerMatch) {
        const id = Number(shortenerMatch[1]);
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          let row = null;
          if (typeof body.name === 'string' && body.name.trim()) {
            const cleanName = body.name.trim().slice(0, 60);
            row = await updateShortenerName(pool, id, cleanName, ownerScope);
          }
          if (body.baseUrl !== undefined || body.apiKey !== undefined || body.apiEndpoint !== undefined) {
            const existing = await getShortenerProviderById(pool, id, ownerScope);
            if (!existing) return respond(res, 404, { error: 'Shortener provider not found.' });
            const nextBase = body.baseUrl ? String(body.baseUrl).trim() : existing.base_url;
            const nextEndpointRaw = body.apiEndpoint !== undefined
              ? (String(body.apiEndpoint).trim() || null)
              : (body.baseUrl ? null : existing.api_endpoint);
            const urls = normalizeShortenerUrls(nextBase, nextEndpointRaw);
            const nextKey = body.apiKey && String(body.apiKey).trim()
              ? String(body.apiKey).trim()
              : decryptShortenerApiKey(existing, config);
            if (nextKey.length < 4) {
              return respond(res, 400, { error: 'API key must be at least 4 characters.' });
            }
            row = await updateShortenerCredentials(
              pool,
              config,
              id,
              { baseUrl: urls.baseUrl, apiEndpoint: urls.apiEndpoint, apiKey: nextKey },
              ownerScope,
            );
          }
          if (typeof body.isEnabled === 'boolean') {
            row = await setShortenerEnabled(pool, id, body.isEnabled, ownerScope);
          }
          if (body.priority !== undefined) {
            const prio = Number(body.priority);
            if (!Number.isInteger(prio) || prio < 1 || prio > 100000) {
              return respond(res, 400, { error: 'Priority must be 1–100000.' });
            }
            row = await setShortenerPriority(pool, id, prio, ownerScope);
          }
          if (body.durationMinutes !== undefined) {
            const mins = Number(body.durationMinutes);
            if (!Number.isInteger(mins) || mins < 1 || mins > 10080) {
              return respond(res, 400, { error: 'Duration must be 1–10080 minutes.' });
            }
            row = await setShortenerDuration(pool, id, mins, ownerScope);
          }
          if (!row) return respond(res, 404, { error: 'Shortener provider not found.' });
          return respond(res, 200, { ok: true });
        }
        if (method === 'DELETE') {
          const removed = await removeShortenerProvider(pool, id, ownerScope);
          if (!removed) return respond(res, 404, { error: 'Shortener provider not found.' });
          return respond(res, 200, { ok: true });
        }
      }
  return false;
}
