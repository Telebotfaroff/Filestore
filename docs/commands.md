# FileStore Main Bot Commands

All Main Bot commands are restricted to administrator Telegram IDs configured in `ADMIN_IDS`.

## Main Bot

- `/start` — control center.
- `/help` — command list.
- `/status` — database connection and file count.

## File ingestion and search

Send supported media (video, document, photo, audio, voice, video note, or animation) in private chat with the Main Bot. It copies the message to the tested primary storage channel and indexes metadata.

- `/files` — latest indexed files.
- `/find <filename or file code>` — search.
- `/fileinfo <file_code>` — metadata and storage message reference.

## Storage channels

- `/storage` — list channels.
- `/storage_add <channel_id or @username>` — verify Main Bot posting permission and add channel.
- `/storage_test <channel_id>` — recheck membership and posting rights.
- `/storage_enable <channel_id>` — enable; promote if no tested active primary.
- `/storage_disable <channel_id>` — disable without removing file references.
- `/storage_primary <channel_id>` — set primary; other channels become backup.
- `/storage_remove <channel_id>` — delete if no file-message references; otherwise disable safely.

## Dynamic Delivery Bot manager

- `/delivery_bots` — list bot records.
- `/delivery_bot_add <token>` — validate token, encrypt, start runtime; delete token message when possible.
- `/delivery_bot_pause <record_id>` — pause that bot's job worker.
- `/delivery_bot_resume <record_id>` — resume.
- `/delivery_bot_restart <record_id>` — restart one runtime.
- `/delivery_bot_remove <record_id>` — stop and delete token record; historical attempts remain.
- `/delivery_bot_primary <record_id>` — select queue worker bot.
- `/delivery_bot_priority <record_id> <1-100000>` — set backup preference (lower is preferred).
- `/delivery_bot_test <record_id>` — check bot identity and membership in enabled storage channels.

Only the primary Delivery Bot runs the persistent queue worker. Backups stay online for admin commands and can be promoted by health-based failover.

## Delivery Bot (admin-only test mode)

- `/get <file_code>` — queue a test delivery to the administrator.
- `/delivery_status` — counts by job status.
- `/delivery_test` — test storage-channel access for that bot.

Public file access remains locked until Access Manager and force-subscription enforcement are implemented.

## Security

Managed bot tokens are encrypted using AES-256-GCM. Set `TOKEN_ENCRYPTION_KEY` to a base64-encoded 32-byte key. Generate locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Never commit tokens, encryption keys, database credentials, or payment secrets.
