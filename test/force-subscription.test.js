import test from 'node:test';
import assert from 'node:assert/strict';
import { isTelegramMember } from '../src/access/force-subscription.js';

test('accepts subscribed and admin members', () => {
  assert.equal(isTelegramMember({ status: 'member' }), true);
  assert.equal(isTelegramMember({ status: 'administrator' }), true);
  assert.equal(isTelegramMember({ status: 'creator' }), true);
});
test('accepts restricted member only when is_member is true', () => {
  assert.equal(isTelegramMember({ status: 'restricted', is_member: true }), true);
  assert.equal(isTelegramMember({ status: 'restricted', is_member: false }), false);
});
test('rejects absent, left, and kicked members', () => {
  assert.equal(isTelegramMember(null), false);
  assert.equal(isTelegramMember({ status: 'left' }), false);
  assert.equal(isTelegramMember({ status: 'kicked' }), false);
});
