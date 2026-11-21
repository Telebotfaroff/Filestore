-- Creator-scoped broadcast queue and recipient snapshots.
CREATE TABLE IF NOT EXISTS creator_broadcasts (
  id BIGSERIAL PRIMARY KEY,
  owner_telegram_id BIGINT NOT NULL,
  delivery_bot_id BIGINT NOT NULL REFERENCES delivery_bots(id) ON DELETE CASCADE,
  created_by BIGINT NOT NULL,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paused','completed','cancelled','failed')),
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  cursor_user_id BIGINT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS creator_broadcasts_queue_idx ON creator_broadcasts(status,created_at) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS creator_broadcasts_owner_idx ON creator_broadcasts(owner_telegram_id,created_at DESC);
CREATE TABLE IF NOT EXISTS creator_broadcast_recipients (
  broadcast_id BIGINT NOT NULL REFERENCES creator_broadcasts(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  sent_at TIMESTAMPTZ,
  PRIMARY KEY(broadcast_id,telegram_user_id)
);
CREATE INDEX IF NOT EXISTS creator_broadcast_recipients_pending_idx ON creator_broadcast_recipients(broadcast_id,telegram_user_id) WHERE status='pending';
