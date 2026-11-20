import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildShortenerApiRequest, createCheckpointSession, applyVerifiedCheckpoint, getCheckpointRequirement } from '../src/access/checkpoint-engine.js';

test('builds API request using configured parameter names without unsafe protocols', () => {
  const provider = {
    api_endpoint: 'https://short.example/api',
    api_key_param: 'key',
    target_url_param: 'url',
    response_url_path: 'data.link',
    response_format: 'json',
  };
  const built = buildShortenerApiRequest(provider, 'https://target.example/file', 'secret');
  const parsed = new URL(built.url);
  assert.equal(parsed.searchParams.get('key'), 'secret');
  assert.equal(parsed.searchParams.get('url'), 'https://target.example/file');
  assert.equal(built.responseUrlPath, 'data.link');
  assert.equal(built.responseFormat, 'json');
  assert.throws(() => buildShortenerApiRequest(provider, 'http://unsafe.example', 'secret'), /HTTPS/);
  assert.throws(() => buildShortenerApiRequest({ ...provider, api_endpoint: 'http://short.example/api' }, 'https://target.example', 'secret'), /HTTPS/);
});

test('checkpoint provider remains blocked until a verifier is configured', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM shortener_providers')) return { rowCount: 1, rows: [{ id: 4, name: 'Sample', base_url: 'https://short.example', checkpoint_minutes: 60, priority: 10, verification_mode: 'unverified' }] };
      if (sql.includes('FROM user_checkpoint_state')) return { rowCount: 0, rows: [] };
      throw new Error('Unexpected query');
    },
  };
  const result = await getCheckpointRequirement(pool, 1234);
  assert.equal(result.required, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'provider_verification_not_configured');
});

test('active checkpoint grants access until expiry', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM shortener_providers')) return { rowCount: 2, rows: [{ id: 4, name: 'A', verification_mode: 'provider_api' }, { id: 5, name: 'B', verification_mode: 'callback' }] };
      if (sql.includes('FROM user_checkpoint_state')) return { rowCount: 1, rows: [{ last_provider_id: 4, checkpoint_expires_at: new Date(Date.now() + 60_000) }] };
      throw new Error('Unexpected query');
    },
  };
  const result = await getCheckpointRequirement(pool, 1234);
  assert.equal(result.required, false);
  assert.equal(result.reason, 'checkpoint_active');
});

test('expired checkpoint advances to the next provider in priority order', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM shortener_providers')) return { rowCount: 2, rows: [{ id: 4, name: 'A', verification_mode: 'provider_api' }, { id: 5, name: 'B', verification_mode: 'callback' }] };
      if (sql.includes('FROM user_checkpoint_state')) return { rowCount: 1, rows: [{ last_provider_id: 4, checkpoint_expires_at: new Date(Date.now() - 60_000) }] };
      throw new Error('Unexpected query');
    },
  };
  const result = await getCheckpointRequirement(pool, 1234);
  assert.equal(result.required, true);
  assert.equal(result.provider.id, 5);
  assert.equal(result.step, 2);
  assert.equal(result.total, 2);
});

test('checkpoint sessions store only a token hash and accept HTTPS destinations', async () => {
  let insertArgs;
  const pool = {
    query: async (sql, args) => {
      assert.match(sql, /INSERT INTO checkpoint_sessions/);
      insertArgs = args;
      return { rows: [{ id: 12, provider_id: 4, expires_at: new Date(Date.now() + 1800000) }] };
    },
  };
  const created = await createCheckpointSession(pool, 1234, 4, 'https://example.org/file?id=1');
  assert.equal(created.session.id, 12);
  assert.match(created.token, /^[A-Za-z0-9_-]{40,}$/);
  const storedHash = createHash('sha256').update(created.token).digest('hex');
  assert.equal(insertArgs[2], storedHash);
  assert.notEqual(insertArgs[2], created.token);
  assert.equal(insertArgs[3], 'https://example.org/file?id=1');
});

test('checkpoint session creation rejects non-HTTPS destination before database writes', async () => {
  let touched = false;
  const pool = { query: async () => { touched = true; throw new Error('should not be called'); } };
  await assert.rejects(createCheckpointSession(pool, 1234, 4, 'http://unsafe.example'), /HTTPS/);
  assert.equal(touched, false);
});

test('checkpoint credit rejects untrusted verifier names before database access', async () => {
  let touched = false;
  const pool = { connect: async () => { touched = true; throw new Error('should not be called'); } };
  await assert.rejects(applyVerifiedCheckpoint(pool, 'arbitrary-token', 'manual'), /Untrusted checkpoint verification method/);
  assert.equal(touched, false);
});
