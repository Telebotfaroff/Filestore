# FileStore Technical Guide

FileStore is a self-hosted Telegram file indexing and delivery platform. It uses a private Telegram storage channel as the file backend, PostgreSQL as its durable source of truth, a Main Bot as the admin control plane, and one or more Delivery Bots for end-user delivery.

## 1. Architecture

- **Main Bot:** administrator-only control plane for ingest, indexing, storage-channel configuration, access rules, Premium, payment administration, and monitoring.
- **Storage channel(s):** private Telegram channel(s) where media messages are stored. FileStore tracks message references and metadata in PostgreSQL; it does not copy media to local disk as its permanent storage.
- **Delivery Bots:** separately configured Telegram Bot API bots that send indexed files to users. Bot tokens managed by FileStore are encrypted in the database.
- **PostgreSQL:** users, files, storage channels, delivery bot configuration, delivery jobs, access grants, Premium, checkpoint sessions, payment records, and auto-delete jobs.
- **Workers:** persisted queue processing, checkpoint session cleanup, auto-delete scheduling, and payment fulfillment recovery.

## 2. Requirements

- Node.js 22 or newer
- PostgreSQL database
- Telegram bot token for the Main Bot (created using BotFather)
- At least one Telegram numeric administrator ID
- A private Telegram storage channel and a bot with the permissions required to post and read its stored messages
- Optional Delivery Bot token for initial administrator testing

Managed bot tokens and payment secrets require the encryption key. Generate a 32-byte key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 3. Install and run

Clone the repository and enter it:

```bash
git clone https://github.com/Telebotfaroff/Filestore.git
cd Filestore
```

Install dependencies:

```bash
npm install
```

Create the environment file from the template:

```bash
cp .env.example .env
```

Set the required values in `.env` (see Environment variables). Run migrations, checks, tests, then start:

```bash
npm run migrate
npm run check
npm test
npm start
```

For development with automatic Node restart:

```bash
npm run dev
```

## 4. Environment variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | No | `development`, `test`, or `production`; default `development` |
| `LOG_LEVEL` | No | Pino log level; default `info` |
| `MAIN_BOT_TOKEN` | Yes | Telegram Bot API token for the Main Bot |
| `DELIVERY_BOT_TOKEN` | No | Optional bootstrap Delivery Bot token |
| `DATABASE_URL` | Yes | PostgreSQL connection URL |
| `TOKEN_ENCRYPTION_KEY` | Conditional | Base64-encoded 32-byte key used for encrypted bot/payment secrets |
| `ADMIN_IDS` | Yes | Comma-separated numeric Telegram user IDs; at least one required |

Keep secrets in the host's environment/secrets panel. Never commit `.env`, tokens, encryption keys, or database credentials. Encryption keys must be backed up securely: losing the key can make encrypted tokens/secrets unrecoverable.

## 5. Initial Telegram configuration

1. Create the Main Bot through BotFather and copy its token.
2. Obtain your numeric Telegram user ID and add it to `ADMIN_IDS`.
3. Create a private storage channel. Add the Main Bot with the required channel permissions.
4. Start the Main Bot and use `/storage_add` to register the storage channel. Run `/storage_test` and enable it; designate a primary channel.
5. Send supported media to the Main Bot in a private chat to ingest and index it.
6. Add and test Delivery Bots from the admin commands when you are ready to use public retrieval.

The Main Bot is admin-only. Non-admin users cannot use its control-plane commands.

## 6. File ingestion and retrieval

Supported media types include video, document, photo, audio, voice, video note, and animation.

Send supported media to the Main Bot in a private chat. The ingestion handler stores the media message in a configured storage channel and indexes its Telegram message reference, metadata, and generated file code. Search by code or filename with `/find`; use `/fileinfo` to inspect a record.

Delivery Bot `/get FILE_CODE` queues a delivery. Delivery is processed through the persistent queue, with delivery attempts recorded. Delivery Bot runtime configuration includes primary/backup roles and priority; only the primary normally claims work, while backups are available for runtime failover.

## 7. Storage-channel administration

- `/storage` — show configured storage channels
- `/storage_add CHANNEL_ID_OR_USERNAME` — register a channel
- `/storage_test CHANNEL_ID` — test channel access/permissions
- `/storage_enable CHANNEL_ID` / `/storage_disable CHANNEL_ID` — enable or disable
- `/storage_primary CHANNEL_ID` — designate primary storage
- `/storage_remove CHANNEL_ID` — remove or safely disable

Keep storage channels private and ensure FileStore's bots have the required channel permissions.

## 8. Delivery Bot management

- `/delivery_bots` — list managed bots
- `/delivery_jobs` — list the 10 most recent jobs and delivery item counts
- `/delivery_retry <job_id>` — safely requeue failed items from a failed job; uncertain outcomes are never blindly retried
- `/delivery_bot_add TOKEN` — register a bot token (stored encrypted)
- `/delivery_bot_pause ID` / `/delivery_bot_resume ID` — pause/resume runtime
- `/delivery_bot_restart ID` — restart
- `/delivery_bot_remove ID` — remove runtime
- `/delivery_bot_primary ID` — select primary
- `/delivery_bot_priority ID PRIORITY` — set priority (1–100000)
- `/delivery_bot_test ID` — test bot/storage access

