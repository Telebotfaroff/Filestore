# FileStore

A modular Telegram file indexing and delivery platform. FileStore is being developed in small, verified milestones.

## Current status

**Milestones 1–5 — Foundation, bootstrap, database base, Main Bot runtime, and storage-channel manager:** completed in repository. **Milestone 6 — File ingest/indexing:** underway. Live integration testing pending

The repository includes project setup, validated configuration, structured logging, PostgreSQL pooling, checksum-protected migrations, the core schema, an administrator-restricted Main Bot, and channel management commands. Live database and Telegram API integration tests have not yet been run.

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

6. Apply schema changes with `npm run migrate` before launching.\n7. Start FileStore with `npm start`.\n\nThe Main Bot requires an applied migration and valid administrator IDs in `ADMIN_IDS`.

## Development approach

See [AGENTS.md](./AGENTS.md). Work proceeds milestone-by-milestone under the user's full roadmap authorization. Do not collapse all milestones into one implementation.

## Security

Never commit bot tokens, database credentials, encryption keys, payment credentials, or other secrets. Use local environment variables and the deployment provider's secret settings.
