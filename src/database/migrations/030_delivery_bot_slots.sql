ALTER TABLE user_creator_settings
  ADD COLUMN IF NOT EXISTS extra_bot_slots INTEGER NOT NULL DEFAULT 0 CHECK (extra_bot_slots >= 0);

ALTER TABLE payment_sessions
  DROP CONSTRAINT IF EXISTS payment_sessions_purpose_check;
ALTER TABLE payment_sessions
  ADD CONSTRAINT payment_sessions_purpose_check
  CHECK (purpose IN ('premium', 'paid_file', 'paid_batch', 'bot_slot'));

ALTER TABLE payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_purpose_check;
ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_purpose_check
  CHECK (purpose IN ('premium', 'paid_file', 'paid_batch', 'bot_slot'));

ALTER TABLE wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;
ALTER TABLE wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN ('sale_credit', 'withdrawal_hold', 'withdrawal_paid', 'withdrawal_refund', 'slot_purchase'));

CREATE TABLE IF NOT EXISTS bot_slot_purchases (
  id BIGSERIAL PRIMARY KEY,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  slots_added INTEGER NOT NULL DEFAULT 1 CHECK (slots_added > 0),
  payment_method TEXT NOT NULL,
  payment_transaction_id BIGINT UNIQUE REFERENCES payment_transactions(id) ON DELETE SET NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bot_slot_purchases_user_idx
  ON bot_slot_purchases (user_telegram_id, created_at DESC);

INSERT INTO app_settings (key, value)
VALUES ('bot_slot_settings', '{"priceMinor": 9900, "currency": "INR", "starsPrice": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
