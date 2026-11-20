CREATE TABLE IF NOT EXISTS force_sub_channels (
  id BIGSERIAL PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL UNIQUE,
  title TEXT,
  username TEXT,
  join_url TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_test_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_test_status IN ('unknown', 'ok', 'failed')),
  last_test_error TEXT,
  added_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS force_sub_channels_enabled_idx ON force_sub_channels (is_enabled);
