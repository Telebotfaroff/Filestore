# FileStore

A modular Telegram file indexing and delivery platform built with Node.js, Telegraf, and PostgreSQL.

## Progress

- **Milestones 1–5:** foundation, configuration, migrations, Main Bot, and storage-channel manager.
- **Milestone 6:** media ingestion, metadata, file codes, duplicate detection, and file search.
- **Milestone 7:** persistent single-file delivery queue, delivery attempts, and cautious crash recovery.
- **Milestone 8:** dynamic Delivery Bot manager with encrypted tokens, primary/backup roles, priority, pause/resume/restart/remove, permission tests, and health-based failover.
- **Milestone 9:** force-subscription manager, channel controls, user registration, join/verify buttons, and fail-closed checks.

Live Telegram and PostgreSQL integration testing is pending configured credentials. Delivery remains admin-only until the Access Manager and force-subscription milestones are complete.

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

## Commands

See [docs/commands.md](docs/commands.md).

## AI coding rules

See [AGENTS.md](AGENTS.md). The complete roadmap is authorized and is being implemented sequentially, not in a single oversized change.

## Secrets

Never commit Telegram tokens, database URLs, encryption keys, or payment credentials. Use environment variables or host secret settings.
