import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBotToken, decryptBotToken } from '../src/security/token-encryption.js';

const key = Buffer.alloc(32, 7).toString('base64');
test('encrypts and decrypts bot tokens with authenticated envelope', () => {
  const token = '123456:TEST_TOKEN';
  const encrypted = encryptBotToken(token, key);
  assert.notEqual(encrypted, token);
  assert.equal(decryptBotToken(encrypted, key), token);
});
test('rejects invalid encryption key size', () => {
  assert.throws(() => encryptBotToken('token', 'invalid'), /32-byte key/);
});
test('rejects tampered ciphertext', () => {
  const encrypted = encryptBotToken('token', key).split('.');
  encrypted[3] = encrypted[3].slice(0, -1) + (encrypted[3].endsWith('A') ? 'B' : 'A');
  assert.throws(() => decryptBotToken(encrypted.join('.'), key));
});
