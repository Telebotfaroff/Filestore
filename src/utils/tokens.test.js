import test from 'node:test';
import assert from 'node:assert/strict';
import { createToken, hashToken, parsePayload } from './tokens.js';

test('creates random tokens with stable hashes', () => {
  const first = createToken();
  const second = createToken();
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashToken(first.token));
  assert.equal(first.payload, `_${first.token}`);
});

test('parses single and batch deep-link payloads', () => {
  const token = createToken().token;
  assert.equal(parsePayload(`F_${token}`)?.type, 'F');
  assert.equal(parsePayload(`B_${token}`)?.type, 'B');
  assert.equal(parsePayload(`F_${token}`)?.tokenHash, hashToken(token));
});

test('rejects malformed payloads', () => {
  assert.equal(parsePayload(''), null);
  assert.equal(parsePayload('F_short'), null);
  assert.equal(parsePayload('X_abcdefghijklmnopqrstuvwx'), null);
  assert.equal(parsePayload('F_../../not-a-token'), null);
});

test('parsePayload accepts post links', () => {
  const token = 'A'.repeat(32);
  const parsed = parsePayload('P_' + token);
  assert.equal(parsed.type, 'P');
  assert.equal(parsed.token, token);
  assert.equal(parsed.tokenHash, hashToken(token));
});
