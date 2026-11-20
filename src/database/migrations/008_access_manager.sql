CREATE TABLE IF NOT EXISTS premium_plans (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 3650),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS premium_memberships (
  id BIGSERIAL PRIMARY KEY,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  plan_id BIGINT REFERENCES premium_plans(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'manual',
  granted_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS premium_memberships_user_active_idx ON premium_memberships (user_telegram_id, status, expires_at DESC);
CREATE TABLE IF NOT EXISTS access_grants (
  id BIGSERIAL PRIMARY KEY,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'batch')),
  resource_id BIGINT NOT NULL,
  grant_reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_telegram_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS access_grants_user_resource_idx ON access_grants (user_telegram_id, resource_type, resource_id, expires_at);
INSERT INTO app_settings (key, value) VALUES ('checkpoint_enabled', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;
