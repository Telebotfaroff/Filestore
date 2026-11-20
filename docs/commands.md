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
