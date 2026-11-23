-- Foolproof referral program: unique per-user tokens, one-time atomic referrals,
-- referral_reward wallet ledger entry type, and owner-configurable reward settings.

CREATE TABLE IF NOT EXISTS referral_codes (
  user_telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  referrer_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  referred_telegram_id BIGINT NOT NULL UNIQUE REFERENCES users(telegram_id) ON DELETE CASCADE,
  referral_token TEXT NOT NULL,
  reward_minor BIGINT NOT NULL CHECK (reward_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'credited' CHECK (status IN ('credited', 'reversed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (referrer_telegram_id <> referred_telegram_id)
);

CREATE INDEX IF NOT EXISTS referrals_referrer_idx
  ON referrals (referrer_telegram_id, created_at DESC, id DESC);

ALTER TABLE wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;
ALTER TABLE wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN ('sale_credit', 'withdrawal_hold', 'withdrawal_paid', 'withdrawal_refund', 'slot_purchase', 'referral_reward'));

INSERT INTO app_settings (key, value)
VALUES ('referral_settings', '{"enabled": true, "rewardMinor": 100, "currency": "INR"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
