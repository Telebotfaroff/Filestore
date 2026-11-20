import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env.js';
const valid = {
  NODE_ENV: 'test', LOG_LEVEL: 'silent', MAIN_BOT_TOKEN: '123:TEST_TOKEN',
  DATABASE_URL: 'postgres://test:test@localhost:5432/filestore', TOKEN_ENCRYPTION_KEY: '', ADMIN_IDS: '12345,67890,12345',
};
test('loads config and deduplicates admin IDs', () => {
  const config = loadConfig(valid);
  assert.equal(config.nodeEnv, 'test');
  assert.deepEqual(config.adminIds, [12345, 67890]);
});
test('rejects missing required values', () => {
  assert.throws(() => loadConfig({ ...valid, MAIN_BOT_TOKEN: '' }), /Invalid FileStore configuration/);
});
test('rejects malformed admin IDs', () => {
  assert.throws(() => loadConfig({ ...valid, ADMIN_IDS: '123,abc' }), /numeric Telegram user IDs/);
});
