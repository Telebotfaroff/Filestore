import { cached, cacheDeletePrefix } from '../utils/cache.js';
import { normalizeUpiId } from '../payments/fampay.js';

const CREATOR_SETTINGS_TTL = 45_000;
const invalidateCreatorSettings = (userId) => cacheDeletePrefix(`creator-settings:${Number(userId)}:`);

export const MIN_WITHDRAWAL_INR_MINOR = 100; // ₹1.00 minimum UPI payout

export async function getCreatorSettings(pool, userId) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return { user_telegram_id: null, checkpoint_enabled: false, force_sub_enabled: false, payout_upi_id: null };
  return cached(`creator-settings:${uid}:value`, CREATOR_SETTINGS_TTL, async () => {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    return {
      user_telegram_id: null,
      checkpoint_enabled: false,
      force_sub_enabled: false,
      payout_upi_id: null,
    };
  }
  const { rows } = await pool.query(
    `SELECT user_telegram_id, checkpoint_enabled, force_sub_enabled, payout_upi_id, updated_at
     FROM user_creator_settings WHERE user_telegram_id = $1 LIMIT 1`,
    [uid],
  );
  if (rows[0]) return rows[0];
  return {
    user_telegram_id: uid,
    checkpoint_enabled: false,
    force_sub_enabled: false,
    payout_upi_id: null,
    updated_at: null,
  };
  });
}

async function ensureUserRow(db, userId) {
  await db.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING', [Number(userId)]);
}

export async function setCreatorCheckpointEnabled(pool, userId, enabled) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid user ID.');
  await ensureUserRow(pool, uid);
  const { rows } = await pool.query(
    `INSERT INTO user_creator_settings (user_telegram_id, checkpoint_enabled)
     VALUES ($1, $2)
     ON CONFLICT (user_telegram_id) DO UPDATE SET checkpoint_enabled = EXCLUDED.checkpoint_enabled, updated_at = NOW()
     RETURNING user_telegram_id, checkpoint_enabled, force_sub_enabled, payout_upi_id`,
    [uid, Boolean(enabled)],
  );
  invalidateCreatorSettings(uid);
  return rows[0];
}
export async function setCreatorForceSubEnabled(pool, userId, enabled) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid user ID.');
  await ensureUserRow(pool, uid);
  const { rows } = await pool.query(
    `INSERT INTO user_creator_settings (user_telegram_id, force_sub_enabled)
     VALUES ($1, $2)
     ON CONFLICT (user_telegram_id) DO UPDATE SET force_sub_enabled = EXCLUDED.force_sub_enabled, updated_at = NOW()
     RETURNING user_telegram_id, checkpoint_enabled, force_sub_enabled, payout_upi_id`,
    [uid, Boolean(enabled)],
  );
  invalidateCreatorSettings(uid);
  return rows[0];
}

export async function setCreatorPayoutUpi(pool, userId, rawUpiId) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid user ID.');
  const upiId = normalizeUpiId(rawUpiId);
  await ensureUserRow(pool, uid);
  const { rows } = await pool.query(
    `INSERT INTO user_creator_settings (user_telegram_id, payout_upi_id)
     VALUES ($1, $2)
     ON CONFLICT (user_telegram_id) DO UPDATE SET payout_upi_id = EXCLUDED.payout_upi_id, updated_at = NOW()
     RETURNING user_telegram_id, checkpoint_enabled, force_sub_enabled, payout_upi_id`,
    [uid, upiId],
  );
  invalidateCreatorSettings(uid);
  return rows[0];
}

export async function getCreatorWalletSummary(pool, userId) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid user ID.');

  const [settings, walletsRes, ledgerRes, withdrawalsRes] = await Promise.all([
    getCreatorSettings(pool, uid),
    pool.query(
      `SELECT currency, available_minor, locked_minor, total_earned_minor, total_withdrawn_minor, updated_at
       FROM creator_wallets WHERE user_telegram_id = $1 ORDER BY currency ASC`,
      [uid],
    ),
    pool.query(
      `SELECT id, currency, entry_type, amount_minor, balance_after_minor, reference_code, note, created_at
       FROM wallet_ledger WHERE user_telegram_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10`,
      [uid],
    ),
    pool.query(
      `SELECT id, currency, amount_minor, upi_id, status, payout_reference, admin_note, processed_at, created_at
       FROM withdrawal_requests WHERE user_telegram_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10`,
      [uid],
    ),
  ]);

  const empty = (currency) => ({
    currency,
    available_minor: 0,
    locked_minor: 0,
    total_earned_minor: 0,
    total_withdrawn_minor: 0,
  });

  const inrWallet = walletsRes.rows.find((w) => w.currency === 'INR') ?? empty('INR');
  const xtrWallet = walletsRes.rows.find((w) => w.currency === 'XTR') ?? null;

  return {
    userId: uid,
    settings,
    wallets: walletsRes.rows,
    inrWallet,
    xtrWallet,
    recentLedger: ledgerRes.rows,
    recentWithdrawals: withdrawalsRes.rows,
  };
}

