import { randomBytes } from 'node:crypto';

export function createFileCode() {
  return randomBytes(5).toString('hex').toUpperCase();
}
