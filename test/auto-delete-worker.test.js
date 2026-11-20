import test from 'node:test';
import assert from 'node:assert/strict';
import { isTelegramDeletionAlreadyComplete } from '../src/delivery/auto-delete-worker.js';

test('recognizes Telegram already-deleted message errors as completed', () => {
  assert.equal(isTelegramDeletionAlreadyComplete({ response: { description: 'Bad Request: message to delete not found' } }), true);
  assert.equal(isTelegramDeletionAlreadyComplete(new Error('Message not found')) , true);
});

test('does not suppress unrelated Telegram deletion failures', () => {
  assert.equal(isTelegramDeletionAlreadyComplete({ response: { description: 'Forbidden: bot was blocked by the user' } }), false);
  assert.equal(isTelegramDeletionAlreadyComplete(new Error('Network timeout')), false);
  assert.equal(isTelegramDeletionAlreadyComplete(null), false);
});