Configure the delivery bot with BotFather and add it to the storage channel as required. Use the permission test before making a bot primary.

## 9. Access control

Delivery access is checked centrally.

1. Force-subscription membership is checked first when configured.
2. Paid-file deliveries require an active entitlement for the requested file.
3. Premium members bypass the free checkpoint requirement.
4. Free-file and batch requests follow checkpoint policy.
5. If checkpoints are enabled but no trusted provider verifier is available, FileStore fails closed rather than granting access.

Commands:
- `/force_sub`, `/force_sub_add CHANNEL JOIN_URL`, `/force_sub_test CHANNEL`
- `/force_sub_enable CHANNEL`, `/force_sub_disable CHANNEL`, `/force_sub_remove CHANNEL`
- `/force_sub_global_on`, `/force_sub_global_off`
- `/checkpoint_global_on`, `/checkpoint_global_off`
- `/checkpoint_status`, `/access_status`

Force-sub channels can be enabled individually; global force-sub policy controls whether membership checks are enforced. Membership or Telegram API errors are treated conservatively.

## 10. URL checkpoint / shortener system

The provider manager stores HTTPS provider configuration, encrypted API keys, checkpoint duration, priority, and provider settings. Checkpoint sessions have hashed verification tokens and expiry cleanup; provider rotation and user checkpoint state are persisted.

**Important current limitation:** real provider request adapters and trusted completion verification have not been connected. `/shortener_test` validates configuration only; it does not contact a provider. Providers cannot be enabled through the supported admin flow until a trusted verification adapter is implemented and tested. Do not enable checkpoint enforcement expecting an unavailable verifier to grant access; it intentionally fails closed.

Commands:
- `/shorteners`
- `/shortener_add name|base_url|api_endpoint|api_key|checkpoint_minutes|priority|api_key_param|target_url_param|response_url_path|json_or_text|verification_mode`
- `/shortener_test ID`, `/shortener_duration ID MINUTES`, `/shortener_priority ID PRIORITY`
- `/shortener_enable ID`, `/shortener_disable ID`, `/shortener_remove ID`

## 11. Premium memberships

Plans are configurable in the Main Bot. Prices are entered in major currency units and stored in minor units. Memberships can be granted, extended, revoked, and inspected. Renewals extend an active membership; permanent memberships are not shortened by a finite renewal.

- `/plans`
- `/plan_add NAME|PRICE|CURRENCY|DURATION_DAYS`
- `/plan_edit ID|NAME|PRICE|CURRENCY|DURATION_DAYS|ENABLED`
- `/plan_remove ID`
- `/premium_grant USER_ID PLAN_ID [DAYS_OVERRIDE]`
- `/premium_revoke USER_ID`
- `/premium_status USER_ID`

Premium bypasses free checkpoints, but it does not unlock paid files by itself.

## 12. Payments

Payment methods have an adapter-based foundation. Telegram Stars checkout is implemented for configured Premium, paid-file, and paid-batch price maps. Payment verification, session matching, receipt idempotency, fulfillment, and recovery are designed to avoid duplicate grants.

Stars setup (example price map; IDs are database plan/link/batch IDs and amounts are in Stars):

```
/payment_set telegram_stars||{"stars_prices":{"premium":{"1":120},"paid_file":{"2":25},"paid_batch":{"1":150}}}
/payment_enable telegram_stars
```

- `/payment_sessions_expired` — inspect recent expired checkout sessions\n- `/payment_transactions [status]` — list recent transaction records (status filter optional)
- `/payment_methods` — list methods
- `/payment_set METHOD|SECRET|PUBLIC_CONFIG_JSON` — store method config; secrets are encrypted and command is deleted where possible
- `/payment_test METHOD` — config validation only, not a live transaction test
- `/payment_enable METHOD`, `/payment_disable METHOD`
- `/payments`, `/payment_recent`, `/payment_search QUERY`, `/payment_detail ID`, `/payment_analytics`
- `/payment_apply` and `/payment_reconcile ID` — retry/recover verified transaction fulfillment

Pending checkout sessions are automatically marked expired after their expiry time; the worker processes bounded batches and leaves verified/applied sessions untouched. `/payment_sessions_expired` lists the latest 20 expired sessions.\n\nTelegram Stars can be enabled with valid price maps. FamPay/UPI, Stripe, and crypto adapters are not connected; do not enable them or treat their configuration tests as live payment verification.

## 13. Paid file links

Create an individual paid link:

```
/paid_link_create FILE_CODE|PRICE|CURRENCY|EXPIRY_DAYS
```

Admin controls:
- `/paid_links`, `/paid_requests`
- `/paid_link_disable CODE`
- `/paid_confirm CODE USER_ID` — manual payment verification and entitlement grant

