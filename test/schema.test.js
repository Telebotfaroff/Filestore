import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../src/database/migrations/001_core_schema.sql', import.meta.url), 'utf8');

test('initial schema defines core tables and constraints', () => {
  for (const table of ['users', 'app_settings', 'storage_channels', 'files', 'storage_messages', 'tags', 'file_tags', 'activity_logs']) {
    assert.match(migration, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
  }
  assert.match(migration, /UNIQUE \(storage_channel_id, telegram_message_id\)/);
});

test('migration does not contain duplicate PRIMARY declarations', () => {
  assert.doesNotMatch(migration, /PRIMARY PRIMARY/);
  assert.match(migration, /PRIMARY KEY/);
});
