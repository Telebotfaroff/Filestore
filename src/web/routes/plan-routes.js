// Creator and platform premium-plan API routes.
export async function handlePlanRoutes({ req, res, method, pathname, auth, pool, parsedUrl, sendJson, readJsonBody, listPremiumPlans, getShareableBotUsername, loadStarsConfig, getPlatformFeeSettings, getTelegramStarsPrice, parseCurrencyCode, parseMinorAmount, upsertPremiumPlan, setTelegramStarsPrice, getPremiumPlanById, editPremiumPlan, setPremiumPlanEnabled, removePremiumPlan }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/plans') {
        const scope = auth.isOwner ? null : auth.userId;
        const [plans, botUsername, starsCfg, platformFees] = await Promise.all([
          listPremiumPlans(pool, scope),
          getShareableBotUsername(pool, scope),
          loadStarsConfig(pool).catch(() => ({ isEnabled: false, starsPrices: {} })),
          getPlatformFeeSettings(pool).catch(() => null),
        ]);
        return respond(res, 200, {
          scope: auth.isOwner ? 'platform' : 'creator',
          starsEnabled: Boolean(starsCfg.isEnabled),
          platformFees,
          checkoutLink: !auth.isOwner && botUsername ? `https://t.me/${botUsername}?start=cprem_${auth.userId}` : null,
          plans: plans.map((p) => ({
            id: p.id,
            name: p.name,
            priceMinor: Number(p.price_minor),
            currency: p.currency,
            durationDays: Number(p.duration_days),
            isEnabled: Boolean(p.is_enabled),
            starsPrice: getTelegramStarsPrice({ stars_prices: starsCfg.starsPrices }, 'premium', { planId: p.id }),
            createdAt: p.created_at,
          })),
        });
      }
  
      if (method === 'POST' && pathname === '/api/panel/plans') {
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim();
        if (!name || name.length > 60) return respond(res, 400, { error: 'Plan name must be 1–60 characters.' });
        const durationDays = Number(body.durationDays);
        if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
          return respond(res, 400, { error: 'Duration must be 1–3650 days.' });
        }
        const currency = auth.isOwner ? parseCurrencyCode(body.currency || 'INR') : 'INR';
        const priceMinor = parseMinorAmount(body.price, { allowZero: auth.isOwner });
        if (!auth.isOwner && priceMinor < 100) {
          return respond(res, 400, { error: 'Creator plan price must be at least 1.00 INR.' });
        }
        const starsRaw = body.starsPrice !== undefined && String(body.starsPrice).trim() !== ''
          ? Number(body.starsPrice)
          : null;
        if (starsRaw !== null && (!Number.isSafeInteger(starsRaw) || starsRaw < 0 || starsRaw > 100000000)) {
          return respond(res, 400, { error: 'Stars price must be an integer between 0 and 100000000.' });
        }
        const planScope = auth.isOwner ? null : auth.userId;
        const saved = await upsertPremiumPlan(
          pool,
          { name, priceMinor, currency, durationDays, enabled: true },
          auth.userId,
          planScope,
        );
        if (starsRaw !== null && saved?.id) {
          await setTelegramStarsPrice(pool, 'premium', saved.id, starsRaw, auth.userId);
        }
        return respond(res, 201, { ok: true, plan: saved });
      }
  
      const planStarsMatch = pathname.match(/^\/api\/panel\/plans\/(\d+)\/stars$/);
      if (method === 'POST' && planStarsMatch) {
        const id = Number(planStarsMatch[1]);
        const planScope = auth.isOwner ? null : auth.userId;
        const plan = await getPremiumPlanById(pool, id, planScope);
        if (!plan) return respond(res, 404, { error: 'Plan not found.' });
        const body = await readJsonBody(req);
        const stars = Number(body.stars);
        if (!Number.isSafeInteger(stars) || stars < 0 || stars > 100000000) {
          return respond(res, 400, { error: 'Stars price must be 0 to remove or a positive integer.' });
        }
        await setTelegramStarsPrice(pool, 'premium', id, stars, auth.userId);
        return respond(res, 200, { ok: true, starsPrice: stars === 0 ? null : stars });
      }
  
      const planMatch = pathname.match(/^\/api\/panel\/plans\/(\d+)$/);
      if (planMatch) {
        const id = Number(planMatch[1]);
        const planScope = auth.isOwner ? null : auth.userId;
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          if (body.name !== undefined || body.price !== undefined || body.durationDays !== undefined) {
            const current = await getPremiumPlanById(pool, id, planScope);
            if (!current) return respond(res, 404, { error: 'Plan not found.' });
            const nextName = body.name !== undefined ? String(body.name).trim() : current.name;
            if (!nextName || nextName.length > 60) return respond(res, 400, { error: 'Plan name must be 1–60 characters.' });
            const nextDays = body.durationDays !== undefined ? Number(body.durationDays) : Number(current.duration_days);
            if (!Number.isInteger(nextDays) || nextDays < 1 || nextDays > 3650) {
              return respond(res, 400, { error: 'Duration must be 1–3650 days.' });
            }
            const nextCurrency = auth.isOwner && body.currency ? parseCurrencyCode(body.currency) : current.currency;
            const nextPriceMinor = body.price !== undefined
              ? parseMinorAmount(body.price, { allowZero: auth.isOwner })
              : Number(current.price_minor);
            if (!auth.isOwner && nextPriceMinor < 100) {
              return respond(res, 400, { error: 'Creator plan price must be at least 1.00 INR.' });
            }
            const nextEnabled = typeof body.isEnabled === 'boolean' ? body.isEnabled : Boolean(current.is_enabled);
            const edited = await editPremiumPlan(
              pool,
              id,
              { name: nextName, priceMinor: nextPriceMinor, currency: nextCurrency, durationDays: nextDays, enabled: nextEnabled },
              planScope,
            );
            if (!edited) return respond(res, 404, { error: 'Plan not found.' });
            return respond(res, 200, { ok: true });
          }
          if (typeof body.isEnabled !== 'boolean') {
            return respond(res, 400, { error: 'isEnabled boolean or plan fields required.' });
          }
          const updated = await setPremiumPlanEnabled(pool, id, body.isEnabled, planScope);
          if (!updated) return respond(res, 404, { error: 'Plan not found.' });
          return respond(res, 200, { ok: true });
        }
        if (method === 'DELETE') {
          const removed = await removePremiumPlan(pool, id, planScope);
          if (!removed) return respond(res, 404, { error: 'Plan not found.' });
          return respond(res, 200, { ok: true });
        }
      }
  return false;
}
