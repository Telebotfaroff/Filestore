# FileStore

A modular Telegram file indexing and delivery platform built with Node.js, Telegraf, and PostgreSQL.

## Progress

- **Milestones 1–5:** foundation, configuration, database migrations, Main Bot runtime, and storage-channel manager implemented.
- **Milestone 6:** media ingestion, metadata indexing, unique file codes, duplicate detection, and search implemented.
- **Milestone 7:** persistent delivery jobs, separate administrator-only test Delivery Bot, attempt tracking, and conservative crash recovery implemented.

The code is committed in sequential pieces. Live PostgreSQL/Neon and Telegram API integration testing still requires project credentials and has not been run. The Delivery Bot intentionally remains administrator-only until Access Manager and force-subscription checks are implemented.

## Stack

- Node.js 22+ / ES Modules
- Telegraf (Telegram Bot API)
- PostgreSQL (Neon-compatible)
- pg, Zod, dotenv, Pino

## Local setup

1. Install Node.js 22 or newer.
2. Clone the repository.
3. Copy `.env.example` to `.env`.
4. Configure `MAIN_BOT_TOKEN`, `DATABASE_URL`, and at least one numeric `ADMIN_IDS`.
5. Optionally configure `DELIVERY_BOT_TOKEN` for the admin-only Delivery Bot test runtime.
6. Run `npm install`.
7. Apply migrations: `npm run migrate`.
8. Start: `npm start`.

## Admin commands

See [docs/commands.md](docs/commands.md).

## Development rules

See [AGENTS.md](AGENTS.md). The user has authorized the roadmap; milestones are implemented sequentially and never collapsed into one giant change.

## Security

Never commit Telegram bot tokens, database credentials, encryption keys, payment credentials, or other secrets. Configure secrets through local environment variables or the hosting provider's environment settings.
