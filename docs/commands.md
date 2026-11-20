# FileStore Main Bot Commands

Commands are restricted to administrator Telegram IDs configured in `ADMIN_IDS`.

## Main Bot

- `/start` — control center.
- `/help` — command list.
- `/status` — database connection and indexed file counts.

## File ingest and index

Send supported media (video, document, photo, audio, voice, video note, or animation) to the Main Bot in private. It copies the message into the enabled, tested primary storage channel and indexes metadata.

- `/files` — list latest indexed files.
- `/find <filename or file code>` — search.
- `/fileinfo <file_code>` — show metadata and storage message reference.

## Storage channels

- `/storage` — list registered channels.
- `/storage_add <channel_id or @username>` — validate Main Bot posting permissions and register.
- `/storage_test <channel_id>` — recheck membership and posting rights.
- `/storage_enable <channel_id>` — enable channel; it can become primary if no enabled, tested primary exists.
- `/storage_disable <channel_id>` — disable while preserving indexed references.
- `/storage_primary <channel_id>` — promote channel; other roles become backup.
- `/storage_remove <channel_id>` — delete if no indexed message references; otherwise disable safely.

## Dynamic Delivery Bot manager

- `/delivery_bots` — list registered runtimes.
- `/delivery_bot_add <token>` — validate token, encrypt it, launch bot runtime; token message is deleted when possible.
- `/delivery_bot_pause <record_id>` — pause worker; runtime remains available for admin commands.
- `/delivery_bot_resume <record_id>` — resume.
- `/delivery_bot_restart <record_id>` — restart one runtime.
- `/delivery_bot_remove <record_id>` — stop runtime and delete its stored encrypted token; history is retained.
- `/delivery_bot_primary <record_id>` — select the job-processing bot.
- `/delivery_bot_priority <record_id> <1-100000>` — set backup selection priority (lower number preferred).
- `/delivery_bot_test <record_id>` — validate bot and storage channel membership.

Delivery Bot user access is intentionally limited to configured administrators while Access Manager and force-subscription enforcement are unfinished. Each Delivery Bot has admin-only `/get <file_code>`, `/delivery_status`, and `/delivery_test`. Only the primary bot runs the queue worker; backup runtimes are promoted after health failures.

## Security

Managed tokens are encrypted using AES-256-GCM. Configure `TOKEN_ENCRYPTION_KEY` as a base64-encoded 32-byte key. Generate one locally with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Do not commit the generated key or bot tokens.
