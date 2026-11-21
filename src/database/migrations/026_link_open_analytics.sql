CREATE TABLE IF NOT EXISTS link_open_events (
  id BIGSERIAL PRIMARY KEY,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('share','paid_file','paid_batch')),
  link_id BIGINT NOT NULL,
  viewer_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  delivery_bot_id BIGINT REFERENCES delivery_bots(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS link_open_events_link_idx ON link_open_events (link_kind, link_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS link_open_events_viewer_idx ON link_open_events (viewer_telegram_id, opened_at DESC);
