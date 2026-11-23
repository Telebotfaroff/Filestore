import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBotToken, decryptBotToken, resolveTokenEncryptionKey } from '../src/security/token-encryption.js';

const key = Buffer.alloc(32, 7).toString('base64');
test('encrypts and decrypts bot tokens with authenticated envelope', () => {
  const token = '123456:TEST_TOKEN';
  const encrypted = encryptBotToken(token, key);
  assert.notEqual(encrypted, token);
  assert.equal(decryptBotToken(encrypted, key), token);
});
test('accepts documented 64-character hex encryption keys', () => {
  const hexKey = Buffer.alloc(32, 9).toString('hex');
  const token = '987654:HEX_KEY_TEST';
  const encrypted = encryptBotToken(token, hexKey);
  assert.equal(decryptBotToken(encrypted, hexKey), token);
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
test('resolveTokenEncryptionKey returns configured key or persists generated key in app_settings', async () => {
  assert.equal(await resolveTokenEncryptionKey(null, key), key);
  const store = new Map();
  const pool = {
    isMock: false,
    query: async (sql, params) => {
      if (sql.startsWith('SELECT')) {
        const saved = store.get(params[0]);
        return saved ? { rows: [{ key: saved }] } : { rows: [] };
      }
      if (sql.startsWith('INSERT') && !store.has(params[0])) {
        store.set(params[0], params[1]);
      }
      return { rows: [] };
    },
  };
  const first = await resolveTokenEncryptionKey(pool, '');
  const second = await resolveTokenEncryptionKey(pool, '');
  assert.equal(Buffer.from(first, 'base64').length, 32);
  assert.equal(first, second);
});
