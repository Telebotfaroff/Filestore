# FileStore Main Bot Commands

All Main Bot commands are restricted to administrator Telegram IDs configured in `ADMIN_IDS`.

## Main Bot

- `/start` — Control Center.
- `/help` — Command list.
- `/status` — DB connection, tracked users, indexed files.

## File ingestion and search

Send supported media (video, document, photo, audio, voice, video note, or animation) in private chat with the Main Bot.

- `/files` — Latest indexed files.
- `/find <filename or file code>` — Search.
- `/fileinfo <file_code>` — Metadata and storage references.

## Storage channels

- `/storage` — List channels.
- `/storage_add <channel_id or @username>` — Add and validate channel permissions.
- `/storage_test <channel_id>` — Retest permissions.
- `/storage_enable <channel_id>` / `/storage_disable <channel_id>` — Toggle.
- `/storage_primary <channel_id>` — Set primary.
- `/storage_remove <channel_id>` — Remove or safely disable.

## Dynamic Delivery Bots

- `/delivery_bots` — List bot runtimes.
- `/delivery_jobs` — Show the 10 most recent jobs, item counts, and failed/uncertain states.
- `/delivery_retry <job_id>` — Requeue failed items in a failed job; uncertain jobs/items are blocked to prevent duplicate sends.
- `/delivery_bot_add <token>` — Add a bot; token is encrypted.
- `/delivery_bot_pause <record_id>`, `/delivery_bot_resume <record_id>`
- `/delivery_bot_restart <record_id>`
- `/delivery_bot_remove <record_id>`
- `/delivery_bot_primary <record_id>`
- `/delivery_bot_priority <record_id> <1-100000>`
- `/delivery_bot_test <record_id>` — Bot/channel permissions.

Only the primary Delivery Bot claims queue jobs; backups stay available for failover.

## Delivery Bot (admin test mode)

- `/get <file_code>` — Admin test delivery.
- `/delivery_status` — Queue status.
- `/delivery_test` — Storage and force-sub permissions.

## User access status

- `/checkpoint_status` — Shows whether a checkpoint is active, required, or unavailable.
- `/access_status` — Shows force-sub, Premium, and checkpoint state.
- `/get <file_code>` — Public delivery now passes through the Access Manager. Free delivery is allowed when checkpoints are off or access is otherwise granted; paid files still require entitlement. Force-sub is checked first.

Provider verification is intentionally fail-closed: checkpoint-enabled users cannot bypass verification when no trusted provider adapter is connected.

Public file delivery is now governed by the Access Manager; admins retain test-mode access.

## Force-subscription

- `/force_sub` — List channels and global state.
- `/force_sub_add <channel_id or @username> <https_join_link>` — Add channel.
- `/force_sub_test <channel_id>` — Test Main Bot admin permissions.
- `/force_sub_enable <channel_id>`, `/force_sub_disable <channel_id>`
- `/force_sub_remove <channel_id>`
- `/force_sub_global_on`, `/force_sub_global_off`

Delivery Bots check membership before user requests. Verification errors fail closed.

## URL shortener manager

- `/shorteners` — List providers.
- `/shortener_add name|base_url|api_endpoint|api_key|checkpoint_minutes|priority|api_key_param|target_url_param|response_url_path|json_or_text|verification_mode` — Add or update provider configuration. API keys are encrypted.
- `/shortener_test <provider_id>` — Validate config only (does not call provider).
- `/shortener_duration <provider_id> <minutes>` — 1–10080 minutes.
- `/shortener_priority <provider_id> <priority>`
- `/shortener_enable <provider_id>` — Currently blocked until a trusted provider verifier is integrated.
- `/shortener_disable <provider_id>`
- `/shortener_remove <provider_id>` — Cannot remove with pending sessions.

Sequential checkpoint state is implemented, including expiry and provider rotation. Actual provider API calls and server-side completion verification are not yet connected.

## Checkpoint policy

- `/checkpoint_global_on` — Enable checkpoint enforcement (requires enabled provider).
- `/checkpoint_global_off` — Disable checkpoint enforcement; force-sub still applies.

## Premium plan manager

Plan prices are entered in major currency units (example INR ₹99.00), stored as minor units.

- `/plans` — List plans.
- `/plan_add name|price|currency|duration_days` — Add or update a plan by name. Example: `/plan_add Monthly|99|INR|30`.
- `/plan_edit id|name|price|currency|duration_days|enabled` — Edit a plan.
- `/plan_remove <plan_id>` — Delete a plan; historical memberships retain their record but lose the plan reference.
- `/premium_grant <user_id> <plan_id> [days_override]` — Manually grant/extend membership.
- `/premium_revoke <user_id>` — Revoke current active membership.
- `/premium_status <user_id>` — Inspect membership history.

Concurrent grants to the same user are serialized in the database. Renewal extends an active membership rather than starting a second overlapping entitlement. Permanent Premium is not shortened or overwritten.

## Payment method setup

Four methods are reserved and seeded as disabled:

1. `fampay` — UPI payment flow
2. `telegram_stars` — Telegram Stars
3. `stripe`
4. `crypto`

