# FileStore

A modular Telegram file indexing and delivery platform. FileStore is being developed in small, verified milestones.

## Current status

**Milestones 1–2 — Foundation and bootstrap:** committed (not yet dependency-installed or runtime-tested)

The repository now includes project configuration, development rules, validated environment parsing, structured logging, and a minimal startup entry point. Telegram workflows and database migrations remain upcoming milestones.

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
