import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStorageIdentifier } from '../src/storage/identifier.js';

test('parses numeric private channel IDs', () => {
  assert.equal(parseStorageIdentifier('-1001234567890'), -1001234567890);
});
test('accepts channel usernames', () => {
  assert.equal(parseStorageIdentifier('@FileStoreChannel'), '@FileStoreChannel');
});
test('rejects malformed channel identifiers', () => {
  assert.throws(() => parseStorageIdentifier('channel name'));
  assert.throws(() => parseStorageIdentifier('@abc'));
});