- `/payment_methods` — List setup status.
- `/payment_set method|secret|public_config_json` — Save configuration; secret is encrypted and the command message is deleted when possible. Example: `/payment_set stripe|sk_test_...|{"publishable_key":"pk_test_..."}`.
- `/payment_test <method>` — Validate stored config only, not a live payment.
- `/payment_enable <method>` — Activation is blocked until checkout and server-side verification are implemented.
- `/payment_disable <method>`

Telegram Stars checkout is implemented and can be enabled when its price map is configured. FamPay/UPI, Stripe, and Crypto adapters are not connected. The `/payment_test` command validates configuration only; it is not a live gateway test.

## Paid file links

- `/paid_link_create FILE_CODE|PRICE|CURRENCY|expiry_days(optional)` — create a paid link, e.g. `/paid_link_create ABC123|149|INR|7`.
- `/paid_links` — list paid links and purchase request counts.
- `/paid_requests` — pending requests with user IDs and copy-ready confirmation commands.
- `/paid_link_disable <link_code>` — disable link.
- `/paid_confirm <link_code> <user_id>` — manually confirm payment after independently checking it; this grants access and sends the user a notification.

Users on Delivery Bots:
- `/paid <link_code>` — request a purchase. Force-sub is checked first. Payment gateways are not connected yet, so users are directed to the admin for manual verification.
- `/get <file_code>` — access is checked through the Access Manager. Free delivery follows checkpoint/Premium policy; paid files require entitlement and force-sub passes.

Paid links have random codes, hashed lookup values, optional expiry, purchase request tracking, and per-user uniqueness. Payment must not be marked verified automatically until a gateway verifier is integrated.


## Paid batch links

- `/batch_link_create TITLE|FILE_CODE1,FILE_CODE2,...|PRICE|CURRENCY|expiry_days(optional)` — create a paid collection with 2–100 unique files. Example: `/batch_link_create Summer Pack|A1B2,C3D4,E5F6|299|INR|30`.
- `/batch_links` — list batch links, file counts, purchases and expiry.
- `/batch_requests` — pending requests with user IDs and copy-ready confirmation commands.
- `/batch_link_disable <code>` — disable a batch link.
- `/batch_confirm <code> <user_id>` — manually verify payment and unlock all batch files.

Delivery Bot users:
- `/batch <code>` — request the batch purchase (force-sub checked first).
- `/batch_get <code>` — enqueue all entitled files as a single job; worker delivers sequentially.

Batch codes use random 80-bit codes and hashed lookups. Purchase records are unique per batch/user. Admin payment verification grants file-level entitlements for all items in the batch. Payment automation is not connected yet.


## Security

- Never commit Telegram tokens, API secrets, encryption keys, or database credentials.
- Managed Telegram tokens and payment secrets use AES-256-GCM encryption.
- `TOKEN_ENCRYPTION_KEY` is a base64-encoded 32-byte key.


## Delivery auto-delete

- `/auto_delete` — Show current setting.
- `/auto_delete <minutes>` — Enable auto-delete for newly delivered files (1–10080 minutes).
- `/auto_delete_off` — Disable auto-delete for future deliveries.

The timer starts after a delivery succeeds. Existing scheduled deletions remain scheduled when auto-delete is disabled. Delivery Bots delete only their own sent messages. Deletion jobs are persisted and retried; after five failed attempts they are marked failed.


## Main Bot Dashboard (M18)

- `/dashboard` — Summary of user activity, indexed files, storage channels, enabled Delivery Bots, delivery queue states, Premium memberships, paid links, pending purchase requests, applied payment totals, and 24-hour activity.
- `/stats` — Alias for the dashboard.


## Payment reconciliation (admin)

- `/payments` — Summary of payment, checkout-session, and provider-event states. Buttons open recent transactions or 30-day analytics.
- `/payment_recent` — Latest 10 payment transactions with inline **Details** buttons.
- Transaction detail view — Shows payment/session/event history. Verified transactions expose a **Retry safe fulfillment** button.
- **Recent payments** — Return to the transaction list; **Refresh** reloads it.
- `/payment_analytics` — 30-day revenue by currency, successful vs failed/expired payments, payment-method breakdown, daily revenue, active/new Premium membership counts, and unique paying users.
- `/payment_search <query>` — Search by transaction ID, Telegram user ID, UTR, or external transaction reference (up to 10 results).
- `/payment_detail <transaction_id>` — Open transaction details directly.
- `/payment_reconcile <transaction_id>` — Retry fulfillment for a verified payment. Fulfillment is idempotent.


### Paginated payment browser

- `/payment_recent` opens the transaction browser, initially showing the latest five transactions.
- Inline filters: **All**, **Verified**, **Applied**, **Rejected**, **Expired**.
- **Search payments** button provides the command hint; use `/payment_search <query>` to search by ID, user, UTR, or external reference
- **Previous / Next** buttons page through the selected filter; **Refresh** reloads the current page.
- Each row has a **Details** button. The detail screen's back button returns to the same filter and page.
- Filtered listing and count queries use parameterized SQL; page size is bounded to 10.
