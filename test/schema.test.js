import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration1 = await readFile(new URL('../src/database/migrations/001_core_schema.sql', import.meta.url), 'utf8');
const migration2 = await readFile(new URL('../src/database/migrations/002_file_ingest_requests.sql', import.meta.url), 'utf8');
const migration3 = await readFile(new URL('../src/database/migrations/003_unique_active_file_ids.sql', import.meta.url), 'utf8');
const migration4 = await readFile(new URL('../src/database/migrations/004_delivery_queue.sql', import.meta.url), 'utf8');
const migration5 = await readFile(new URL('../src/database/migrations/005_delivery_bot_manager.sql', import.meta.url), 'utf8');
const migration6 = await readFile(new URL('../src/database/migrations/006_force_subscription.sql', import.meta.url), 'utf8');
const migration7 = await readFile(new URL('../src/database/migrations/007_shortener_checkpoint.sql', import.meta.url), 'utf8');
const migration8 = await readFile(new URL('../src/database/migrations/008_access_manager.sql', import.meta.url), 'utf8');
const migration9 = await readFile(new URL('../src/database/migrations/009_payment_foundation.sql', import.meta.url), 'utf8');
const migration10 = await readFile(new URL('../src/database/migrations/010_paid_file_links.sql', import.meta.url), 'utf8');
const migration11 = await readFile(new URL('../src/database/migrations/011_paid_batch_links.sql', import.meta.url), 'utf8');
const migration12 = await readFile(new URL('../src/database/migrations/012_auto_delete.sql', import.meta.url), 'utf8');
const migration13 = await readFile(new URL('../src/database/migrations/013_payment_verification.sql', import.meta.url), 'utf8');
const migration14 = await readFile(new URL('../src/database/migrations/014_paid_batch_payment_sessions.sql', import.meta.url), 'utf8');
const migration15 = await readFile(new URL('../src/database/migrations/015_exact_paid_link_sessions.sql', import.meta.url), 'utf8');

