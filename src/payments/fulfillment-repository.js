import { creditCreatorSale } from '../wallet/repository.js';
import { getBotSlotSettings, creditBotSlotPurchase } from '../delivery/slot-repository.js';

function priceMatchesTransaction(tx, basePriceMinor, currency) {
  if (tx.method === 'telegram_stars') return true;
  if (currency !== tx.currency) return false;
  if (tx.method === 'fampay') {
    return Number(tx.amount_minor) >= Number(basePriceMinor) && Number(tx.amount_minor) <= Number(basePriceMinor) + 99;
  }
  return Number(basePriceMinor) === Number(tx.amount_minor);
}

export async function applyVerifiedPayment(pool, transactionId, options = {}) {
  const id = Number(transactionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid payment transaction ID.');
  const adminSet = new Set((options?.adminIds ?? []).map((aid) => Number(aid)).filter((aid) => Number.isSafeInteger(aid)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txResult = await client.query(
      `SELECT id, user_telegram_id, method, purpose, plan_id, file_id, batch_link_id, paid_link_id, amount_minor, currency, status, session_id
       FROM payment_transactions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!txResult.rowCount) throw new Error('Payment transaction not found.');
    const tx = txResult.rows[0];
    if (tx.status === 'applied') {
      await client.query('COMMIT');
      return { alreadyApplied: true, purpose: tx.purpose, userId: tx.user_telegram_id };
    }
    if (tx.status !== 'verified') throw new Error('Only verified transactions can be fulfilled.');
    if (!tx.user_telegram_id || !tx.session_id) throw new Error('Verified transaction missing user or checkout session.');
    const sessionResult = await client.query(
      'SELECT id, status, user_telegram_id, purpose, plan_id, file_id, batch_link_id, paid_link_id, expected_amount_minor, currency, metadata FROM payment_sessions WHERE id=$1 FOR UPDATE',
      [tx.session_id],
    );
    if (!sessionResult.rowCount) throw new Error('Payment session not found.');
    const session = sessionResult.rows[0];
    if (session.status !== 'verified' || String(session.user_telegram_id) !== String(tx.user_telegram_id) ||
        session.purpose !== tx.purpose || Number(session.expected_amount_minor) !== Number(tx.amount_minor) ||
        session.currency !== tx.currency || String(session.plan_id ?? '') !== String(tx.plan_id ?? '') ||
        String(session.file_id ?? '') !== String(tx.file_id ?? '') ||
        String(session.batch_link_id ?? '') !== String(tx.batch_link_id ?? '') ||
        String(session.paid_link_id ?? '') !== String(tx.paid_link_id ?? '')) throw new Error('Checkout session does not match verified transaction.');
    const userId = tx.user_telegram_id;
    await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING', [userId]);
    let result;
    let creatorCredit = null;
    if (tx.purpose === 'premium') {
      const plan = await client.query('SELECT id,name,price_minor,currency,duration_days,owner_telegram_id FROM premium_plans WHERE id=$1 FOR UPDATE', [tx.plan_id]);
      if (!plan.rowCount) throw new Error('Premium plan is unavailable.');
      const p = plan.rows[0];
      const planOwnerId = p.owner_telegram_id !== undefined && p.owner_telegram_id !== null ? Number(p.owner_telegram_id) : null;
      if (!priceMatchesTransaction(tx, p.price_minor, p.currency) || String(session.plan_id) !== String(tx.plan_id)) throw new Error('Paid amount does not match current Premium plan price.');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
      const active = await client.query(
        `SELECT id, expires_at FROM premium_memberships
         WHERE user_telegram_id=$1 AND owner_telegram_id IS NOT DISTINCT FROM $2 AND status='active'
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY expires_at DESC NULLS FIRST LIMIT 1 FOR UPDATE`,
        [userId, planOwnerId],
      );
      if (active.rowCount && active.rows[0].expires_at === null) {
        result = { type: 'premium', permanent: true, plan: p.name, ownerTelegramId: planOwnerId };
      } else {
        const start = active.rowCount ? new Date(active.rows[0].expires_at) : new Date();
        const end = new Date(start);
        end.setDate(end.getDate() + Number(p.duration_days));
        if (active.rowCount) {
          await client.query(
            `UPDATE premium_memberships SET plan_id=$2, owner_telegram_id=$3, expires_at=$4, status='active', source='payment', granted_by=NULL, updated_at=NOW() WHERE id=$1`,
            [active.rows[0].id, p.id, planOwnerId, end],
          );
        } else {
          await client.query(
            `INSERT INTO premium_memberships (user_telegram_id,plan_id,owner_telegram_id,status,starts_at,expires_at,source)
             VALUES ($1,$2,$3,'active',NOW(),$4,'payment')`,
            [userId, p.id, planOwnerId, end],
          );
        }
        result = { type: 'premium', plan: p.name, days: Number(p.duration_days), expiresAt: end, ownerTelegramId: planOwnerId };
      }
      if (planOwnerId && !adminSet.has(planOwnerId)) {
        const creditCurrency = tx.method === 'telegram_stars' ? tx.currency : p.currency;
        const creditAmount = tx.method === 'telegram_stars' ? Number(tx.amount_minor) : Number(p.price_minor);
        const credited = await creditCreatorSale(client, {
          creatorId: planOwnerId,
          currency: creditCurrency,
          amountMinor: creditAmount,
          paymentTransactionId: tx.id,
          referenceCode: `PLAN#${p.id}`,
          note: `Premium plan sale (${p.name})`,
        });
        if (credited.credited) {
          creatorCredit = {
            ...credited,
            referenceCode: `PLAN#${p.id}`,
            saleType: 'premium_plan',
            planName: p.name,
          };
        }
      }
    } else if (tx.purpose === 'paid_file') {
      const linkResult = await client.query(
        `SELECT id,file_id,price_minor,currency,public_code,created_by FROM paid_file_links WHERE id=$1 FOR UPDATE`,
        [tx.paid_link_id],
      );
      if (!linkResult.rowCount) throw new Error('Paid file link is expired, disabled, or missing.');
      const link = linkResult.rows[0];
      if (String(link.file_id) !== String(tx.file_id) || !priceMatchesTransaction(tx, link.price_minor, link.currency)) throw new Error('Payment does not match paid-file link price or file.');
      const purchase = await client.query(
        `INSERT INTO paid_file_purchases (paid_link_id,user_telegram_id,payment_transaction_id,status,paid_amount_minor,currency,payment_method,verified_at)
         VALUES ($1,$2,$3,'paid',$4,$5,$6,NOW())
         ON CONFLICT (paid_link_id,user_telegram_id) DO UPDATE SET status='paid',payment_transaction_id=EXCLUDED.payment_transaction_id,paid_amount_minor=EXCLUDED.paid_amount_minor,currency=EXCLUDED.currency,payment_method=EXCLUDED.payment_method,verified_at=NOW(),updated_at=NOW()
         RETURNING id`,
        [link.id,userId,tx.id,tx.amount_minor,tx.currency,tx.method],
      );
      await client.query(
        `INSERT INTO access_grants (user_telegram_id,resource_type,resource_id,grant_reason,expires_at)
         VALUES ($1,'file',$2,$3,NULL) ON CONFLICT (user_telegram_id,resource_type,resource_id)
         DO UPDATE SET grant_reason=EXCLUDED.grant_reason,expires_at=NULL`,
        [userId,link.file_id,'paid_file_payment:'+tx.id],
      );
      if (link.created_by && !adminSet.has(Number(link.created_by))) {
        const creditCurrency = tx.method === 'telegram_stars' ? tx.currency : link.currency;
        const creditAmount = tx.method === 'telegram_stars' ? Number(tx.amount_minor) : Number(link.price_minor);
        const credited = await creditCreatorSale(client, {
          creatorId: link.created_by,
          currency: creditCurrency,
          amountMinor: creditAmount,
          paymentTransactionId: tx.id,
          referenceCode: link.public_code ?? `LINK#${link.id}`,
          note: `Paid file sale (${link.public_code ?? link.id})`,
        });
        if (credited.credited) {
          creatorCredit = { ...credited, referenceCode: link.public_code ?? null };
        }
      }
      result = { type: 'paid_file', fileId: link.file_id, purchaseId: purchase.rows[0].id };
    } else if (tx.purpose === 'paid_batch') {
      const batchResult = await client.query(
        `SELECT id,title,price_minor,currency,public_code,created_by FROM paid_batch_links WHERE id=$1 FOR UPDATE`,
        [tx.batch_link_id],
      );
      if (!batchResult.rowCount) throw new Error('Paid batch is expired, disabled, or missing.');
      const batch = batchResult.rows[0];
      if (!priceMatchesTransaction(tx, batch.price_minor, batch.currency) || String(session.batch_link_id) !== String(batch.id)) throw new Error('Payment does not match paid-batch price.');
      const purchase = await client.query(
        `INSERT INTO paid_batch_purchases (batch_link_id,user_telegram_id,status,paid_amount_minor,currency,payment_transaction_id,payment_method,verified_at)
         VALUES ($1,$2,'paid',$3,$4,$5,$6,NOW())
         ON CONFLICT (batch_link_id,user_telegram_id) DO UPDATE SET status='paid',paid_amount_minor=EXCLUDED.paid_amount_minor,currency=EXCLUDED.currency,payment_transaction_id=EXCLUDED.payment_transaction_id,payment_method=EXCLUDED.payment_method,verified_at=NOW(),updated_at=NOW()
         RETURNING id`,
        [batch.id,userId,tx.amount_minor,tx.currency,tx.id,tx.method],
      );
      const items = await client.query('SELECT file_id FROM paid_batch_items WHERE batch_link_id=$1 ORDER BY position', [batch.id]);
      if (!items.rowCount) throw new Error('Paid batch contains no files.');
      for (const item of items.rows) {
        await client.query(
          `INSERT INTO access_grants (user_telegram_id,resource_type,resource_id,grant_reason,expires_at)
           VALUES ($1,'file',$2,$3,NULL) ON CONFLICT (user_telegram_id,resource_type,resource_id)
           DO UPDATE SET grant_reason=EXCLUDED.grant_reason,expires_at=NULL`,
          [userId,item.file_id,'paid_batch_payment:'+purchase.rows[0].id],
        );
      }
      if (batch.created_by && !adminSet.has(Number(batch.created_by))) {
        const creditCurrency = tx.method === 'telegram_stars' ? tx.currency : batch.currency;
        const creditAmount = tx.method === 'telegram_stars' ? Number(tx.amount_minor) : Number(batch.price_minor);
        const credited = await creditCreatorSale(client, {
          creatorId: batch.created_by,
          currency: creditCurrency,
          amountMinor: creditAmount,
          paymentTransactionId: tx.id,
          referenceCode: batch.public_code ?? `BATCH#${batch.id}`,
          note: `Paid batch sale (${batch.title ?? batch.public_code ?? batch.id})`,
        });
        if (credited.credited) {
          creatorCredit = { ...credited, referenceCode: batch.public_code ?? null };
        }
      }
      result = { type: 'paid_batch', batchId: batch.id, purchaseId: purchase.rows[0].id, fileCount: items.rowCount };
    } else if (tx.purpose === 'bot_slot') {
      const slotSettings = await getBotSlotSettings(client);
      const expectedBaseMinor = Number(session.metadata?.baseAmountMinor) > 0
        ? Number(session.metadata.baseAmountMinor)
        : Number(slotSettings.priceMinor);
      if (!priceMatchesTransaction(tx, expectedBaseMinor, slotSettings.currency || 'INR')) {
        throw new Error('Payment amount does not match extra Delivery Bot slot price.');
      }
      const credited = await creditBotSlotPurchase(client, {
        userId,
        paymentTransactionId: tx.id,
        amountMinor: tx.amount_minor,
        currency: tx.currency,
        method: tx.method,
      });
      result = { type: 'bot_slot', extraSlots: credited.extraSlots, credited: credited.credited };
    } else {
      throw new Error('Unsupported payment purpose.');
    }
    await client.query(`UPDATE payment_transactions SET status='applied',applied_at=NOW(),updated_at=NOW() WHERE id=$1`, [tx.id]);
    await client.query(`UPDATE payment_sessions SET status='applied',updated_at=NOW() WHERE id=$1`, [tx.session_id]);
    await client.query(
      `INSERT INTO activity_logs (event_type,actor_telegram_id,target_telegram_id,details)
       VALUES ('payment_fulfilled',NULL,$1,$2::jsonb)`,
      [userId, JSON.stringify({ transactionId: tx.id, purpose: tx.purpose, method: tx.method, amountMinor: tx.amount_minor, currency: tx.currency, result, creatorCredit })],
    );
    await client.query('COMMIT');
    return { applied: true, userId, transactionId: tx.id, ...result, ...(creatorCredit ? { creatorCredit } : {}) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
