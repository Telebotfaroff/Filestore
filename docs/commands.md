# FileStore Main Bot Commands

These commands are restricted to Telegram user IDs configured in `ADMIN_IDS`.

## Core

- `/start` — admin welcome.
- `/help` — available commands.
- `/status` — Main Bot username, database connection status, indexed users/files counters.

## File indexing and search

- Send supported media to the Main Bot in a private chat to copy it to the tested primary storage channel and index metadata.
- `/files` — show the latest indexed files.
- `/find <filename or file code>` — search indexed files.
- `/fileinfo <file_code>` — show metadata and stored Telegram message reference.


## Dynamic Delivery Bot manager (Main Bot)

- `/delivery_bots` — list bots with runtime status, role, and priority.
- `/delivery_bot_add <token>` — validate a BotFather token, encrypt it, and start its runtime. The command message is deleted when possible.
- `/delivery_bot_pause <record_id>` — stop that bot's job worker while keeping its admin command runtime.
- `/delivery_bot_resume <record_id>` — resume the runtime and worker if primary.
- `/delivery_bot_restart <record_id>` — restart one bot.
- `/delivery_bot_remove <record_id>` — stop and remove the bot/token; delivery history is preserved.
- `/delivery_bot_primary <record_id>` — select primary worker bot.
- `/delivery_bot_priority <record_id> <1-100000>` — set backup selection priority (lower is preferred).
- `/delivery_bot_test <record_id>` — test bot token and storage-channel membership.

Tokens are encrypted using AES-256-GCM before database storage. Set a base64-encoded 32-byte `TOKEN_ENCRYPTION_KEY` in the environment. Only the primary Delivery Bot runs the queue worker; backup runtimes remain available for admin commands and are promoted on health failure.


## Delivery Bot (administrator-only test mode)

- Set `DELIVERY_BOT_TOKEN` to enable the optional Delivery Bot runtime.
- `/get <file_code>` — queue a test delivery to the administrator.
- `/delivery_status` — view pending, processing, completed, failed, and uncertain jobs.
- `/delivery_test` — test the Delivery Bot's membership/access to enabled storage channels.

User-facing delivery is intentionally locked to configured administrators until the Access Manager and force-subscription milestones are implemented.


## Storage channels

- `/storage` — list configured storage channels.
- `/storage_add <channel_id or @username>` — verify that the Main Bot is an administrator with posting permission, then register the channel.
- `/storage_test <channel_id>` — recheck bot membership and channel posting permission; save the test status.
- `/storage_enable <channel_id>` — enable a registered storage channel.
- `/storage_disable <channel_id>` — disable a channel without removing existing indexed messages.
- `/storage_primary <channel_id>` — select the primary channel; the other channels become backups.
- `/storage_remove <channel_id>` — remove a channel only if it has no indexed storage-message references; otherwise disable it safely.

## Notes

- Storage destination support currently accepts Telegram channels, including private channels by numeric ID.
- The bot must be a channel administrator with posting permission.
- The first enabled channel is promoted to primary automatically.
- Selecting or re-enabling a channel may promote it if no enabled primary exists.
- Storage channel registration, diagnostics, media ingestion, and basic indexing are implemented. File delivery and editing/deletion workflows are upcoming.
