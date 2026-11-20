# FileStore

A modular Telegram file indexing and delivery platform built with Node.js, Telegraf, and PostgreSQL.

## Progress

- **Milestones 1–5:** foundation, configuration, migrations, Main Bot, and storage-channel manager.
- **Milestone 6:** media ingestion, metadata, file codes, duplicate detection, and file search.
- **Milestone 7:** persistent single-file delivery queue, delivery attempts, and cautious crash recovery.
- **Milestone 8:** dynamic Delivery Bot manager with encrypted tokens, primary/backup roles, priority, pause/resume/restart/remove, permission tests, and health-based failover.
- **Milestone 9:** force-subscription manager, channel controls, user registration, join/verify buttons, and fail-closed checks.
- **Milestone 10:** shortener provider configuration, encrypted API-key storage, provider priority/duration settings, checkpoint session engine, token hashing, expiration cleanup worker, and sequential rotation logic. Providers remain disabled until a real provider verification adapter is implemented.
- **Milestone 11:** centralized Access Manager, premium-membership schema, paid-file entitlements, force-subscription-first decisions, premium bypass for free checkpoints, and tests. Access Manager is wired into public `/get` and access status commands.
- **Milestone 12:** Premium plan CRUD, manual grant/extend/revoke/status controls, payment method configuration, encrypted payment secrets, and payment transaction/session foundations. Telegram Stars checkout is implemented and can be enabled; FamPay/UPI, Stripe, and crypto adapters remain pending.
- **Milestone 13:** paid single-file link creation, random public codes with hashed lookup, optional expiry, purchase-request records, manual admin verification, entitlement grants, force-sub-first user requests, and paid-only delivery gating. Automatic payment is pending gateway integrations.
- **Milestone 14:** paid multi-file batch links (2–100 unique files), ordered items, manual payment confirmation, entitlements, and sequential delivery.
- **Milestone 15:** configurable persistent auto-delete for delivered messages, retrying deletion worker, and admin controls.
- **Milestone 16:** centralized Access Manager wired into public `/get`; free delivery works when force-sub and checkpoint/premium rules allow, while paid entitlements are honored.
- **Milestone 17:** user `/checkpoint_status` and `/access_status` commands, clearer blocked-state messaging, and safe fail-closed verification. Real shortener verification adapters remain unimplemented.
- **Milestone 18:** Main Bot `/dashboard` and `/stats` overview for users, files, storage, bots, queue, Premium, paid links, pending purchases, applied payment totals, and activity.\n- **Milestone 19:** payment-session validation, session-to-transaction matching, idempotent provider-event receipts, duplicate transaction protection, and fail-closed payment recording. Provider checkout/webhooks and gateway signatures are not connected yet.\n- **Milestones 20–21 (fulfillment foundation):** transaction-safe automatic Premium activation, exact paid-link purchase fulfillment, paid-batch fulfillment with per-file access grants, transaction/session state updates, activity logs, and admin `/payment_apply` recovery.
- **Milestone 22 (Telegram Stars):** Stars invoice checkout for Premium plans, paid single files, and paid batches; pre-checkout session/user/amount validation; signed invoice payloads; successful-payment charge checks; idempotent provider event receipts; immediate fulfillment; and an automatic recovery worker that retries verified-but-unapplied transactions. FamPay, Stripe, and crypto adapters remain unconnected.
- **Milestone 23 (delivery recovery):** delivery lease heartbeat and ownership-checked completion/failure writes, recent-job inspection (`/delivery_jobs`), and safe retry of failed jobs (`/delivery_retry`) that preserves delivered batch items and blocks uncertain outcomes.

Live Telegram and PostgreSQL integration testing is pending configured credentials. Public `/get` is wired to the Access Manager. Free delivery is allowed when checkpoints are disabled or a valid Premium/checkpoint state permits it; when checkpoint enforcement requires an unverified provider, requests remain blocked.

## Stack

- Node.js 22+ / ES Modules
- Telegraf (Telegram Bot API)
- PostgreSQL (Neon-compatible)
- pg, Zod, dotenv, Pino

## Setup

1. Install Node.js 22+ and clone this repository.
2. Copy `.env.example` to `.env`.
3. Set `MAIN_BOT_TOKEN`, `DATABASE_URL`, and at least one numeric `ADMIN_IDS`.
4. Optionally set `DELIVERY_BOT_TOKEN` to bootstrap a Delivery Bot.
5. Generate a 32-byte base64 `TOKEN_ENCRYPTION_KEY` locally (required for managed bot tokens).
6. Install dependencies: `npm install`.
7. Apply migrations: `npm run migrate`.
8. Start FileStore: `npm start`.

## Documentation

- [Complete technical guide](FILESTORE_GUIDE.md)
- [Main Bot command reference](docs/commands.md)

## AI coding rules

See [AGENTS.md](AGENTS.md). The complete roadmap is authorized and is being implemented sequentially, not in a single oversized change.

## Secrets

Never commit Telegram tokens, database URLs, encryption keys, or payment credentials. Use environment variables or host secret settings.

### Telegram Stars checkout setup (active)

1. In the Main Bot, configure Stars price maps using Telegram Stars amounts (not INR paise). The IDs are database IDs from `/plans`, `/paid_links`, and `/batch_links`:
   ```
   /payment_set telegram_stars||{"stars_prices":{"premium":{"1":120},"paid_file":{"2":25},"paid_batch":{"1":150}}}
   ```
2. Enable checkout:
   ```
   /payment_enable telegram_stars
   ```
3. Users can open `/premium`, pay a paid-file link with `/paid CODE`, or pay a batch link with `/batch CODE`. The invoice is issued in Telegram Stars (XTR).

Checkout payloads are HMAC-signed with the issuing bot token; pre-checkout validates the Telegram user, session, amount, currency, and expiry. Telegram successful-payment updates are checked against the saved session, recorded idempotently, then fulfilled. The recovery worker retries verified payments if fulfillment temporarily fails. The other gateway names (FamPay, Stripe, Crypto) remain disabled until their provider adapters are implemented.
