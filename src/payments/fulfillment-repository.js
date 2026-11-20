export async function applyVerifiedPayment(pool, transactionId) {
  const id = Number(transactionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid payment transaction ID.');
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
      'SELECT id, status, user_telegram_id, purpose, plan_id, file_id, batch_link_id, paid_link_id, expected_amount_minor, currency FROM payment_sessions WHERE id=$1 FOR UPDATE',
      [tx.session_id],
    );
    if (!sessionResult.rowCount) throw new Error('Payment session not found.');
    const session = sessionResult.rows[0];
    if (session.status !== 'verified' || String(session.user_telegram_id) !== String(tx.user_telegram_id) ||
        session.purpose !== tx.purpose || Number(session.expected_amount_minor) !== Number(tx.amount_minor) ||
        session.currency !== tx.currency) throw new Error('Checkout session does not match verified transaction.');
    const userId = tx.user_telegram_id;
    await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING', [userId]);
    let result;
    if (tx.purpose === 'premium') {
      const plan = await client.query('SELECT id,name,price_minor,currency,duration_days FROM premium_plans WHERE id=$1 AND is_enabled=TRUE FOR UPDATE', [tx.plan_id]);
      if (!plan.rowCount) throw new Error('Premium plan is unavailable.');
      const p = plan.rows[0];
      if (Number(p.price_minor) !== Number(tx.amount_minor) || p.currency !== tx.currency || String(session.plan_id) !== String(tx.plan_id)) throw new Error('Paid amount does not match current Premium plan price.');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
      const active = await client.query(
        `SELECT id, expires_at FROM premium_memberships WHERE user_telegram_id=$1 AND status='active'
         AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY expires_at DESC NULLS FIRST LIMIT 1 FOR UPDATE`,
        [userId],
      );
      if (active.rowCount && active.rows[0].expires_at === null) {
        result = { type: 'premium', permanent: true, plan: p.name };
      } else {
        const start = active.rowCount ? new Date(active.rows[0].expires_at) : new Date();
        const end = new Date(start);
        end.setDate(end.getDate() + Number(p.duration_days));
        if (active.rowCount) {
          await client.query(
            `UPDATE premium_memberships SET plan_id=$2, expires_at=$3, status='active', source='payment', granted_by=NULL, updated_at=NOW() WHERE id=$1`,
            [active.rows[0].id, p.id, end],
          );
        } else {
          await client.query(
            `INSERT INTO premium_memberships (user_telegram_id,plan_id,status,starts_at,expires_at,source)
             VALUES ($1,$2,'active',NOW(),$3,'payment')`,
            [userId,p.id,end],
          );
        }
        result = { type: 'premium', plan: p.name, days: Number(p.duration_days), expiresAt: end };
      }
    } else if (tx.purpose === 'paid_file') {
      const linkResult = await client.query(
        `SELECT id,file_id,price_minor,currency FROM paid_file_links WHERE id=$1 AND is_enabled=TRUE AND (expires_at IS NULL OR expires_at>NOW()) FOR UPDATE`,
        [tx.paid_link_id],
      );
      if (!linkResult.rowCount) throw new Error('Paid file link is expired, disabled, or missing.');
      const link = linkResult.rows[0];
      if (String(link.file_id) !== String(tx.file_id) || Number(link.price_minor) !== Number(tx.amount_minor) || link.currency !== tx.currency) throw new Error('Payment does not match paid-file link price or file.');
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
      result = { type: 'paid_file', fileId: link.file_id, purchaseId: purchase.rows[0].id };
    } else if (tx.purpose === 'paid_batch') {
      const batchResult = await client.query(
        `SELECT id,title,price_minor,currency FROM paid_batch_links WHERE id=$1 AND is_enabled=TRUE AND (expires_at IS NULL OR expires_at>NOW()) FOR UPDATE`,
        [tx.batch_link_id],
      );
      if (!batchResult.rowCount) throw new Error('Paid batch is expired, disabled, or missing.');
      const batch = batchResult.rows[0];
      if (Number(batch.price_minor) !== Number(tx.amount_minor) || batch.currency !== tx.currency || String(session.batch_link_id) !== String(batch.id)) throw new Error('Payment does not match paid-batch price.');
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
          [userId,'paid_batch_payment:'+purchase.rows[0].id],
        );
      }
      result = { type: 'paid_batch', batchId: batch.id, purchaseId: purchase.rows[0].id, fileCount: items.rowCount };
    } else {
      throw new Error('Unsupported payment purpose.');
    }
    await client.query(`UPDATE payment_transactions SET status='applied',applied_at=NOW(),updated_at=NOW() WHERE id=$1`, [tx.id]);
    await client.query(`UPDATE payment_sessions SET status='applied',updated_at=NOW() WHERE id=$1`, [tx.session_id]);
    await client.query(
      `INSERT INTO activity_logs (event_type,actor_telegram_id,target_telegram_id,details)
       VALUES ('payment_fulfilled',NULL,$1,$2::jsonb)`,
      [userId, JSON.stringify({ transactionId: tx.id, purpose: tx.purpose, method: tx.method, amountMinor: tx.amount_minor, currency: tx.currency, result })],
    );
    await client.query('COMMIT');
    return { applied: true, userId, transactionId: tx.id, ...result };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
