-- Public multi-tenant creator isolation, creator wallets, and manual UPI withdrawal workflow

-- 1. Scope files active unique ID index per uploader so two creators can index the same media independently
DROP INDEX IF EXISTS files_active_unique_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS files_active_uploader_unique_id_idx
  ON files (COALESCE(uploaded_by, 0), telegram_file_unique_id)
  WHERE telegram_file_unique_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS files_uploaded_by_idx
  ON files (uploaded_by, created_at DESC)
  WHERE status = 'active';

-- 2. Scope storage channels by owner (NULL = platform owner shared/admin channels)
ALTER TABLE storage_channels
  ADD COLUMN IF NOT EXISTS owner_telegram_id BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS storage_channels_owner_idx
  ON storage_channels (owner_telegram_id, priority ASC, id ASC);

-- 3. Scope delivery bots by owner (NULL = platform delivery bots) and target jobs to specific bot when set
ALTER TABLE delivery_bots
  ADD COLUMN IF NOT EXISTS owner_telegram_id BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL;
DROP INDEX IF EXISTS delivery_bots_single_primary_idx;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_bots_owner_primary_idx
  ON delivery_bots (COALESCE(owner_telegram_id, 0))
  WHERE role = 'primary' AND is_enabled = TRUE;
CREATE INDEX IF NOT EXISTS delivery_bots_owner_idx
  ON delivery_bots (owner_telegram_id, priority ASC, id ASC);

ALTER TABLE delivery_jobs
  ADD COLUMN IF NOT EXISTS delivery_bot_id BIGINT NULL REFERENCES delivery_bots(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS delivery_jobs_bot_status_idx
  ON delivery_jobs (status, delivery_bot_id, created_at);

-- 4. Scope force-subscription channels by owner (NULL = platform global channels)
ALTER TABLE force_sub_channels
  ADD COLUMN IF NOT EXISTS owner_telegram_id BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL;
ALTER TABLE force_sub_channels
  DROP CONSTRAINT IF EXISTS force_sub_channels_telegram_chat_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS force_sub_channels_owner_chat_idx
  ON force_sub_channels (COALESCE(owner_telegram_id, 0), telegram_chat_id);
CREATE INDEX IF NOT EXISTS force_sub_channels_owner_idx
  ON force_sub_channels (owner_telegram_id, id ASC);

-- 5. Scope shortener providers by owner (NULL = platform global shorteners)
ALTER TABLE shortener_providers
  ADD COLUMN IF NOT EXISTS owner_telegram_id BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL;
ALTER TABLE shortener_providers
  DROP CONSTRAINT IF EXISTS shortener_providers_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS shortener_providers_owner_name_idx
  ON shortener_providers (COALESCE(owner_telegram_id, 0), name);
CREATE INDEX IF NOT EXISTS shortener_providers_owner_idx
  ON shortener_providers (owner_telegram_id, priority ASC, id ASC);

-- 6. Per-creator settings (toggles default FALSE for public creators, plus saved payout UPI ID)
CREATE TABLE IF NOT EXISTS user_creator_settings (
  user_telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  checkpoint_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  force_sub_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  payout_upi_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Per-creator checkpoint unlock state so one creator's shortener unlock does not bypass another's
CREATE TABLE IF NOT EXISTS creator_checkpoint_states (
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  owner_telegram_id BIGINT NOT NULL,
  last_provider_id BIGINT NULL REFERENCES shortener_providers(id) ON DELETE SET NULL,
  checkpoint_expires_at TIMESTAMPTZ,
  completed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_telegram_id, owner_telegram_id)
);

-- 8. Creator wallets, immutable ledger, and manual UPI withdrawal requests
CREATE TABLE IF NOT EXISTS creator_wallets (
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'INR',
  available_minor BIGINT NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  locked_minor BIGINT NOT NULL DEFAULT 0 CHECK (locked_minor >= 0),
  total_earned_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_earned_minor >= 0),
  total_withdrawn_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_withdrawn_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_telegram_id, currency)
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id BIGSERIAL PRIMARY KEY,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'INR',
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  upi_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'rejected', 'cancelled')),
  payout_reference TEXT,
  admin_note TEXT,
  processed_by BIGINT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS withdrawal_requests_status_idx
  ON withdrawal_requests (status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS withdrawal_requests_user_idx
  ON withdrawal_requests (user_telegram_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'INR',
  entry_type TEXT NOT NULL CHECK (entry_type IN ('sale_credit', 'withdrawal_hold', 'withdrawal_paid', 'withdrawal_refund')),
  amount_minor BIGINT NOT NULL,
  balance_after_minor BIGINT NOT NULL,
  payment_transaction_id BIGINT NULL REFERENCES payment_transactions(id) ON DELETE SET NULL,
  withdrawal_request_id BIGINT NULL REFERENCES withdrawal_requests(id) ON DELETE SET NULL,
  reference_code TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_sale_tx_idx
  ON wallet_ledger (payment_transaction_id)
  WHERE entry_type = 'sale_credit' AND payment_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_ledger_user_created_idx
  ON wallet_ledger (user_telegram_id, created_at DESC, id DESC);
