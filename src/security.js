import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

export function hashPassword(password) {
  const value = String(password || '');
  if (value.length < 4 || value.length > 128) {
    throw new Error('Password must be between 4 and 128 characters.');
  }
  const salt = randomBytes(16);
  const derived = scryptSync(value, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = scryptSync(String(password || ''), salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function signShortenerCallback(sessionId, secret) {
  return createHmac('sha256', secret).update(`${sessionId}:completed`).digest('hex');
}

export function verifyShortenerCallback(sessionId, signature, secret) {
  if (!/^[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  const expected = Buffer.from(signShortenerCallback(sessionId, secret), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
