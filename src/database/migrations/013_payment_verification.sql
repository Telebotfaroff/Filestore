-- M19 payment verification groundwork: idempotent provider receipts and safer transaction matching.
CREATE TABLE IF NOT EXISTS payment_provider_events (
  id BIGSERIAL PRIMARY KEY,
  method TEXT NOT NULL REFERENCES payment_methods(method) ON DELETE RESTRICT,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received','processed','ignored','failed')),
  payment_transaction_id BIGINT REFERENCES payment_transactions(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE(method, provider_event_id)
);
CREATE INDEX IF NOT EXISTS payment_provider_events_status_idx ON payment_provider_events(processing_status, received_at DESC);

ALTER TABLE payment_sessions
  ADD COLUMN IF NOT EXISTS provider_checkout_url TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS payment_sessions_expiry_idx ON payment_sessions(status, expires_at);
