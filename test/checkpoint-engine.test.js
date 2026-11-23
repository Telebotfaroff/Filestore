import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  buildShortenerApiRequest,
  createCheckpointSession,
  applyVerifiedCheckpoint,
  getCheckpointRequirement,
  extractShortenedUrl,
  shortenUrlWithProvider,
  createCheckpointChallenge,
} from '../src/access/checkpoint-engine.js';
import {
  normalizeShortenerUrls,
  parseShortenerInput,
} from '../src/access/shortener-repository.js';
import { encryptBotToken } from '../src/security/token-encryption.js';

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

test('callback-only providers cannot unlock checkpoint access', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM shortener_providers')) return { rowCount: 2, rows: [
        { id: 20, name: 'Callback only', verification_mode: 'callback' },
        { id: 21, name: 'Unverified', verification_mode: 'unverified' },
      ] };
      if (sql.includes('FROM user_checkpoint_state')) return { rowCount: 0, rows: [] };
      throw new Error('Unexpected query');
    },
  };
  const result = await getCheckpointRequirement(pool, 5678);
  assert.equal(result.required, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'provider_verification_not_supported');
  assert.deepEqual(result.candidates, []);
});

test('checkpoint rotation skips unverified providers and counts only eligible providers', async () => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM shortener_providers')) return { rowCount: 3, rows: [
        { id: 10, name: 'Broken verifier', verification_mode: 'unverified' },
        { id: 11, name: 'Ready A', verification_mode: 'provider_api' },
        { id: 12, name: 'Ready B', verification_mode: 'provider_api' },
      ] };
      if (sql.includes('FROM user_checkpoint_state')) return { rowCount: 1, rows: [{ last_provider_id: 11, checkpoint_expires_at: new Date(Date.now() - 1000) }] };
      throw new Error('Unexpected query');
    },
  };
  const result = await getCheckpointRequirement(pool, 1234);
  assert.equal(result.blocked, undefined);
  assert.equal(result.provider.id, 12);
  assert.deepEqual(result.candidates.map((p) => p.id), [12, 11]);
  assert.equal(result.step, 2);
  assert.equal(result.total, 2);
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
  await assert.rejects(applyVerifiedCheckpoint(pool, 'arbitrary-token', 'signed_callback'), /Untrusted checkpoint verification method/);
  assert.equal(touched, false);
});

test('parseShortenerInput handles base_url|api_key and multiple shorteners cleanly', () => {
  const first = parseShortenerInput('shrinkme.io|my_secret_api_key_1');
  assert.equal(first.name, 'shrinkme.io');
  assert.equal(first.baseUrl, 'https://shrinkme.io');
  assert.equal(first.apiEndpoint, 'https://shrinkme.io/api');
  assert.equal(first.verificationMode, 'callback');
  assert.equal(first.enabled, true);

  const duplicateHost = parseShortenerInput('https://shrinkme.io|another_key_2', [{ name: 'shrinkme.io' }]);
  assert.equal(duplicateHost.name, 'shrinkme.io #2');

  const named = parseShortenerInput('GPLinks|https://gplinks.com/api|gplink_key_99|720|5');
  assert.equal(named.name, 'GPLinks');
  assert.equal(named.baseUrl, 'https://gplinks.com');
  assert.equal(named.apiEndpoint, 'https://gplinks.com/api');
  assert.equal(named.checkpointMinutes, 720);
  assert.equal(named.priority, 5);

  assert.throws(() => normalizeShortenerUrls('http://insecure.example'), /HTTPS/);
});

test('extractShortenedUrl and shortenUrlWithProvider parse JSON and text responses', async () => {
  assert.equal(
    extractShortenedUrl('{"status":"success","shortenedUrl":"https://shrinkme.io/abc"}', { response_url_path: 'shortenedUrl', response_format: 'json' }),
    'https://shrinkme.io/abc',
  );
  assert.equal(
    extractShortenedUrl('{"data":{"url":"https://short.io/xyz"}}', { response_url_path: 'shortenedUrl', response_format: 'json' }),
    'https://short.io/xyz',
  );
  assert.equal(
    extractShortenedUrl('https://tiny.one/test123\n', { response_url_path: 'shortenedUrl', response_format: 'text' }),
    'https://tiny.one/test123',
  );
  assert.throws(
    () => extractShortenedUrl('{"status":"error","message":"Invalid API key"}', { response_format: 'json' }),
    /Invalid API key/,
  );

  let calledUrl;
  const fakeFetch = async (url) => {
    calledUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'success', shortenedUrl: 'https://shrinkme.io/ok' }),
    };
  };
  const provider = {
    name: 'ShrinkMe',
    api_endpoint: 'https://shrinkme.io/api',
    api_key_param: 'api',
    target_url_param: 'url',
    response_url_path: 'shortenedUrl',
    response_format: 'json',
  };
  const res = await shortenUrlWithProvider(provider, 'https://t.me/TestBot?start=chk_123', 'key_abc', fakeFetch);
  assert.equal(res.shortUrl, 'https://shrinkme.io/ok');
  const parsedCalled = new URL(calledUrl);
  assert.equal(parsedCalled.searchParams.get('api'), 'key_abc');
  assert.equal(parsedCalled.searchParams.get('url'), 'https://t.me/TestBot?start=chk_123');
});

test('createCheckpointChallenge decrypts API key, persists session hash, and calls shortener API', async () => {
  const tokenEncryptionKey = randomBytes(32).toString('base64');
  const encrypted = encryptBotToken('live_api_key_777', tokenEncryptionKey);
  const queries = [];
  const pool = {
    query: async (sql, args) => {
      queries.push({ sql, args });
      if (sql.includes('INSERT INTO checkpoint_sessions')) {
        return { rows: [{ id: 88, provider_id: 9, expires_at: new Date(Date.now() + 1800000) }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const provider = {
    id: 9,
    name: 'ShrinkMe',
    base_url: 'https://shrinkme.io',
    api_endpoint: 'https://shrinkme.io/api',
    api_key_ciphertext: encrypted,
    api_key_param: 'api',
    target_url_param: 'url',
    response_url_path: 'shortenedUrl',
    response_format: 'json',
    checkpoint_minutes: 1440,
    verification_mode: 'callback',
  };
  const fakeFetch = async (url) => {
    const req = new URL(url);
    assert.equal(req.searchParams.get('api'), 'live_api_key_777');
    assert.match(req.searchParams.get('url'), /^https:\/\/t\.me\/FileDeliveryBot\?start=chk_[A-Za-z0-9_-]{40,}$/);
    return { ok: true, status: 200, text: async () => JSON.stringify({ shortenedUrl: 'https://shrinkme.io/verified' }) };
  };
  const challenge = await createCheckpointChallenge(pool, { tokenEncryptionKey }, 555, provider, '@FileDeliveryBot', fakeFetch);
  assert.equal(challenge.shortUrl, 'https://shrinkme.io/verified');
  assert.match(challenge.destinationUrl, /^https:\/\/t\.me\/FileDeliveryBot\?start=chk_/);
  assert.equal(queries.length, 1);
});
