import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin } from '../src/bot/admin-guard.js';

test('matches configured Telegram admin IDs', () => {
  assert.equal(isAdmin(111, [111, 222]), true);
  assert.equal(isAdmin(333, [111, 222]), false);
});

test('rejects absent user IDs', () => {
  assert.equal(isAdmin(undefined, [111]), false);
  assert.equal(isAdmin(null, [111]), false);
});
