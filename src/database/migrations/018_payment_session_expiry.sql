-- M21: automatically expire abandoned pending checkout sessions.
UPDATE payment_sessions SET status='expired', updated_at=NOW()
WHERE status='pending' AND expires_at <= NOW();
CREATE INDEX IF NOT EXISTS payment_sessions_pending_expiry_idx
  ON payment_sessions(expires_at) WHERE status='pending';
