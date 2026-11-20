CREATE TABLE IF NOT EXISTS shortener_providers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  api_endpoint TEXT NOT NULL,
  api_key_ciphertext TEXT,
  api_key_param TEXT NOT NULL DEFAULT 'api',
  target_url_param TEXT NOT NULL DEFAULT 'url',
  response_url_path TEXT NOT NULL DEFAULT 'shortenedUrl',
  response_format TEXT NOT NULL DEFAULT 'json' CHECK (response_format IN ('json', 'text')),
  checkpoint_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (checkpoint_minutes BETWEEN 1 AND 10080),
  priority INTEGER NOT NULL DEFAULT 100,
  verification_mode TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_mode IN ('unverified', 'callback', 'provider_api')),
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_test_status IN ('unknown', 'ok', 'failed')),
  last_test_error TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shortener_providers_enabled_priority_idx ON shortener_providers (is_enabled, priority);

CREATE TABLE IF NOT EXISTS checkpoint_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  provider_id BIGINT NOT NULL REFERENCES shortener_providers(id) ON DELETE RESTRICT,
  verification_token TEXT NOT NULL UNIQUE,
  destination_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS checkpoint_sessions_user_status_idx ON checkpoint_sessions (user_telegram_id, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS user_checkpoint_state (
  user_telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  last_provider_id BIGINT REFERENCES shortener_providers(id) ON DELETE SET NULL,
  checkpoint_expires_at TIMESTAMPTZ,
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
