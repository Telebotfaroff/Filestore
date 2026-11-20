-- M20/M21: link checkout sessions to paid batches and allow verified batch payments.
ALTER TABLE payment_sessions DROP CONSTRAINT IF EXISTS payment_sessions_purpose_check;
ALTER TABLE payment_sessions ADD CONSTRAINT payment_sessions_purpose_check CHECK (purpose IN ('premium', 'paid_file', 'paid_batch'));
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_purpose_check;
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_purpose_check CHECK (purpose IN ('premium', 'paid_file', 'paid_batch'));
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS batch_link_id BIGINT REFERENCES paid_batch_links(id) ON DELETE SET NULL;
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS batch_link_id BIGINT REFERENCES paid_batch_links(id) ON DELETE SET NULL;
