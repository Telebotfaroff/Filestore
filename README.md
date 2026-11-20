# FileStore

A modular Telegram file indexing and delivery platform. FileStore is being developed in small, verified milestones.

## Current status

**Milestone 1 — Foundation:** in progress

This repository currently establishes project configuration and engineering rules. Telegram workflows and database migrations will be implemented in later, individually approved milestones.

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

See [AGENTS.md](./AGENTS.md). Work proceeds milestone-by-milestone. Do not implement later milestones without explicit user approval.

## Security

Never commit bot tokens, database credentials, encryption keys, payment credentials, or other secrets. Use local environment variables and the deployment provider's secret settings.
