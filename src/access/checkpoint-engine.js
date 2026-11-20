import { createHash, randomBytes } from 'node:crypto';

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validHttpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Destination must be HTTPS.');
  return url.toString();
}

export async function getCheckpointRequirement(pool, userId) {
  const providers = await pool.query(
    `SELECT id, name, base_url, checkpoint_minutes, priority, verification_mode
     FROM shortener_providers WHERE is_enabled = TRUE ORDER BY priority ASC, id ASC`,
  );
  if (!providers.rowCount) return { required: false, reason: 'no_active_providers' };

  const state = await pool.query(
    'SELECT last_provider_id, checkpoint_expires_at FROM user_checkpoint_state WHERE user_telegram_id = $1',
    [userId],
  );
  if (state.rowCount && state.rows[0].checkpoint_expires_at && new Date(state.rows[0].checkpoint_expires_at) > new Date()) {
    return { required: false, reason: 'checkpoint_active', expiresAt: state.rows[0].checkpoint_expires_at };
  }

  let nextIndex = 0;
  const lastId = state.rows[0]?.last_provider_id;
  if (lastId !== null && lastId !== undefined) {
    const index = providers.rows.findIndex((provider) => Number(provider.id) === Number(lastId));
    if (index >= 0) nextIndex = (index + 1) % providers.rows.length;
  }
  const provider = providers.rows[nextIndex];
  if (provider.verification_mode === 'unverified') {
    return { required: true, blocked: true, reason: 'provider_verification_not_configured', provider: { id: provider.id, name: provider.name } };
  }
  return { required: true, provider, step: nextIndex + 1, total: providers.rowCount };
}

export async function createCheckpointSession(pool, userId, providerId, destinationUrl) {
  const destination = validHttpsUrl(destinationUrl);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const { rows } = await pool.query(
    `INSERT INTO checkpoint_sessions (user_telegram_id, provider_id, verification_token, destination_url, status, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id, provider_id, expires_at`,
    [userId, providerId, tokenHash, destination, expiresAt],
  );
  return { session: rows[0], token };
}

// Must only be called by a provider-specific verification adapter after server-side proof.
export async function applyVerifiedCheckpoint(pool, token, verifiedBy) {
  if (!['provider_api', 'signed_callback'].includes(verifiedBy)) throw new Error('Untrusted checkpoint verification method.');
  const tokenHash = hashToken(String(token));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query(
      `SELECT s.id, s.user_telegram_id, s.provider_id, s.status, s.expires_at, p.checkpoint_minutes
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
    await client.query(
      `INSERT INTO user_checkpoint_state (user_telegram_id, last_provider_id, checkpoint_expires_at, completed_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (user_telegram_id) DO UPDATE SET last_provider_id = EXCLUDED.last_provider_id,
         checkpoint_expires_at = EXCLUDED.checkpoint_expires_at,
         completed_count = user_checkpoint_state.completed_count + 1, updated_at = NOW()`,
      [session.user_telegram_id, session.provider_id, expiresAt],
    );
    await client.query('COMMIT');
    return { userId: session.user_telegram_id, providerId: session.provider_id, expiresAt };
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
  if (apiKey) params.searchParams.set(provider.api_key_param, apiKey);
  params.searchParams.set(provider.target_url_param, validHttpsUrl(targetUrl));
  return { url: params.toString(), responseUrlPath: provider.response_url_path, responseFormat: provider.response_format };
}
