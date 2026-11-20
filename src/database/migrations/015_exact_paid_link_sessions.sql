-- M20: checkout targets must identify exact paid-link records, not just the file.
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS paid_link_id BIGINT REFERENCES paid_file_links(id) ON DELETE SET NULL;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS paid_link_id BIGINT REFERENCES paid_file_links(id) ON DELETE SET NULL;
