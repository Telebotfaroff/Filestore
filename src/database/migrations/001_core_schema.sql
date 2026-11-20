-- FileStore core schema (initial foundation)
-- All timestamps are stored as timestamptz. Do not edit applied migrations; add a new migration.

CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_premium_telegram BOOLEAN NOT NULL DEFAULT FALSE,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS users_username_idx ON users (username);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS storage_channels (
  id BIGSERIAL PRIMARY PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL UNIQUE,
  title TEXT,
  username TEXT,
  channel_type TEXT NOT NULL DEFAULT 'channel' CHECK (channel_type IN ('channel', 'group')),
  role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'backup')),
  priority INTEGER NOT NULL DEFAULT 100,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  verified_at TIMESTAMPTZ,
  last_test_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_test_status IN ('unknown', 'ok', 'failed')),
  last_test_error TEXT,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS storage_channels_enabled_priority_idx ON storage_channels (is_enabled, priority);

CREATE TABLE IF NOT EXISTS files (
  id BIGSERIAL PRIMARY PRIMARY KEY,
  file_code TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('video', 'document', 'photo', 'audio', 'voice', 'video_note', 'animation', 'archive', 'other')),
  mime_type TEXT,
  file_size BIGINT CHECK (file_size IS NULL OR file_size >= 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  width INTEGER CHECK (width IS NULL OR width >= 0),
  height INTEGER CHECK (height IS NULL OR height >= 0),
  caption TEXT,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  uploaded_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS files_created_at_idx ON files (created_at DESC);
CREATE INDEX IF NOT EXISTS files_name_idx ON files (file_name);
CREATE INDEX IF NOT EXISTS files_type_idx ON files (file_type);
CREATE INDEX IF NOT EXISTS files_unique_id_idx ON files (telegram_file_unique_id);

CREATE TABLE IF NOT EXISTS storage_messages (
  id BIGSERIAL PRIMARY PRIMARY KEY,
  file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  storage_channel_id BIGINT NOT NULL REFERENCES storage_channels(id) ON DELETE RESTRICT,
  telegram_message_id BIGINT NOT NULL,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (storage_channel_id, telegram_message_id)
);
CREATE INDEX IF NOT EXISTS storage_messages_file_idx ON storage_messages (file_id);

CREATE TABLE IF NOT EXISTS tags (
  id BIGSERIAL PRIMARY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS file_tags (
  file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (file_id, tag_id)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGSERIAL PRIMARY PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_telegram_id BIGINT,
  target_telegram_id BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activity_logs_type_time_idx ON activity_logs (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_logs_target_time_idx ON activity_logs (target_telegram_id, created_at DESC);
