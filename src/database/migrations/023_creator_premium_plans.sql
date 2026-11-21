-- Creator-scoped Premium membership plans and memberships.
-- Platform Owner plans & memberships keep owner_telegram_id IS NULL.
-- Public creators can define their own Premium plans; payments are collected via
-- Owner's configured gateways (FamPay UPI / Telegram Stars) and credited to the creator's wallet.

ALTER TABLE premium_plans
  ADD COLUMN IF NOT EXISTS owner_telegram_id BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL;

ALTER TABLE premium_plans
  DROP CONSTRAINT IF EXISTS premium_plans_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS premium_plans_owner_name_idx
  ON premium_plans (COALESCE(owner_telegram_id, 0), name);

CREATE INDEX IF NOT EXISTS premium_plans_owner_idx
  ON premium_plans (owner_telegram_id, id ASC);

ALTER TABLE premium_memberships
  ADD COLUMN IF NOT EXISTS owner_telegram_id BIGINT NULL REFERENCES users(telegram_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS premium_memberships_user_owner_active_idx
  ON premium_memberships (user_telegram_id, owner_telegram_id, status, expires_at DESC);
