ALTER TABLE scheduled_message_deletions
  ADD COLUMN IF NOT EXISTS locked_by TEXT;
