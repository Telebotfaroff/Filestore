import { createHash, randomBytes } from 'node:crypto';

export function createToken(prefix = '') {
  const token = randomBytes(24).toString('base64url');
  return { token, tokenHash: hashToken(token), payload: `${prefix}_${token}` };
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function parsePayload(payload = '') {
  const match = /^(F|B)_([A-Za-z0-9_-]{20,80})$/.exec(payload);
  if (!match) return null;
  return { type: match[1], token: match[2], tokenHash: hashToken(match[2]) };
}
