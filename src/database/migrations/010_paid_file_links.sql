CREATE TABLE IF NOT EXISTS paid_file_links (
  id BIGSERIAL PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  public_code_hash TEXT NOT NULL UNIQUE,
  file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  price_minor BIGINT NOT NULL CHECK (price_minor > 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS paid_file_links_file_idx ON paid_file_links(file_id);
CREATE INDEX IF NOT EXISTS paid_file_links_enabled_idx ON paid_file_links(is_enabled, expires_at);

CREATE TABLE IF NOT EXISTS paid_file_purchases (
  id BIGSERIAL PRIMARY KEY,
  paid_link_id BIGINT NOT NULL REFERENCES paid_file_links(id) ON DELETE RESTRICT,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  payment_transaction_id BIGINT REFERENCES payment_transactions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'delivered', 'refunded', 'cancelled')),
  paid_amount_minor BIGINT NOT NULL CHECK (paid_amount_minor >= 0),
  currency TEXT NOT NULL,
  payment_method TEXT REFERENCES payment_methods(method) ON DELETE SET NULL,
  verified_by BIGINT,
  verified_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (paid_link_id, user_telegram_id)
);
CREATE INDEX IF NOT EXISTS paid_file_purchases_status_idx ON paid_file_purchases(status, created_at DESC);
