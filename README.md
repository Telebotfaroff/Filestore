# FileStore

A modular Telegram file indexing and delivery platform. FileStore is being developed in small, verified milestones.

## Current status

**Milestones 1–4 — Foundation, bootstrap, database base, and Main Bot runtime:** committed; syntax checks pass where performed; external integration testing remains pending

The repository includes project setup, validated configuration, structured logging, PostgreSQL pooling, checksum-protected migrations, an initial core schema, and an administrator-restricted Main Bot with `/start`, `/help`, and `/status`. Live database and Telegram API integration tests have not yet been run.

## Planned architecture

- **Node.js 22+ / ES Modules**
- **Telegraf** for Telegram Bot API interactions
- **PostgreSQL (Neon)** for persistent state, configuration, jobs, memberships and delivery history
- **Pino** for structured logging
- **Zod** for configuration validation

## Local setup

1. Install Node.js 22 or newer.
2. Clone the repository.
3. Copy `.env.example` to `.env` and fill in credentials.
4. Install dependencies: `npm install`.
5. Run: `npm start`.

The entry point will be added in a later milestone; until then, the start script is not operational.

## Development approach

See [AGENTS.md](./AGENTS.md). Work proceeds milestone-by-milestone under the user's full roadmap authorization. Do not collapse all milestones into one implementation.

## Security

Never commit bot tokens, database credentials, encryption keys, payment credentials, or other secrets. Use local environment variables and the deployment provider's secret settings.
