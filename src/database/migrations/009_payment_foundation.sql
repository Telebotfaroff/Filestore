CREATE TABLE IF NOT EXISTS payment_methods (
  id BIGSERIAL PRIMARY KEY,
  method TEXT NOT NULL UNIQUE CHECK (method IN ('fampay', 'telegram_stars', 'stripe', 'crypto')),
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  public_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext TEXT,
  setup_status TEXT NOT NULL DEFAULT 'not_configured' CHECK (setup_status IN ('not_configured', 'configured', 'tested', 'error')),
  last_test_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_test_status IN ('unknown', 'ok', 'failed')),
  last_test_error TEXT,
  updated_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO payment_methods (method) VALUES ('fampay'), ('telegram_stars'), ('stripe'), ('crypto') ON CONFLICT (method) DO NOTHING;

CREATE TABLE IF NOT EXISTS payment_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  method TEXT NOT NULL REFERENCES payment_methods(method) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('premium', 'paid_file')),
  plan_id BIGINT REFERENCES premium_plans(id) ON DELETE SET NULL,
  file_id BIGINT REFERENCES files(id) ON DELETE SET NULL,
  expected_amount_minor BIGINT NOT NULL CHECK (expected_amount_minor >= 0),
  currency TEXT NOT NULL,
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'applied', 'failed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payment_sessions_user_status_idx ON payment_sessions (user_telegram_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_telegram_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
  method TEXT NOT NULL REFERENCES payment_methods(method) ON DELETE RESTRICT,
  external_transaction_id TEXT,
  utr TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('premium', 'paid_file')),
  plan_id BIGINT REFERENCES premium_plans(id) ON DELETE SET NULL,
  file_id BIGINT REFERENCES files(id) ON DELETE SET NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'applied', 'rejected', 'expired')),
  session_id BIGINT REFERENCES payment_sessions(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_external_unique_idx ON payment_transactions (method, external_transaction_id) WHERE external_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_utr_unique_idx ON payment_transactions (utr) WHERE utr IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_transactions_status_created_idx ON payment_transactions (status, created_at DESC);