test('initial schema defines core tables and constraints', () => {
  for (const table of ['users', 'app_settings', 'storage_channels', 'files', 'storage_messages', 'tags', 'file_tags', 'activity_logs']) {
    assert.match(migration1, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
  }
  assert.match(migration1, /UNIQUE \(storage_channel_id, telegram_message_id\)/);
});

test('file ingest migration has idempotency key and processing states', () => {
  assert.match(migration2, /UNIQUE \(source_chat_id, source_message_id\)/);
  for (const status of ['processing', 'completed', 'duplicate', 'failed']) assert.match(migration2, new RegExp(status));
});

test('delivery queue tables include persisted job and attempt states', () => {
  assert.match(migration4, /CREATE TABLE IF NOT EXISTS delivery_jobs/);
  assert.match(migration4, /CREATE TABLE IF NOT EXISTS delivery_items/);
  assert.match(migration4, /CREATE TABLE IF NOT EXISTS delivery_attempts/);
  for (const status of ['pending', 'processing', 'completed', 'failed', 'uncertain']) assert.match(migration4, new RegExp(status));
});

test('dynamic Delivery Bot table includes encrypted token and runtime fields', () => {
  assert.match(migration5, /token_ciphertext/);
  assert.match(migration5, /runtime_status/);
  assert.match(migration5, /delivery_bots_single_primary_idx/);
});

test('force-subscription channel manager schema includes join links', () => {
  assert.match(migration6, /force_sub_channels/);
  assert.match(migration6, /join_url/);
  assert.match(migration6, /is_enabled/);
});

test('shortener checkpoint schema stores hashed sessions and user checkpoint state', () => {
  assert.match(migration7, /shortener_providers/);
  assert.match(migration7, /checkpoint_sessions/);
  assert.match(migration7, /user_checkpoint_state/);
  assert.match(migration7, /verification_token/);
});

test('Access Manager schema includes premium memberships and entitlements', () => {
  assert.match(migration8, /premium_plans/);
  assert.match(migration8, /premium_memberships/);
  assert.match(migration8, /access_grants/);
  assert.match(migration8, /checkpoint_enabled/);
});

test('payment foundation seeds the four requested methods and uses unique transaction IDs', () => {
  for (const method of ['fampay', 'telegram_stars', 'stripe', 'crypto']) assert.match(migration9, new RegExp(method));
  assert.match(migration9, /payment_sessions/);
  assert.match(migration9, /payment_transactions/);
  assert.match(migration9, /payment_transactions_utr_unique_idx/);
});

test('paid file links and purchase rows have unique user-link records and lifecycle states', () => {
  assert.match(migration10, /paid_file_links/);
  assert.match(migration10, /public_code_hash/);
  assert.match(migration10, /paid_file_purchases/);
  assert.match(migration10, /UNIQUE \(paid_link_id, user_telegram_id\)/);
  for (const status of ['pending', 'paid', 'delivered', 'refunded', 'cancelled']) assert.match(migration10, new RegExp(status));
});

test('paid batch links support ordered items and unique user purchases', () => {
  for (const table of ['paid_batch_links', 'paid_batch_items', 'paid_batch_purchases']) assert.match(migration11, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
  assert.match(migration11, /PRIMARY KEY \(batch_link_id, file_id\)/);
  assert.match(migration11, /UNIQUE \(batch_link_id, user_telegram_id\)/);
  assert.match(migration11, /position INTEGER NOT NULL/);
});

test('payment verification schema stores idempotent provider events and checkout metadata', () => {
  assert.match(migration13, /UNIQUE\\(method, provider_event_id\\)/);
  assert.match(migration13, /UNIQUE\\(method, provider_event_id\\)/);
  assert.match(migration13, /UNIQUE\\(method, provider_event_id\\)/);
  assert.match(migration13, /UNIQUE\\(method, provider_event_id\\)/);
  assert.match(migration14, /paid_batch/);
  assert.match(migration15, /paid_link_id/);
});

test('active media identifiers are unique and schema contains no duplicate primary declaration', () => {
  assert.match(migration3, /CREATE UNIQUE INDEX/);
  assert.doesNotMatch(migration1 + migration2, /PRIMARY PRIMARY/);
});


test('auto-delete schema stores global setting and persisted deletion queue', () => {
  assert.match(migration12, /delivery_settings/);
  assert.match(migration12, /auto_delete_minutes/);
  assert.match(migration12, /scheduled_message_deletions/);
  for (const status of ['pending', 'processing', 'deleted', 'failed']) assert.match(migration12, new RegExp(status));
  assert.match(migration12, /delivery_bot_identity/);
  assert.match(migration12, /delete_at/);
});


const deliveryBotSource = await readFile(new URL('../src/delivery/bot.js', import.meta.url), 'utf8');
const accessManagerSource = await readFile(new URL('../src/access/access-manager.js', import.meta.url), 'utf8');
const dashboardSource = await readFile(new URL('../src/admin/dashboard-repository.js', import.meta.url), 'utf8');
const dashboardCommands = await readFile(new URL('../src/admin/dashboard-commands.js', import.meta.url), 'utf8');

test('public get handler is wired to centralized access manager and checkpoint messaging', () => {
  assert.match(deliveryBotSource, /evaluateAccess/);
  assert.match(deliveryBotSource, /type: \\(paidEntitled \\|\\| paidLocked\\) \\? 'paid_file' : 'free_file'/);
  assert.match(deliveryBotSource, /checkpoint_required/);
  assert.match(accessManagerSource, /checkpoint_enabled/);
  assert.match(accessManagerSource, /premium/);
});

test('user access status commands are registered and allowed through delivery bot middleware', () => {
  assert.match(deliveryBotSource, /bot\.command\('checkpoint_status'/);
  assert.match(deliveryBotSource, /bot\.command\('access_status'/);
  assert.match(deliveryBotSource, /'\/checkpoint_status', '\/access_status'/);
});

test('admin dashboard includes operational counts and command aliases', () => {
  for (const key of ['users_total', 'files_active', 'jobs_pending', 'premium_active', 'paid_file_requests_pending', 'revenue_by_currency', 'events_24h']) assert.match(dashboardSource, new RegExp(key));
  assert.match(dashboardCommands, /bot\.command\('dashboard'/);
  assert.match(dashboardCommands, /bot\.command\('stats'/);
});
