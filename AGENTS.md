# FileStore AI Development Rules

## Authority and scope

- This file is the working development contract for AI coding assistants.
- The user approves one milestone or task at a time.
- Read the current repository before proposing or changing code.
- Do not start additional milestones based on inferred permission.
- Before a milestone, explain its exact scope, files likely to change, and validation plan when approval is needed.
- After completing the approved task, stop and report. Ask for approval before moving to the next milestone.

## Engineering principles

- Node.js 22+ with ES Modules.
- Telegram Bot API via Telegraf; do not add MTProto unless explicitly approved.
- PostgreSQL is the durable source of truth.
- Keep modules small, focused, and testable.
- No secrets in source code, commits, logs, or sample files.
- Validate environment configuration at startup.
- Use migrations for schema changes; never reset or recreate production data to apply changes.
- Use transactions and database constraints for operations that must be atomic.
- Make payment, delivery, and job-processing flows idempotent where possible.
- Persist background work; do not rely on process-local timers for durable tasks.
- Never add fake implementations, silent stubs, or buttons that pretend to work.
- Do not claim a feature is tested unless the test was actually run and passed.
- Prefer focused dependencies; explain any new dependency before adding it.
- Avoid broad rewrites or unrelated formatting changes.

## Workflow for each approved task

1. Inspect the relevant files and existing state.
2. Restate the approved task briefly and list expected changes.
3. Implement only that task.
4. Run relevant checks/tests.
5. Report files changed, test results, known limitations.
6. Stop and wait for the next user approval.

## Initial product boundaries

- Main Bot is the admin/control plane.
- Delivery Bots are separate user-facing runtimes and can be managed dynamically later.
- Force-subscription checks must be centralized and enforced before every delivery.
- All gateways feed one transaction/payment engine.
- Delivery and auto-delete tasks must survive process restarts.
- Backup bot failover must account for uncertain Telegram send outcomes and possible duplicates.
- Premium bypasses free URL-shortener checkpoints only; it does not automatically unlock paid files.
- Batch deliveries must snapshot their file membership when a job starts.
- Never implement the entire roadmap in one pass.

## Roadmap (not approval to implement)

1. Foundation and repository scaffold.
2. Configuration validation and application bootstrap.
3. Database connectivity and versioned migrations.
4. Main Bot runtime and admin authorization.
5. Storage-channel management and file indexing.
6. File management and retrieval.
7. Delivery job engine and runtime.
8. Dynamic Delivery Bot manager.
9. Force-subscription manager.
10. URL checkpoint/shortener manager.
11. Premium plans and payment adapters (FamPay/UPI, Telegram Stars, Stripe, crypto).
12. Paid file links and batch links.
13. Persistent auto-delete.
14. Activity logs, statistics, monitoring, backups, hardening.

Roadmap order may be revised only after review and user approval.