User flow:
- `/paid CODE` requests purchase. Since non-Stars gateways are not connected, the purchase may require manual administrator verification.
- After entitlement is granted, user delivery is subject to force-sub checks and normal delivery runtime.

Codes are randomly generated and stored through hashed lookup. Expiry is optional and purchase requests are tracked.

## 14. Paid batch links

Create a collection with 2–100 unique file codes:

```
/batch_link_create TITLE|CODE1,CODE2,...|PRICE|CURRENCY|EXPIRY_DAYS
```

Admin:
- `/batch_links`, `/batch_requests`
- `/batch_link_disable CODE`
- `/batch_confirm CODE USER_ID` — manually verify payment and grant entitlements for batch files

User:
- `/batch CODE` — request access
- `/batch_get CODE` — enqueue entitled files sequentially

Batch purchase records are unique per batch/user. The batch's file membership is recorded for purchase and entitlement handling. Automated payment for non-Stars gateways is not available.

## 15. Auto-delete

- `/auto_delete` — show current setting
- `/auto_delete MINUTES` — set auto-delete for newly delivered messages (1–10080 minutes)
- `/auto_delete_failed` — inspect terminal auto-delete failures\n- `/auto_delete_off` — disable scheduling for future deliveries

Delete tasks are persisted. The countdown starts after successful delivery. Existing scheduled deletions continue after the setting is disabled. Bots delete only their own sent messages. Deletion workers use owner-checked leases to prevent stale workers overwriting a newer claim. Failures retry with exponential delay from 30 seconds up to one hour and stop after five attempts. `/auto_delete_failed` lists terminal failures for diagnosis.

## 16. Monitoring and payment operations

- `/status` — basic bot/database/user/file/payment status
- `/dashboard` or `/stats` — overview of activity, files, channels, delivery bots, queue, Premium, paid links, pending purchase requests, payment totals, and recent activity
- `/payments` — payment/session/provider event summary
- `/payment_recent` — paginated transaction browser
- `/payment_detail ID` — transaction detail
- `/payment_search QUERY` — search by transaction ID, Telegram user ID, UTR, or external reference
- `/payment_analytics` — 30-day revenue, outcomes, method breakdown, daily revenue, membership trends, and paying-user stats
- `/payment_reconcile ID` — retry safe fulfillment of verified transaction

## 17. Database migrations

Migration files live in `src/database/migrations` and are applied in order using `npm run migrate`. The migration runner uses a PostgreSQL advisory lock and records migration version and checksum in `schema_migrations`. Applied migration files must not be edited; create a new migration for schema changes. Migrations are applied transactionally per file.

Back up PostgreSQL before applying production schema changes.

## 18. Testing and CI

```bash
npm run check
npm test
```

The GitHub Actions workflow runs syntax checks and unit tests on pushes and pull requests. Unit tests use Node's built-in test runner. Live Telegram and database integration tests still require separately configured credentials/services and should not be claimed as covered by the local unit suite.

## 19. Deployment notes

Run FileStore on a Node.js 22+ host that supports a long-running process and outbound HTTPS. Configure environment variables through the host's secret/environment settings, install dependencies, run migrations, then start the service. Use a managed PostgreSQL service and persistent hosting for the bot process. Avoid ephemeral runtimes that stop long-running polling workers.

For safe upgrades:
1. Read release/commit notes.
2. Back up PostgreSQL.
3. Deploy compatible code.
4. Run migrations.
5. Verify `/status`, `/dashboard`, storage permission tests, and delivery bot status.

## 20. Troubleshooting

| Symptom | Check |
|---|---|
| Startup says config invalid | Verify required env vars, numeric `ADMIN_IDS`, and allowed `NODE_ENV`/`LOG_LEVEL` values |
| Startup says migrations missing | Run `npm run migrate` against the configured database |
| Storage permission test fails | Confirm bots are added to the private channel with appropriate permissions |
| Delivery bot won't start | Check token validity, bot record status, and runtime logs; run permission test |
| User cannot receive free file | Check force-sub, access status, checkpoint setting, active provider/verifier availability, queue status |
| Paid file denied | Confirm purchase was verified and entitlement exists; inspect payment detail/reconcile if applicable |
| Auto-delete didn't occur | Check schedule state, delivery bot availability, task attempts, and whether bot sent the message |
| Checkpoint cannot be enabled | Provider-specific trusted verification is not yet integrated |
| FamPay/Stripe/crypto checkout unavailable | These adapters are not implemented; Telegram Stars is the current supported checkout |

## 21. Security and recovery principles

- Treat Telegram bot tokens, PostgreSQL credentials, provider API keys, and encryption keys as secrets.
- Use administrator ID allowlisting; do not expose Main Bot admin functions in public groups.
- Keep storage channels private.
- Encrypted tokens/secrets rely on the encryption key; back it up separately and securely.
- Payment confirmations must be independently verified before using manual confirmation commands.
- Do not edit already-applied SQL migration files.
- FileStore uses fail-closed access checks: uncertain subscription/checkpoint/payment verification should not grant access.
- Back up database and encryption key independently and test recovery procedures.
