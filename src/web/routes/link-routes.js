// Share, paid-file, and paid-batch link API routes.
export async function handleLinkRoutes({ req, res, method, pathname, ownerScope, pool, sendJson, readJsonBody, listShareLinks, listPaidFileLinks, listPaidBatchLinks, getShareableBotUsername, getPlatformFeeSettings, buildShareableUrl, renameShareLink, setShareLinkEnabled, deleteShareLink, updatePaidFileLinkPrice, setPaidFileLinkEnabled, updatePaidBatchLink, setPaidBatchLinkEnabled, deletePaidFileLink, deletePaidBatchLink, parseCurrencyCode }) {
  const respond = (...args) => { sendJson(...args); return true; };
      if (method === 'GET' && pathname === '/api/panel/links') {
        const [shareRes, paidFiles, paidBatches, botUsername, platformFees] = await Promise.all([
          listShareLinks(pool, { limit: 100, offset: 0, ownerId: ownerScope }),
          listPaidFileLinks(pool, 100, ownerScope),
          listPaidBatchLinks(pool, 100, ownerScope),
          getShareableBotUsername(pool, ownerScope),
          getPlatformFeeSettings(pool).catch(() => null),
        ]);
  
        return respond(res, 200, {
          deliveryBotUsername: botUsername ?? null,
          platformFees,
          shareLinks: shareRes.rows.map((r) => ({
            id: r.id,
            kind: 'share',
            code: r.link_code,
            linkType: r.link_type,
            title: r.title || r.primary_file_name || r.link_code,
            itemCount: Number(r.item_count ?? 1),
            views: Number(r.view_count ?? 0),
            isEnabled: Boolean(r.is_enabled),
            createdAt: r.created_at,
            url: botUsername ? buildShareableUrl(botUsername, r.link_code) : null,
          })),
          paidFileLinks: paidFiles.map((r) => ({
            id: r.id,
            kind: 'paid_file',
            code: r.public_code,
            title: r.file_name || r.public_code,
            priceMinor: Number(r.price_minor ?? 0),
            views: Number(r.view_count ?? 0),
            currency: r.currency || 'INR',
            isEnabled: Boolean(r.is_enabled),
            expiresAt: r.expires_at,
            createdAt: r.created_at,
            url: botUsername ? `https://t.me/${botUsername}?start=paid_${r.public_code}` : null,
          })),
          paidBatchLinks: paidBatches.map((r) => ({
            id: r.id,
            kind: 'paid_batch',
            code: r.public_code,
            title: r.title || r.public_code,
            itemCount: Number(r.item_count ?? 0),
            views: Number(r.view_count ?? 0),
            priceMinor: Number(r.price_minor ?? 0),
            currency: r.currency || 'INR',
            isEnabled: Boolean(r.is_enabled),
            expiresAt: r.expires_at,
            createdAt: r.created_at,
            url: botUsername ? `https://t.me/${botUsername}?start=pbatch_${r.public_code}` : null,
          })),
        });
      }
  
      const linkMatch = pathname.match(/^\/api\/panel\/links\/(share|paid_file|paid_batch)\/(\d+)$/);
      if (linkMatch) {
        const kind = linkMatch[1];
        const id = Number(linkMatch[2]);
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          let updated = null;
          if (kind === 'share') {
            if (typeof body.title === 'string' && body.title.trim()) {
              updated = await renameShareLink(pool, id, body.title.trim(), ownerScope);
            }
            if (typeof body.isEnabled === 'boolean') {
              updated = await setShareLinkEnabled(pool, id, body.isEnabled, ownerScope);
            }
          } else if (kind === 'paid_file') {
            if (body.priceMinor !== undefined) {
              const price = Number(body.priceMinor);
              if (!Number.isSafeInteger(price) || price < 1) {
                return respond(res, 400, { error: 'Price must be a positive integer in minor currency units.' });
              }
              const currency = body.currency ? parseCurrencyCode(body.currency) : null;
              updated = await updatePaidFileLinkPrice(pool, id, price, currency, ownerScope);
            }
            if (typeof body.isEnabled === 'boolean') {
              updated = await setPaidFileLinkEnabled(pool, id, body.isEnabled, ownerScope);
            }
          } else if (kind === 'paid_batch') {
            if (body.title !== undefined || body.priceMinor !== undefined) {
              const title = typeof body.title === 'string' ? body.title.trim() : '';
              const price = Number(body.priceMinor);
              if (!title) {
                return respond(res, 400, { error: 'Batch title is required when editing a paid batch link.' });
              }
              if (!Number.isSafeInteger(price) || price < 1) {
                return respond(res, 400, { error: 'Price must be a positive integer in minor currency units.' });
              }
              const currency = body.currency ? parseCurrencyCode(body.currency) : null;
              updated = await updatePaidBatchLink(pool, id, title, price, currency, ownerScope);
            }
            if (typeof body.isEnabled === 'boolean') {
              updated = await setPaidBatchLinkEnabled(pool, id, body.isEnabled, ownerScope);
            }
          }
          if (!updated) return respond(res, 404, { error: 'Link not found or no valid change provided.' });
          return respond(res, 200, { ok: true, id: updated.id });
        }
        if (method === 'DELETE') {
          let deleted = null;
          if (kind === 'share') deleted = await deleteShareLink(pool, id, ownerScope);
          else if (kind === 'paid_file') deleted = await deletePaidFileLink(pool, id, ownerScope);
          else if (kind === 'paid_batch') deleted = await deletePaidBatchLink(pool, id, ownerScope);
          if (!deleted) return respond(res, 404, { error: 'Link not found.' });
          return respond(res, 200, { ok: true });
        }
      }
  return false;
}
