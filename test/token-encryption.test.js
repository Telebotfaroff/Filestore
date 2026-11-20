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
  const ciphertext = Buffer.from(encrypted[3], 'base64url');
  ciphertext[0] ^= 0xff;
  encrypted[3] = ciphertext.toString('base64url');
  assert.throws(() => decryptBotToken(encrypted.join('.'), key));
});
