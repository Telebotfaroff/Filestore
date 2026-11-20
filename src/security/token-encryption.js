import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function getEncryptionKey(encodedKey) {
  const key = Buffer.from(String(encodedKey ?? '').trim(), 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

export function encryptBotToken(token, encodedKey) {
  const key = getEncryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptBotToken(envelope, encodedKey) {
  const key = getEncryptionKey(encodedKey);
  const parts = String(envelope).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported token encryption envelope');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed encrypted token envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
