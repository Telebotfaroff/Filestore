# FileStore

A modular Telegram file indexing and delivery platform built with Node.js, Telegraf, and PostgreSQL.

## Progress

- **Milestones 1–5:** foundation, configuration, migrations, Main Bot, and storage-channel manager.
- **Milestone 6:** media ingestion, metadata, file codes, duplicate detection, and file search.
- **Milestone 7:** persistent single-file delivery jobs, delivery attempts, and conservative recovery.
- **Milestone 8:** dynamic Delivery Bot manager with encrypted tokens, independent runtimes, primary/backup role, priority, pause/resume/restart/remove, permission tests, and health-based failover.

Live PostgreSQL/Neon and Telegram integration testing is pending credentials. User delivery remains admin-only until access rules and force-subscription are implemented.

## Stack

- Node.js 22+ / ES Modules
- Telegraf (Telegram Bot API)
- PostgreSQL (Neon-compatible)
- pg, Zod, dotenv, Pino

## Setup

1. Install Node.js 22+ and clone this repository.
2. Copy `.env.example` to `.env`.
3. Set `MAIN_BOT_TOKEN`, `DATABASE_URL`, and numeric `ADMIN_IDS`.
4. Optionally set `DELIVERY_BOT_TOKEN` to bootstrap a Delivery Bot.
5. For token management, generate a 32-byte base64 `TOKEN_ENCRYPTION_KEY` locally.
6. Run `npm install`.
7. Run `npm run migrate`.
8. Run `npm start`.

## Command reference

See [docs/commands.md](docs/commands.md).

## AI coding rules

See [AGENTS.md](AGENTS.md). Full roadmap permission is active; development proceeds sequentially and tests are reported honestly.

## Secrets

Never commit tokens, database URLs, encryption keys, or payment credentials. Use environment variables or host secret settings.
