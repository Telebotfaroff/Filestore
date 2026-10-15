import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, signShortenerCallback, verifyShortenerCallback } from './security.js';

test('passwords are salted and verify correctly', () => {
  const first = hashPassword('correct horse battery');
  const second = hashPassword('correct horse battery');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('correct horse battery', first), true);
  assert.equal(verifyPassword('wrong password', first), false);
});

test('rejects passwords outside allowed length', () => {
  assert.throws(() => hashPassword('abc'), /between 4 and 128/);
  assert.throws(() => hashPassword('x'.repeat(129)), /between 4 and 128/);
});

test('shortener callbacks require the correct signature', () => {
  const secret = 'test-secret-that-is-not-used-in-production';
  const session = 'sample-session-id';
  const signature = signShortenerCallback(session, secret);
  assert.equal(verifyShortenerCallback(session, signature, secret), true);
  assert.equal(verifyShortenerCallback(session, signature, 'different-secret'), false);
  assert.equal(verifyShortenerCallback('other-session', signature, secret), false);
  assert.equal(verifyShortenerCallback(session, 'bad-signature', secret), false);
});
