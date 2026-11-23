import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStorageIdentifier } from '../src/storage/identifier.js';

test('parses numeric private channel IDs', () => {
  assert.equal(parseStorageIdentifier('-1001234567890'), -1001234567890);
});
test('accepts channel usernames and t.me channel links', () => {
  assert.equal(parseStorageIdentifier('@FileStoreChannel'), '@FileStoreChannel');
  assert.equal(parseStorageIdentifier('https://t.me/FileStoreChannel'), '@FileStoreChannel');
  assert.equal(parseStorageIdentifier('t.me/c/1234567890/15'), -1001234567890);
});
test('rejects malformed and invite channel identifiers cleanly', () => {
  assert.throws(() => parseStorageIdentifier('channel name'));
  assert.throws(() => parseStorageIdentifier('@abc'));
  assert.throws(() => parseStorageIdentifier('https://t.me/+AbCdEfGhIjK'), /Invite links/);
});
