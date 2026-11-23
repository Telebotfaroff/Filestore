import test from 'node:test';
import assert from 'node:assert/strict';
import { getClientIp, isRateLimited, recordAuthFailure } from '../src/web/http-utils.js';

test('getClientIp uses the rightmost valid forwarded IP and falls back to socket address', () => {
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': 'spoofed, 203.0.113.25, 198.51.100.9' }, socket: { remoteAddress: '127.0.0.1' } }), '198.51.100.9');
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': 'invalid, values' }, socket: { remoteAddress: '2001:db8::1' } }), '2001:db8::1');
  assert.equal(getClientIp({ headers: {}, socket: {} }), 'unknown');
});

test('auth rate-limit map remains bounded and still rate-limits recent IPs', () => {
  const prefix = 'http-utils-cap-test-';
  for (let i = 0; i <= 1000; i += 1) {
    const ip = `10.${Math.floor(i / 65536)}.${Math.floor((i % 65536) / 256)}.${i % 256}`;
    for (let failure = 0; failure < 20; failure += 1) recordAuthFailure(prefix + ip);
  }
  assert.equal(isRateLimited(prefix + '10.0.0.0'), false);
  assert.equal(isRateLimited(prefix + '10.0.3.232'), true);
});
