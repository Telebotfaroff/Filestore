CREATE TABLE IF NOT EXISTS delivery_bots (
  id BIGSERIAL PRIMARY PRIMARY KEY,
  telegram_bot_id BIGINT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'backup' CHECK (role IN ('primary', 'backup')),
  priority INTEGER NOT NULL DEFAULT 100,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  runtime_status TEXT NOT NULL DEFAULT 'offline' CHECK (runtime_status IN ('running', 'paused', 'offline', 'starting', 'stopping', 'error')),
  last_health_at TIMESTAMPTZ,
  last_error TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_bots_single_primary_idx
ON delivery_bots (role) WHERE role = 'primary' AND is_enabled = TRUE;
CREATE INDEX IF NOT EXISTS delivery_bots_runtime_idx ON delivery_bots (is_enabled, runtime_status, priority);
