import { createHash, randomBytes } from 'node:crypto';
import { assertPublicHttpsUrl, decryptShortenerApiKey, getShortenerProviderById } from './shortener-repository.js';

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validHttpsUrl(value) {
  const url = new URL(value);
  assertPublicHttpsUrl(url);
  return url.toString();
}

function getNestedValue(obj, path) {
  if (!obj || typeof obj !== 'object' || !path) return undefined;
  let current = obj;
  for (const part of String(path).split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function parseReturnedHttpUrl(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

export function extractShortenedUrl(responseText, provider = {}) {
  const body = String(responseText ?? '').trim();
  if (!body) throw new Error('Shortener API returned an empty response.');

  if (provider.response_format === 'text') {
    const firstLine = body.split(/\r?\n/)[0]?.trim() ?? '';
    const url = parseReturnedHttpUrl(firstLine);
    if (!url) throw new Error('Shortener text response did not contain a valid URL.');
    return url;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    const plain = parseReturnedHttpUrl(body.split(/\r?\n/)[0]?.trim() ?? '');
    if (plain) return plain;
    throw new Error('Shortener API returned non-JSON response: ' + body.slice(0, 120));
  }

  if (parsed && typeof parsed === 'object') {
    if (String(parsed.status ?? '').toLowerCase() === 'error') {
      const msg = Array.isArray(parsed.message) ? parsed.message.join(', ') : (parsed.message || parsed.error || 'Unknown shortener error');
      throw new Error(String(msg).slice(0, 200));
    }

    const candidatePaths = [
      provider.response_url_path,
      'shortenedUrl',
      'shorturl',
      'short_url',
      'url',
      'link',
      'data.shortenedUrl',
      'data.shorturl',
      'data.url',
      'data.link',
    ].filter(Boolean);

    for (const path of candidatePaths) {
      const val = getNestedValue(parsed, path);
      const url = parseReturnedHttpUrl(val);
      if (url) return url;
    }

    if (parsed.message) {
      const msg = Array.isArray(parsed.message) ? parsed.message.join(', ') : parsed.message;
      throw new Error('Shortener API rejected request: ' + String(msg).slice(0, 180));
    }
  }

  throw new Error('Shortener response missing shortened URL field.');
}

export async function getCheckpointRequirement(pool, userId, ownerId = null) {
  let providers;
  let state;
  if (ownerId !== null && ownerId !== undefined) {
    providers = await pool.query(
      `SELECT id, name, base_url, api_endpoint, api_key_ciphertext, api_key_param, target_url_param,
              response_url_path, response_format, checkpoint_minutes, priority, verification_mode
       FROM shortener_providers WHERE is_enabled = TRUE AND owner_telegram_id = $1 ORDER BY priority ASC, id ASC`,
      [Number(ownerId)],
    );
    if (!providers.rowCount) return { required: false, reason: 'no_active_providers' };
    state = await pool.query(
      'SELECT last_provider_id, checkpoint_expires_at FROM creator_checkpoint_states WHERE user_telegram_id = $1 AND owner_telegram_id = $2',
      [userId, Number(ownerId)],
    );
  } else {
    providers = await pool.query(
      `SELECT id, name, base_url, api_endpoint, api_key_ciphertext, api_key_param, target_url_param,
              response_url_path, response_format, checkpoint_minutes, priority, verification_mode
       FROM shortener_providers WHERE is_enabled = TRUE AND owner_telegram_id IS NULL ORDER BY priority ASC, id ASC`,
    );
    if (!providers.rowCount) return { required: false, reason: 'no_active_providers' };
    state = await pool.query(
      'SELECT last_provider_id, checkpoint_expires_at FROM user_checkpoint_state WHERE user_telegram_id = $1',
      [userId],
    );
  }

  if (state.rowCount && state.rows[0].checkpoint_expires_at && new Date(state.rows[0].checkpoint_expires_at) > new Date()) {
    return { required: false, reason: 'checkpoint_active', expiresAt: state.rows[0].checkpoint_expires_at };
  }

  // Rotate only across configured providers; an unverified provider must not
  // block other providers that are ready to serve checkpoint links.
  const eligible = providers.rows.filter((provider) => provider.verification_mode === 'provider_api');
  if (!eligible.length) {
    const first = providers.rows[0];
    return {
      required: true,
      blocked: true,
      reason: 'provider_verification_not_supported',
      provider: first ? { id: first.id, name: first.name } : null,
      candidates: [],
      step: 0,
      total: 0,
    };
  }

  let nextIndex = 0;
  const lastId = state.rows[0]?.last_provider_id;
  if (lastId !== null && lastId !== undefined) {
    const index = eligible.findIndex((provider) => Number(provider.id) === Number(lastId));
    if (index >= 0) nextIndex = (index + 1) % eligible.length;
  }
  const orderedCandidates = [
    ...eligible.slice(nextIndex),
    ...eligible.slice(0, nextIndex),
  ];
  return {
    required: true,
    provider: orderedCandidates[0],
    candidates: orderedCandidates,
    step: nextIndex + 1,
    total: eligible.length,
  };
}
export async function createCheckpointSession(pool, userId, providerId, destinationUrl, customToken = null) {
  const destination = validHttpsUrl(destinationUrl);
  const token = customToken ?? randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const { rows } = await pool.query(
    `INSERT INTO checkpoint_sessions (user_telegram_id, provider_id, verification_token, destination_url, status, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id, provider_id, expires_at`,
    [userId, providerId, tokenHash, destination, expiresAt],
  );
  return { session: rows[0], token };
}

export async function shortenUrlWithProvider(provider, targetUrl, apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error(`Shortener "${provider.name}" has no API key configured.`);
  const built = buildShortenerApiRequest(provider, targetUrl, apiKey);
  const response = await fetchImpl(built.url, {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(10000),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    try {
      extractShortenedUrl(bodyText, provider);
    } catch (innerError) {
      throw new Error(`HTTP ${response.status}: ${innerError.message}`);
    }
    throw new Error(`Shortener HTTP ${response.status}`);
  }
  const shortUrl = extractShortenedUrl(bodyText, provider);
  return { shortUrl, responseFormat: built.responseFormat };
}

export async function createCheckpointChallenge(pool, config, userId, providerInput, botUsername, fetchImpl = fetch) {
  const cleanBot = String(botUsername ?? '').replace(/^@+/, '').trim();
  if (!cleanBot) throw new Error('Delivery Bot username is required to create a verification callback link.');

  const provider = providerInput?.api_endpoint && providerInput?.api_key_ciphertext
    ? providerInput
    : await getShortenerProviderById(pool, providerInput?.id ?? providerInput);
  if (!provider) throw new Error('Shortener provider not found.');
  if (provider.verification_mode === 'unverified') {
    throw new Error(`Shortener "${provider.name}" has verification disabled.`);
  }

  const apiKey = decryptShortenerApiKey(provider, config?.tokenEncryptionKey);
  if (!apiKey) throw new Error(`Shortener "${provider.name}" does not have an API key set.`);

  const token = randomBytes(32).toString('base64url');
  const destinationUrl = validHttpsUrl(`https://t.me/${cleanBot}?start=chk_${token}`);
  const { session } = await createCheckpointSession(pool, userId, provider.id, destinationUrl, token);

  try {
    const { shortUrl } = await shortenUrlWithProvider(provider, destinationUrl, apiKey, fetchImpl);
    return { shortUrl, destinationUrl, session, provider };
  } catch (error) {
    await pool.query("UPDATE checkpoint_sessions SET status = 'failed' WHERE id = $1", [session.id]).catch(() => {});
    throw error;
  }
}

// Must only be called by a provider-specific verification adapter after server-side proof.
export async function applyVerifiedCheckpoint(pool, token, verifiedBy) {
  if (verifiedBy !== 'provider_api') throw new Error('Untrusted checkpoint verification method.');
  const tokenHash = hashToken(String(token));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query(
      `SELECT s.id, s.user_telegram_id, s.provider_id, s.status, s.expires_at,
              p.checkpoint_minutes, p.name AS provider_name, p.owner_telegram_id
       FROM checkpoint_sessions s JOIN shortener_providers p ON p.id = s.provider_id
       WHERE s.verification_token = $1 FOR UPDATE`,
      [tokenHash],
    );
    if (!sessionResult.rowCount) throw new Error('Checkpoint session not found.');
    const session = sessionResult.rows[0];
    if (session.status !== 'pending') throw new Error('Checkpoint session is no longer pending.');
    if (new Date(session.expires_at) <= new Date()) {
      await client.query("UPDATE checkpoint_sessions SET status = 'expired' WHERE id = $1", [session.id]);
      await client.query('COMMIT');
      throw new Error('Checkpoint session expired.');
    }
    const expiresAt = new Date(Date.now() + Number(session.checkpoint_minutes) * 60 * 1000);
    await client.query("UPDATE checkpoint_sessions SET status = 'verified', verified_at = NOW() WHERE id = $1", [session.id]);
    if (session.owner_telegram_id !== null && session.owner_telegram_id !== undefined) {
      await client.query(
        `INSERT INTO creator_checkpoint_states (user_telegram_id, owner_telegram_id, last_provider_id, checkpoint_expires_at, completed_count)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (user_telegram_id, owner_telegram_id) DO UPDATE SET last_provider_id = EXCLUDED.last_provider_id,
           checkpoint_expires_at = EXCLUDED.checkpoint_expires_at,
           completed_count = creator_checkpoint_states.completed_count + 1, updated_at = NOW()`,
        [session.user_telegram_id, Number(session.owner_telegram_id), session.provider_id, expiresAt],
      );
    } else {
      await client.query(
        `INSERT INTO user_checkpoint_state (user_telegram_id, last_provider_id, checkpoint_expires_at, completed_count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (user_telegram_id) DO UPDATE SET last_provider_id = EXCLUDED.last_provider_id,
           checkpoint_expires_at = EXCLUDED.checkpoint_expires_at,
           completed_count = user_checkpoint_state.completed_count + 1, updated_at = NOW()`,
        [session.user_telegram_id, session.provider_id, expiresAt],
      );
    }
    await client.query('COMMIT');
    return {
      userId: session.user_telegram_id,
      providerId: session.provider_id,
      providerName: session.provider_name,
      ownerTelegramId: session.owner_telegram_id ?? null,
      checkpointMinutes: Number(session.checkpoint_minutes),
      expiresAt,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function expireCheckpointSessions(pool) {
  const result = await pool.query(
    "UPDATE checkpoint_sessions SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW() RETURNING id",
  );
  return result.rowCount;
}

export function buildShortenerApiRequest(provider, targetUrl, apiKey) {
  const endpoint = validHttpsUrl(provider.api_endpoint);
  const params = new URL(endpoint);
  if (apiKey) params.searchParams.set(provider.api_key_param || 'api', apiKey);
  params.searchParams.set(provider.target_url_param || 'url', validHttpsUrl(targetUrl));
  return { url: params.toString(), responseUrlPath: provider.response_url_path, responseFormat: provider.response_format };
}
