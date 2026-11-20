-- Enforce duplicate media detection during concurrent ingestion.
CREATE UNIQUE INDEX IF NOT EXISTS files_active_unique_id_idx
ON files (telegram_file_unique_id)
WHERE telegram_file_unique_id IS NOT NULL AND status = 'active';
