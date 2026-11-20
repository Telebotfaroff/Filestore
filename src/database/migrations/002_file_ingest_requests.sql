CREATE TABLE IF NOT EXISTS file_ingest_requests (
  id BIGSERIAL PRIMARY KEY,
  source_chat_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'duplicate', 'failed')),
  file_id BIGINT REFERENCES files(id) ON DELETE SET NULL,
  storage_channel_id BIGINT REFERENCES storage_channels(id) ON DELETE SET NULL,
  stored_message_id BIGINT,
  processing_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_chat_id, source_message_id)
);
CREATE INDEX IF NOT EXISTS file_ingest_requests_status_idx ON file_ingest_requests (status, processing_until);
