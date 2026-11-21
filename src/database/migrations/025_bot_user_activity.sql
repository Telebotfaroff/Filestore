-- Dashboard user activity scoped to individual delivery bots.
CREATE TABLE IF NOT EXISTS delivery_bot_user_activity (
  delivery_bot_id BIGINT NOT NULL REFERENCES delivery_bots(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  interaction_count BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (delivery_bot_id, telegram_user_id)
);
CREATE INDEX IF NOT EXISTS delivery_bot_user_activity_user_idx
  ON delivery_bot_user_activity (telegram_user_id, last_seen_at DESC);
