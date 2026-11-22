import { cacheDeletePrefix } from '../utils/cache.js';

export const FREE_CREATOR_BOT_SLOTS = 1;
export const DEFAULT_BOT_SLOT_PRICE_MINOR = 9900; // ₹99.00 INR
export const MIN_BOT_SLOT_PRICE_MINOR = 100; // ₹1.00 INR
export const MAX_BOT_SLOT_PRICE_MINOR = 100_000_000; // ₹10,00,000.00 INR

const SETTINGS_KEY = 'bot_slot_settings';

export async function getBotSlotSettings(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
      [SETTINGS_KEY],
    );
    const raw = rows[0]?.value;
    const priceMinor = Number(raw?.priceMinor);
    const starsRaw = raw?.starsPrice === null || raw?.starsPrice === undefined ? null : Number(raw.starsPrice);
    return {
      priceMinor: Number.isSafeInteger(priceMinor) && priceMinor >= MIN_BOT_SLOT_PRICE_MINOR
        ? priceMinor
        : DEFAULT_BOT_SLOT_PRICE_MINOR,
      currency: 'INR',
      starsPrice: Number.isSafeInteger(starsRaw) && starsRaw > 0 ? starsRaw : null,
    };
  } catch {
    return {
      priceMinor: DEFAULT_BOT_SLOT_PRICE_MINOR,
      currency: 'INR',
      starsPrice: null,
    };
  }
}

export async function setBotSlotSettings(pool, { priceMinor, starsPrice = undefined }, actorId = null) {
  const cleanPrice = Number(priceMinor);
  if (!Number.isSafeInteger(cleanPrice) || cleanPrice < MIN_BOT_SLOT_PRICE_MINOR || cleanPrice > MAX_BOT_SLOT_PRICE_MINOR) {
    throw new Error('Slot unlock price must be at least ₹1.00 INR (100 paise).');
  }

  const current = await getBotSlotSettings(pool);
  let nextStars = current.starsPrice;
  if (starsPrice !== undefined) {
    if (starsPrice === null || String(starsPrice).trim() === '' || Number(starsPrice) === 0) {
      nextStars = null;
    } else {
      const s = Number(starsPrice);
      if (!Number.isSafeInteger(s) || s < 1 || s > 100_000_000) {
        throw new Error('Telegram Stars slot price must be blank/0 or a positive integer.');
      }
      nextStars = s;
    }
  }

  const payload = {
    priceMinor: cleanPrice,
    currency: 'INR',
    starsPrice: nextStars,
  };

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [SETTINGS_KEY, JSON.stringify(payload), actorId ? Number(actorId) : null],
  );

  return payload;
}

export async function getCreatorBotSlotQuota(pool, ownerId, isOwner = false) {
  const settings = await getBotSlotSettings(pool);
  if (isOwner || ownerId === null || ownerId === undefined) {
    const countRes = await pool.query(
      'SELECT COUNT(*)::int AS used FROM delivery_bots WHERE owner_telegram_id IS NULL',
    ).catch(() => ({ rows: [{ used: 0 }] }));
    return {
      isUnlimited: true,
      freeSlots: FREE_CREATOR_BOT_SLOTS,
      extraSlots: 0,
      usedSlots: Number(countRes.rows[0]?.used ?? 0),
      totalAllowed: null,
      remainingSlots: null,
      priceMinor: settings.priceMinor,
      currency: settings.currency,
      starsPrice: settings.starsPrice,
    };
  }

  const uid = Number(ownerId);
  const [settingsRes, usedRes] = await Promise.all([
    pool.query(
      'SELECT extra_bot_slots FROM user_creator_settings WHERE user_telegram_id = $1 LIMIT 1',
      [uid],
    ).catch(() => ({ rows: [] })),
    pool.query(
      'SELECT COUNT(*)::int AS used FROM delivery_bots WHERE owner_telegram_id = $1',
      [uid],
    ).catch(() => ({ rows: [{ used: 0 }] })),
  ]);

  const extraSlots = Math.max(0, Number(settingsRes.rows[0]?.extra_bot_slots ?? 0));
  const usedSlots = Math.max(0, Number(usedRes.rows[0]?.used ?? 0));
  const totalAllowed = FREE_CREATOR_BOT_SLOTS + extraSlots;
  const remainingSlots = Math.max(0, totalAllowed - usedSlots);

  return {
    isUnlimited: false,
    freeSlots: FREE_CREATOR_BOT_SLOTS,
    extraSlots,
    usedSlots,
    totalAllowed,
    remainingSlots,
    priceMinor: settings.priceMinor,
    currency: settings.currency,
    starsPrice: settings.starsPrice,
  };
}

