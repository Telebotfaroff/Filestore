-- Owner-configurable platform fee settings and immutable per-transaction fee ledger
-- for creator paid links (single/batch) and creator premium membership sales.

CREATE TABLE IF NOT EXISTS platform_fee_ledger (
  id BIGSERIAL PRIMARY KEY,
  payment_transaction_id BIGINT NOT NULL UNIQUE REFERENCES payment_transactions(id) ON DELETE CASCADE,
  creator_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  sale_type TEXT NOT NULL CHECK (sale_type IN ('paid_file', 'paid_batch', 'premium')),
  reference_code TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  gross_amount_minor BIGINT NOT NULL CHECK (gross_amount_minor > 0),
  fee_bps INTEGER NOT NULL CHECK (fee_bps >= 0 AND fee_bps <= 9000),
  fee_amount_minor BIGINT NOT NULL CHECK (fee_amount_minor >= 0),
  net_amount_minor BIGINT NOT NULL CHECK (net_amount_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS platform_fee_ledger_creator_idx
  ON platform_fee_ledger (creator_telegram_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS platform_fee_ledger_created_idx
  ON platform_fee_ledger (created_at DESC, id DESC);

INSERT INTO app_settings (key, value)
VALUES ('platform_fee_settings', '{"enabled": true, "paidLinkFeeBps": 0, "premiumFeeBps": 0}'::jsonb)
ON CONFLICT (key) DO NOTHING;
