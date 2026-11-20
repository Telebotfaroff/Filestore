-- M22: bounded retry scheduling and diagnostics for verified-payment fulfillment recovery.
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS recovery_last_error TEXT;
CREATE INDEX IF NOT EXISTS payment_transactions_recovery_idx
  ON payment_transactions(recovery_next_at, verified_at, id)
  WHERE status='verified';
