-- Upgrade existing creator broadcast recipient tables to support atomic claiming.
ALTER TABLE creator_broadcast_recipients
  DROP CONSTRAINT IF EXISTS creator_broadcast_recipients_status_check;
ALTER TABLE creator_broadcast_recipients
  ADD CONSTRAINT creator_broadcast_recipients_status_check
  CHECK (status IN ('pending','sending','sent','failed','skipped'));
