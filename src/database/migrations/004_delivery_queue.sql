CREATE TABLE IF NOT EXISTS delivery_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL DEFAULT 'single' CHECK (job_type IN ('single', 'batch')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'uncertain', 'cancelled')),
  requester_telegram_id BIGINT NOT NULL,
  requested_by BIGINT,
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS delivery_jobs_queue_idx ON delivery_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS delivery_items (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES delivery_jobs(id) ON DELETE CASCADE,
  file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'uncertain')),
  delivered_to BIGINT,
  telegram_message_id BIGINT,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, position)
);
CREATE INDEX IF NOT EXISTS delivery_items_job_status_idx ON delivery_items (job_id, status);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id BIGSERIAL PRIMARY KEY,
  delivery_item_id BIGINT NOT NULL REFERENCES delivery_items(id) ON DELETE CASCADE,
  delivery_bot_identity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'delivered', 'failed', 'uncertain')),
  telegram_message_id BIGINT,
  error_code TEXT,
  error_description TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS delivery_attempts_item_idx ON delivery_attempts (delivery_item_id, started_at DESC);
