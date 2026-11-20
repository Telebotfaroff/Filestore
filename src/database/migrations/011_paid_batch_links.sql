CREATE TABLE IF NOT EXISTS paid_batch_links (
  id BIGSERIAL PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  public_code_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  price_minor BIGINT NOT NULL CHECK (price_minor > 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS paid_batch_items (
  batch_link_id BIGINT NOT NULL REFERENCES paid_batch_links(id) ON DELETE RESTRICT,
  file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  PRIMARY KEY (batch_link_id, file_id),
  UNIQUE (batch_link_id, position)
);
CREATE INDEX IF NOT EXISTS paid_batch_items_order_idx ON paid_batch_items(batch_link_id, position);
CREATE TABLE IF NOT EXISTS paid_batch_purchases (
  id BIGSERIAL PRIMARY KEY,
  batch_link_id BIGINT NOT NULL REFERENCES paid_batch_links(id) ON DELETE RESTRICT,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'delivered', 'refunded', 'cancelled')),
  paid_amount_minor BIGINT NOT NULL CHECK (paid_amount_minor >= 0),
  currency TEXT NOT NULL,
  payment_transaction_id BIGINT REFERENCES payment_transactions(id) ON DELETE SET NULL,
  payment_method TEXT REFERENCES payment_methods(method) ON DELETE SET NULL,
  verified_by BIGINT,
  verified_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_link_id, user_telegram_id)
);
CREATE INDEX IF NOT EXISTS paid_batch_purchases_status_idx ON paid_batch_purchases(status, created_at DESC);