/**
 * Credits +1 delivery bot slot inside an active payment fulfillment DB transaction.
 * Strictly idempotent via UNIQUE(payment_transaction_id) on bot_slot_purchases.
 */
export async function creditBotSlotPurchase(
  client,
  { userId, paymentTransactionId = null, amountMinor, currency = 'INR', method = 'fampay' },
) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid Telegram user ID.');
  await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING', [uid]);

  if (paymentTransactionId !== null && paymentTransactionId !== undefined) {
    const ins = await client.query(
      `INSERT INTO bot_slot_purchases
         (user_telegram_id, slots_added, payment_method, payment_transaction_id, amount_minor, currency)
       VALUES ($1, 1, $2, $3, $4, $5)
       ON CONFLICT (payment_transaction_id) DO NOTHING
       RETURNING id`,
      [uid, String(method || 'fampay'), Number(paymentTransactionId), Number(amountMinor || 0), String(currency || 'INR').toUpperCase()],
    );
    if (!ins.rowCount) {
      const existing = await client.query(
        'SELECT extra_bot_slots FROM user_creator_settings WHERE user_telegram_id = $1 LIMIT 1',
        [uid],
      );
      return { credited: false, duplicate: true, extraSlots: Number(existing.rows[0]?.extra_bot_slots ?? 0) };
    }
  } else {
    await client.query(
      `INSERT INTO bot_slot_purchases
         (user_telegram_id, slots_added, payment_method, payment_transaction_id, amount_minor, currency)
       VALUES ($1, 1, $2, NULL, $3, $4)`,
      [uid, String(method || 'wallet'), Number(amountMinor || 0), String(currency || 'INR').toUpperCase()],
    );
  }

  const updated = await client.query(
    `INSERT INTO user_creator_settings (user_telegram_id, extra_bot_slots)
     VALUES ($1, 1)
     ON CONFLICT (user_telegram_id)
     DO UPDATE SET extra_bot_slots = user_creator_settings.extra_bot_slots + 1, updated_at = NOW()
     RETURNING extra_bot_slots`,
    [uid],
  );
  cacheDeletePrefix(`creator-settings:${uid}:`);
  return {
    credited: true,
    extraSlots: Number(updated.rows[0]?.extra_bot_slots ?? 1),
  };
}

/**
 * Allows a creator to spend their earned Available INR Wallet balance directly
 * to unlock +1 Delivery Bot slot atomically.
 */
export async function unlockSlotWithWallet(pool, userId) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid Telegram user ID.');
  const settings = await getBotSlotSettings(pool);
  const priceMinor = Number(settings.priceMinor);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING', [uid]);

    const walletRes = await client.query(
      `SELECT available_minor FROM creator_wallets
       WHERE user_telegram_id = $1 AND currency = 'INR' FOR UPDATE`,
      [uid],
    );
    const available = Number(walletRes.rows[0]?.available_minor ?? 0);
    if (available < priceMinor) {
      throw new Error(
        `Insufficient wallet balance. Required: ₹${(priceMinor / 100).toFixed(2)} INR, available: ₹${(available / 100).toFixed(2)} INR.`,
      );
    }

    const updWallet = await client.query(
      `UPDATE creator_wallets
       SET available_minor = available_minor - $2, updated_at = NOW()
       WHERE user_telegram_id = $1 AND currency = 'INR' AND available_minor >= $2
       RETURNING available_minor`,
      [uid, priceMinor],
    );
    if (!updWallet.rowCount) {
      throw new Error('Insufficient wallet balance for slot purchase.');
    }

    const balanceAfter = Number(updWallet.rows[0].available_minor);
    const slotRes = await creditBotSlotPurchase(client, {
      userId: uid,
      paymentTransactionId: null,
      amountMinor: priceMinor,
      currency: 'INR',
      method: 'wallet',
    });

    await client.query(
      `INSERT INTO wallet_ledger
         (user_telegram_id, currency, entry_type, amount_minor, balance_after_minor, reference_code, note)
       VALUES ($1, 'INR', 'slot_purchase', $2, $3, $4, $5)`,
      [uid, -priceMinor, balanceAfter, `BOTSLOT+1`, 'Unlocked +1 extra Delivery Bot slot'],
    );

    await client.query(
      `INSERT INTO activity_logs (event_type, actor_telegram_id, target_telegram_id, details)
       VALUES ('bot_slot_unlocked', $1, $1, $2::jsonb)`,
      [uid, JSON.stringify({ method: 'wallet', amountMinor: priceMinor, currency: 'INR', extraSlots: slotRes.extraSlots })],
    );

    await client.query('COMMIT');
    return {
      ok: true,
      method: 'wallet',
      amountMinor: priceMinor,
      currency: 'INR',
      extraSlots: slotRes.extraSlots,
      availableAfterMinor: balanceAfter,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
