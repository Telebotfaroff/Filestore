-- Web Panel Token-Based Access (SHA-256 hashed unique token per Telegram user)

CREATE TABLE IF NOT EXISTS web_access_tokens (
  telegram_user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_web_access_tokens_hash
  ON web_access_tokens (token_hash);