/**
 * Credits a creator's wallet idempotently inside an active DB transaction when their paid link sells.
 * Never credits for premium subscriptions or platform admin-owned links (filtered by caller).
 */
export async function creditCreatorSale(
  client,
  { creatorId, currency = 'INR', amountMinor, paymentTransactionId, referenceCode = null, note = null },
) {
  const uid = Number(creatorId);
  const amount = Number(amountMinor);
  const curr = String(currency || 'INR').toUpperCase();
  if (!Number.isSafeInteger(uid) || uid <= 0) return { credited: false, reason: 'invalid_creator' };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { credited: false, reason: 'non_positive_amount' };

  await ensureUserRow(client, uid);

  const dup = await client.query(
    `SELECT id FROM wallet_ledger
     WHERE payment_transaction_id = $1 AND entry_type = 'sale_credit' LIMIT 1`,
    [paymentTransactionId],
  );
  if (dup.rowCount) {
    return { credited: false, duplicate: true };
  }

  const walletRes = await client.query(
    `INSERT INTO creator_wallets (user_telegram_id, currency, available_minor, total_earned_minor)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_telegram_id, currency) DO UPDATE SET
       available_minor = creator_wallets.available_minor + EXCLUDED.available_minor,
       total_earned_minor = creator_wallets.total_earned_minor + EXCLUDED.total_earned_minor,
       updated_at = NOW()
     RETURNING available_minor, total_earned_minor`,
    [uid, curr, amount],
  );

  const balanceAfter = Number(walletRes.rows[0]?.available_minor ?? amount);
  await client.query(
    `INSERT INTO wallet_ledger
       (user_telegram_id, currency, entry_type, amount_minor, balance_after_minor, payment_transaction_id, reference_code, note)
     VALUES ($1, $2, 'sale_credit', $3, $4, $5, $6, $7)`,
    [uid, curr, amount, balanceAfter, paymentTransactionId, referenceCode, note ? String(note).slice(0, 240) : null],
  );

  return {
    credited: true,
    creatorId: uid,
    currency: curr,
    amountMinor: amount,
    balanceAfterMinor: balanceAfter,
  };
}

