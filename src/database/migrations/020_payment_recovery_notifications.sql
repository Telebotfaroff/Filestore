-- M23: persistent retry queue for customer notifications after payment recovery.
ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS recovery_notification_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_notification_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_notification_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_notification_last_error TEXT;
CREATE INDEX IF NOT EXISTS payment_recovery_notification_idx
  ON payment_transactions(applied_at,id)
  WHERE status='applied' AND recovery_notification_sent_at IS NULL AND recovery_notification_attempts < 10;
