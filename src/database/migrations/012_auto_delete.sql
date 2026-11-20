CREATE TABLE IF NOT EXISTS delivery_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO delivery_settings (setting_key, setting_value)
VALUES ('auto_delete_minutes', '0')
ON CONFLICT (setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS scheduled_message_deletions (
  id BIGSERIAL PRIMARY KEY,
  delivery_bot_identity TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  delete_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'deleted', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_bot_identity, chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS scheduled_message_deletions_due_idx
ON scheduled_message_deletions(status, delete_at);
