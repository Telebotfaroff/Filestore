ALTER TABLE scheduled_message_deletions
  ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;