export async function requestWithdrawal(pool, { userId, amountMinor = null, upiId = null, currency = 'INR' } = {}) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid user ID.');
  const curr = String(currency || 'INR').toUpperCase();
  if (curr !== 'INR') throw new Error('Only INR balance can be withdrawn via UPI.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureUserRow(client, uid);

    let resolvedUpi = upiId ? normalizeUpiId(upiId) : null;
    const settingsRes = await client.query(
      'SELECT payout_upi_id FROM user_creator_settings WHERE user_telegram_id = $1 FOR UPDATE',
      [uid],
    );
    if (!resolvedUpi) {
      resolvedUpi = settingsRes.rows[0]?.payout_upi_id ?? null;
    } else {
      await client.query(
        `INSERT INTO user_creator_settings (user_telegram_id, payout_upi_id)
         VALUES ($1, $2)
         ON CONFLICT (user_telegram_id) DO UPDATE SET payout_upi_id = EXCLUDED.payout_upi_id, updated_at = NOW()`,
        [uid, resolvedUpi],
      );
    }
    if (!resolvedUpi) {
      throw new Error('Set your payout UPI ID first before requesting a withdrawal.');
    }

    const walletRes = await client.query(
      `SELECT available_minor, locked_minor FROM creator_wallets
       WHERE user_telegram_id = $1 AND currency = $2 FOR UPDATE`,
      [uid, curr],
    );
    const available = Number(walletRes.rows[0]?.available_minor ?? 0);
    if (available < MIN_WITHDRAWAL_INR_MINOR) {
      throw new Error(`Minimum withdrawal is ₹${(MIN_WITHDRAWAL_INR_MINOR / 100).toFixed(2)} INR. Your available balance is ₹${(available / 100).toFixed(2)}.`);
    }

    const withdrawAmount = amountMinor === null || amountMinor === undefined ? available : Number(amountMinor);
    if (!Number.isSafeInteger(withdrawAmount) || withdrawAmount < MIN_WITHDRAWAL_INR_MINOR) {
      throw new Error(`Withdrawal amount must be at least ₹${(MIN_WITHDRAWAL_INR_MINOR / 100).toFixed(2)} INR.`);
    }
    if (withdrawAmount > available) {
      throw new Error(`Insufficient balance. Available: ₹${(available / 100).toFixed(2)} INR.`);
    }

    const updatedWallet = await client.query(
      `UPDATE creator_wallets
       SET available_minor = available_minor - $3,
           locked_minor = locked_minor + $3,
           updated_at = NOW()
       WHERE user_telegram_id = $1 AND currency = $2 AND available_minor >= $3
       RETURNING available_minor, locked_minor`,
      [uid, curr, withdrawAmount],
    );
    if (!updatedWallet.rowCount) {
      throw new Error('Insufficient available balance for withdrawal.');
    }

    const reqRes = await client.query(
      `INSERT INTO withdrawal_requests (user_telegram_id, currency, amount_minor, upi_id, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, user_telegram_id, currency, amount_minor, upi_id, status, created_at`,
      [uid, curr, withdrawAmount, resolvedUpi],
    );
    const withdrawal = reqRes.rows[0];
    const balanceAfter = Number(updatedWallet.rows[0].available_minor);

    await client.query(
      `INSERT INTO wallet_ledger
         (user_telegram_id, currency, entry_type, amount_minor, balance_after_minor, withdrawal_request_id, reference_code, note)
       VALUES ($1, $2, 'withdrawal_hold', $3, $4, $5, $6, $7)`,
      [uid, curr, -withdrawAmount, balanceAfter, withdrawal.id, `WD#${withdrawal.id}`, `Withdrawal request to ${resolvedUpi}`],
    );

    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('withdrawal_requested', $1, $1, $2::jsonb)`,
      [uid, JSON.stringify({ withdrawalId: withdrawal.id, amountMinor: withdrawAmount, currency: curr, upiId: resolvedUpi })],
    );

    await client.query('COMMIT');
    if (upiId) invalidateCreatorSettings(uid);
    return {
      withdrawal,
      availableAfterMinor: balanceAfter,
      lockedAfterMinor: Number(updatedWallet.rows[0].locked_minor),
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function listWithdrawalRequests(pool, { status = 'pending', limit = 10, offset = 0, userId = null } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 30);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const clauses = [];
  const params = [];
  if (status && status !== 'all') {
    params.push(status);
    clauses.push(`w.status = $${params.length}`);
  }
  if (userId !== null && userId !== undefined) {
    params.push(Number(userId));
    clauses.push(`w.user_telegram_id = $${params.length}`);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM withdrawal_requests w ${whereSql}`,
    params,
  );
  const total = Number(countRes.rows[0]?.total ?? 0);
  const listParams = [...params, safeLimit, safeOffset];
  const { rows } = await pool.query(
    `SELECT w.id, w.user_telegram_id, w.currency, w.amount_minor, w.upi_id, w.status,
            w.payout_reference, w.admin_note, w.processed_by, w.processed_at, w.created_at,
            u.username, u.first_name
     FROM withdrawal_requests w
     LEFT JOIN users u ON u.telegram_id = w.user_telegram_id
     ${whereSql}
     ORDER BY (w.status = 'pending') DESC, w.created_at DESC, w.id DESC
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams,
  );
  return { total, rows };
}

export async function getWithdrawalRequestById(pool, id) {
  const numId = Number(id);
  if (!Number.isSafeInteger(numId) || numId <= 0) return null;
  const { rows } = await pool.query(
    `SELECT w.*, u.username, u.first_name
     FROM withdrawal_requests w
     LEFT JOIN users u ON u.telegram_id = w.user_telegram_id
     WHERE w.id = $1 LIMIT 1`,
    [numId],
  );
  return rows[0] ?? null;
}

export async function approveWithdrawalPaid(pool, requestId, adminId, { payoutReference = null, adminNote = null } = {}) {
  const id = Number(requestId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid withdrawal request ID.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRes = await client.query('SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!reqRes.rowCount) throw new Error(`Withdrawal request #${id} not found.`);
    const req = reqRes.rows[0];
    if (req.status === 'paid') {
      await client.query('COMMIT');
      return { alreadyProcessed: true, request: req };
    }
    if (req.status !== 'pending') {
      throw new Error(`Withdrawal #${id} is already ${req.status}.`);
    }

    const walletRes = await client.query(
      `SELECT available_minor, locked_minor FROM creator_wallets
       WHERE user_telegram_id = $1 AND currency = $2 FOR UPDATE`,
      [req.user_telegram_id, req.currency],
    );
    if (!walletRes.rowCount || Number(walletRes.rows[0].locked_minor) < Number(req.amount_minor)) {
      throw new Error(`Wallet locked balance mismatch for withdrawal #${id}.`);
    }

    await client.query(
      `UPDATE creator_wallets
       SET locked_minor = locked_minor - $3,
           total_withdrawn_minor = total_withdrawn_minor + $3,
           updated_at = NOW()
       WHERE user_telegram_id = $1 AND currency = $2`,
      [req.user_telegram_id, req.currency, req.amount_minor],
    );

    const cleanRef = payoutReference ? String(payoutReference).trim().slice(0, 120) : null;
    const cleanNote = adminNote ? String(adminNote).trim().slice(0, 240) : null;
    const updRes = await client.query(
      `UPDATE withdrawal_requests
       SET status = 'paid', payout_reference = $2, admin_note = $3, processed_by = $4, processed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, cleanRef, cleanNote, Number(adminId)],
    );

    await client.query(
      `INSERT INTO wallet_ledger
         (user_telegram_id, currency, entry_type, amount_minor, balance_after_minor, withdrawal_request_id, reference_code, note)
       VALUES ($1, $2, 'withdrawal_paid', $3, $4, $5, $6, $7)`,
      [
        req.user_telegram_id,
        req.currency,
        -Number(req.amount_minor),
        Number(walletRes.rows[0].available_minor),
        req.id,
        cleanRef || `WD#${req.id}`,
        `Manual UPI transfer completed to ${req.upi_id}`,
      ],
    );

    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('withdrawal_paid', $1, $2, $3::jsonb)`,
      [Number(adminId), req.user_telegram_id, JSON.stringify({ withdrawalId: req.id, amountMinor: req.amount_minor, upiId: req.upi_id, payoutReference: cleanRef })],
    );

    await client.query('COMMIT');
    return { paid: true, request: updRes.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectWithdrawalRefund(pool, requestId, adminId, { adminNote = null } = {}) {
  const id = Number(requestId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid withdrawal request ID.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRes = await client.query('SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!reqRes.rowCount) throw new Error(`Withdrawal request #${id} not found.`);
    const req = reqRes.rows[0];
    if (req.status === 'rejected') {
      await client.query('COMMIT');
      return { alreadyProcessed: true, request: req };
    }
    if (req.status !== 'pending') {
      throw new Error(`Withdrawal #${id} is already ${req.status}.`);
    }

    const walletRes = await client.query(
      `UPDATE creator_wallets
       SET locked_minor = locked_minor - $3,
           available_minor = available_minor + $3,
           updated_at = NOW()
       WHERE user_telegram_id = $1 AND currency = $2 AND locked_minor >= $3
       RETURNING available_minor`,
      [req.user_telegram_id, req.currency, req.amount_minor],
    );
    if (!walletRes.rowCount) {
      throw new Error(`Wallet locked balance mismatch for withdrawal #${id}.`);
    }

    const cleanNote = adminNote ? String(adminNote).trim().slice(0, 240) : 'Rejected by admin; balance refunded';
    const updRes = await client.query(
      `UPDATE withdrawal_requests
       SET status = 'rejected', admin_note = $2, processed_by = $3, processed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, cleanNote, Number(adminId)],
    );

    await client.query(
      `INSERT INTO wallet_ledger
         (user_telegram_id, currency, entry_type, amount_minor, balance_after_minor, withdrawal_request_id, reference_code, note)
       VALUES ($1, $2, 'withdrawal_refund', $3, $4, $5, $6, $7)`,
      [
        req.user_telegram_id,
        req.currency,
        Number(req.amount_minor),
        Number(walletRes.rows[0].available_minor),
        req.id,
        `WD#${req.id}`,
        cleanNote,
      ],
    );

    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('withdrawal_rejected', $1, $2, $3::jsonb)`,
      [Number(adminId), req.user_telegram_id, JSON.stringify({ withdrawalId: req.id, amountMinor: req.amount_minor, reason: cleanNote })],
    );

    await client.query('COMMIT');
    return { rejected: true, request: updRes.rows[0] };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
