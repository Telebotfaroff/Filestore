// Platform-owner settings API routes.
export async function handleOwnerSettingsRoutes({ req, res, method, pathname, auth, pool, sendJson, readJsonBody, getBotSlotSettings, setBotSlotSettings, listOwnerReferrals, setReferralSettings, getOwnerPlatformFeeSummary, setPlatformFeeSettings, parseMinorAmount }) {
  const respond = (...args) => { sendJson(...args); return true; };
        if (method === 'GET' && pathname === '/api/panel/owner/bot-slot-settings') {
          const settings = await getBotSlotSettings(pool);
          return respond(res, 200, { settings });
        }
  
        if (method === 'POST' && pathname === '/api/panel/owner/bot-slot-settings') {
          const body = await readJsonBody(req);
          const priceMinor = body.priceMinor !== undefined && body.priceMinor !== null && body.priceMinor !== ''
            ? Number(body.priceMinor)
            : parseMinorAmount(body.price, { allowZero: false });
          const starsPrice = body.starsPrice === undefined
            ? undefined
            : (body.starsPrice === null || String(body.starsPrice).trim() === '' || Number(body.starsPrice) === 0
                ? null
                : Number(body.starsPrice));
          const settings = await setBotSlotSettings(pool, { priceMinor, starsPrice }, auth.userId);
          return respond(res, 200, { ok: true, settings });
        }
  
        if (method === 'GET' && pathname === '/api/panel/owner/referrals') {
          const data = await listOwnerReferrals(pool, 50);
          return respond(res, 200, data);
        }
  
        if (method === 'POST' && pathname === '/api/panel/owner/referral-settings') {
          const body = await readJsonBody(req);
          const enabled = body.enabled === undefined
            ? undefined
            : (typeof body.enabled === 'string' ? body.enabled === 'true' : Boolean(body.enabled));
          const rewardMinor = body.rewardMinor !== undefined && body.rewardMinor !== null && body.rewardMinor !== ''
            ? Number(body.rewardMinor)
            : parseMinorAmount(body.reward ?? body.price, { allowZero: true });
          const settings = await setReferralSettings(pool, { enabled, rewardMinor }, auth.userId);
          return respond(res, 200, { ok: true, settings });
        }
  
        if (method === 'GET' && pathname === '/api/panel/owner/fees') {
          const data = await getOwnerPlatformFeeSummary(pool, 30);
          return respond(res, 200, data);
        }
  
        if (method === 'POST' && pathname === '/api/panel/owner/fee-settings') {
          const body = await readJsonBody(req);
          const enabled = body.enabled === undefined
            ? undefined
            : (typeof body.enabled === 'string' ? body.enabled === 'true' : Boolean(body.enabled));
          const settings = await setPlatformFeeSettings(
            pool,
            {
              enabled,
              paidLinkFeeBps: body.paidLinkFeeBps,
              premiumFeeBps: body.premiumFeeBps,
              paidLinkFeePercent: body.paidLinkFeePercent,
              premiumFeePercent: body.premiumFeePercent,
            },
            auth.userId,
          );
          return respond(res, 200, { ok: true, settings });
        }
  return false;
}
