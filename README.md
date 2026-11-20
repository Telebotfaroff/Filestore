# FileStore

A modular Telegram file indexing and delivery platform built with Node.js, Telegraf, and PostgreSQL.

## Progress

- **Milestones 1–5:** foundation, configuration, database schema/migrations, Main Bot runtime, storage-channel management.
- **Milestone 6:** media ingestion, metadata indexing, file-code generation, duplicate detection, and basic search (implemented in the repository; runtime integration testing is pending).

The code has been committed in sequential pieces. PostgreSQL and Telegram integration have not yet been tested against live credentials.

## Stack

- Node.js 22+ / ES Modules
- Telegraf (Telegram Bot API)
- PostgreSQL (Neon compatible)
- pg, Zod, dotenv, Pino

## Local setup

1. Install Node.js 22 or newer.
2. Clone the repository.
3. Copy `.env.example` to `.env` and configure `MAIN_BOT_TOKEN`, `DATABASE_URL`, and at least one `ADMIN_IDS` value.
4. Run `npm install`.
5. Apply migrations: `npm run migrate`.
6. Start: `npm start`.

## Admin commands

See [docs/commands.md](docs/commands.md).

## Development rules

See [AGENTS.md](AGENTS.md). Milestones are developed sequentially; the user's full roadmap authorization is active. No milestone is collapsed into a giant code dump.

## Security

Never commit Telegram bot tokens, database credentials, encryption keys, payment credentials, or other secrets. Configure secrets through local environment variables or the hosting provider's environment settings.
