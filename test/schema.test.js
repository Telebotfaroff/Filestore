import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration1 = await readFile(new URL('../src/database/migrations/001_core_schema.sql', import.meta.url), 'utf8');
const migration2 = await readFile(new URL('../src/database/migrations/002_file_ingest_requests.sql', import.meta.url), 'utf8');
const migration3 = await readFile(new URL('../src/database/migrations/003_unique_active_file_ids.sql', import.meta.url), 'utf8');

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

test('active media identifiers are unique and schema contains no duplicate primary declaration', () => {
  assert.match(migration3, /CREATE UNIQUE INDEX/);
  assert.doesNotMatch(migration1 + migration2, /PRIMARY PRIMARY/);
});
