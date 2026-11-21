import { encryptBotToken, decryptBotToken } from '../security/token-encryption.js';

export function assertPublicHttpsUrl(urlObj) {
  if (!urlObj || urlObj.protocol !== 'https:') {
    throw new Error('URL must use HTTPS.');
  }
  const host = String(urlObj.hostname ?? '').toLowerCase();
  if (
    !host ||
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host === '[::1]' ||
    host.startsWith('[::ffff:') ||
    host.startsWith('[fe80:') ||
    host.startsWith('[fc') ||
    host.startsWith('[fd')
  ) {
    throw new Error('Private or loopback shortener URLs are not allowed.');
  }
}

export function normalizeShortenerUrls(baseUrlRaw, apiEndpointRaw = null) {
  const rawBase = String(baseUrlRaw ?? '').trim();
  if (!rawBase) throw new Error('Base URL is required.');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawBase) && !/^https:\/\//i.test(rawBase)) {
    throw new Error('Base URL must use HTTPS.');
  }
  const withScheme = /^https:\/\//i.test(rawBase) ? rawBase : `https://${rawBase}`;
  let parsedBase;
  try {
    parsedBase = new URL(withScheme);
  } catch {
    throw new Error('Invalid Base URL format.');
  }
  if (parsedBase.protocol !== 'https:' || !parsedBase.hostname || !parsedBase.hostname.includes('.')) {
    throw new Error('Base URL must be a valid HTTPS domain (e.g. https://shrinkme.io).');
  }
  assertPublicHttpsUrl(parsedBase);

  let parsedEndpoint;
  if (apiEndpointRaw !== null && apiEndpointRaw !== undefined && String(apiEndpointRaw).trim() !== '') {
    const rawEp = String(apiEndpointRaw).trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawEp) && !/^https:\/\//i.test(rawEp)) {
      throw new Error('API endpoint must use HTTPS.');
    }
    const epWithScheme = /^https:\/\//i.test(rawEp) ? rawEp : `https://${rawEp}`;
    try {
      parsedEndpoint = new URL(epWithScheme);
    } catch {
      throw new Error('Invalid API endpoint URL.');
    }
    if (parsedEndpoint.protocol !== 'https:') throw new Error('API endpoint must use HTTPS.');
    assertPublicHttpsUrl(parsedEndpoint);
  } else {
    const cleanPath = parsedBase.pathname.replace(/\/+$/, '');
    const endpointPath = cleanPath ? cleanPath : '/api';
    parsedEndpoint = new URL(`${parsedBase.origin}${endpointPath}${parsedBase.search}`);
  }

  return {
    baseUrl: parsedBase.origin,
    apiEndpoint: parsedEndpoint.toString(),
    hostname: parsedBase.hostname.toLowerCase(),
  };
}

function looksLikeUrlOrDomain(value) {
  const s = String(value ?? '').trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(\/.*)?$/.test(s);
}

export function deriveUniqueShortenerName(hostname, existingProviders = []) {
  const existingNames = new Set(existingProviders.map((p) => String(p.name ?? '').trim().toLowerCase()));
  if (!existingNames.has(hostname.toLowerCase())) return hostname;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${hostname} #${i}`;
    if (!existingNames.has(candidate.toLowerCase())) return candidate;
  }
  return `${hostname} #${Date.now()}`;
}

export function parseShortenerInput(rawText, existingProviders = []) {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) throw new Error('Shortener details cannot be empty.');

  const fields = trimmed.includes('|')
    ? trimmed.split('|').map((v) => v.trim())
    : trimmed.split(/\s+/).filter(Boolean);

  if (fields.length === 11 && trimmed.includes('|')) {
    const [
      name,
      baseUrlRaw,
      apiEndpointRaw,
      apiKey,
      durationRaw,
      priorityRaw,
      apiKeyParam,
      targetUrlParam,
      responseUrlPath,
      responseFormat,
      verificationMode,
    ] = fields;
    if (!name || name.length > 80) throw new Error('Provider name must be 1–80 characters.');
    const urls = normalizeShortenerUrls(baseUrlRaw, apiEndpointRaw);
    const checkpointMinutes = Number(durationRaw);
    const priority = Number(priorityRaw);
    if (!Number.isInteger(checkpointMinutes) || checkpointMinutes < 1 || checkpointMinutes > 10080) {
      throw new Error('Checkpoint duration must be 1–10080 minutes.');
    }
    if (!Number.isInteger(priority) || priority < 1 || priority > 100000) {
      throw new Error('Priority must be 1–100000.');
    }
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(apiKeyParam) || !/^[a-zA-Z0-9_-]{1,50}$/.test(targetUrlParam)) {
      throw new Error('API key and URL parameter names are invalid.');
    }
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(responseUrlPath)) {
      throw new Error('Response URL field is invalid.');
    }
    if (!['json', 'text'].includes(responseFormat)) {
      throw new Error('Response format must be json or text.');
    }
    if (!['unverified', 'callback', 'provider_api'].includes(verificationMode)) {
      throw new Error('Verification mode must be unverified, callback, or provider_api.');
    }
    return {
      name,
      baseUrl: urls.baseUrl,
      apiEndpoint: urls.apiEndpoint,
      apiKey,
      apiKeyParam,
      targetUrlParam,
      responseUrlPath,
      responseFormat,
      checkpointMinutes,
      priority,
      verificationMode,
      enabled: verificationMode !== 'unverified' && Boolean(apiKey),
    };
  }

  let name = '';
  let baseUrlRaw = '';
  let apiKey = '';
  let durationRaw;
  let priorityRaw;

  if (fields.length === 2) {
    [baseUrlRaw, apiKey] = fields;
  } else if (fields.length >= 3 && fields.length <= 5) {
    if (looksLikeUrlOrDomain(fields[0]) && !looksLikeUrlOrDomain(fields[1])) {
      [baseUrlRaw, apiKey, durationRaw, priorityRaw] = fields;
    } else if (!looksLikeUrlOrDomain(fields[0]) && looksLikeUrlOrDomain(fields[1])) {
      [name, baseUrlRaw, apiKey, durationRaw, priorityRaw] = fields;
    } else {
      throw new Error('Use: base_url|api_key or name|base_url|api_key');
    }
  } else {
    throw new Error('Use: base_url|api_key or name|base_url|api_key|duration_mins(optional)|priority(optional)');
  }

  if (!apiKey || apiKey.length < 4) {
    throw new Error('API key is required (at least 4 characters).');
  }

  const urls = normalizeShortenerUrls(baseUrlRaw);
  const resolvedName = (name || deriveUniqueShortenerName(urls.hostname, existingProviders)).slice(0, 80);
  const checkpointMinutes = durationRaw !== undefined && durationRaw !== '' ? Number(durationRaw) : 1440;
  const priority = priorityRaw !== undefined && priorityRaw !== '' ? Number(priorityRaw) : 100;

  if (!Number.isInteger(checkpointMinutes) || checkpointMinutes < 1 || checkpointMinutes > 10080) {
    throw new Error('Checkpoint duration must be 1–10080 minutes.');
  }
  if (!Number.isInteger(priority) || priority < 1 || priority > 100000) {
    throw new Error('Priority must be 1–100000.');
  }

  return {
    name: resolvedName,
    baseUrl: urls.baseUrl,
    apiEndpoint: urls.apiEndpoint,
    apiKey,
    apiKeyParam: 'api',
    targetUrlParam: 'url',
    responseUrlPath: 'shortenedUrl',
    responseFormat: 'json',
    checkpointMinutes,
    priority,
    verificationMode: 'callback',
    enabled: true,
  };
}

function ownerWhere(ownerId, paramIdx) {
  if (ownerId === null || ownerId === undefined) {
    return { clause: 'owner_telegram_id IS NULL', params: [] };
  }
  return { clause: `owner_telegram_id = $${paramIdx}`, params: [Number(ownerId)] };
}

export async function listShortenerProviders(pool, ownerId = null) {
  const scope = ownerWhere(ownerId, 1);
  const { rows } = await pool.query(
    `SELECT id, name, base_url, api_endpoint, (api_key_ciphertext IS NOT NULL) AS has_api_key,
            api_key_param, target_url_param, response_url_path, response_format,
            checkpoint_minutes, priority, verification_mode, is_enabled, last_test_status, last_test_error,
            owner_telegram_id
     FROM shortener_providers WHERE ${scope.clause} ORDER BY priority ASC, id ASC LIMIT 50`,
    scope.params,
  );
  return rows;
}

export async function getShortenerProviderById(pool, id, ownerId = undefined) {
  const hasOwnerScope = ownerId !== undefined;
  const scope = hasOwnerScope ? ownerWhere(ownerId, 2) : null;
  const where = hasOwnerScope ? `id = $1 AND ${scope.clause}` : 'id = $1';
  const params = hasOwnerScope ? [id, ...scope.params] : [id];
  const { rows } = await pool.query(
    `SELECT id, name, base_url, api_endpoint, api_key_ciphertext, api_key_param, target_url_param,
            response_url_path, response_format, checkpoint_minutes, priority, verification_mode,
            is_enabled, last_test_status, last_test_error, owner_telegram_id
     FROM shortener_providers WHERE ${where} LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

export function decryptShortenerApiKey(provider, tokenEncryptionKey) {
  if (!provider?.api_key_ciphertext) return null;
  if (!tokenEncryptionKey) throw new Error('TOKEN_ENCRYPTION_KEY is required to decrypt shortener API keys.');
  return decryptBotToken(provider.api_key_ciphertext, tokenEncryptionKey);
}

export async function addShortenerProvider(pool, config, input, adminId, ownerId = null) {
  if (input.apiKey && !config?.tokenEncryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required to store shortener API keys.');
  }
  const encryptedKey = input.apiKey ? encryptBotToken(input.apiKey, config.tokenEncryptionKey) : null;
  const enabled = Boolean(input.enabled);
  const normalizedOwner = ownerId === null || ownerId === undefined ? null : Number(ownerId);
  const { rows } = await pool.query(
    `INSERT INTO shortener_providers (name, base_url, api_endpoint, api_key_ciphertext, api_key_param, target_url_param, response_url_path, response_format, checkpoint_minutes, priority, verification_mode, is_enabled, created_by, owner_telegram_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT ((COALESCE(owner_telegram_id, 0)), name) DO UPDATE SET base_url = EXCLUDED.base_url, api_endpoint = EXCLUDED.api_endpoint,
       api_key_ciphertext = EXCLUDED.api_key_ciphertext, api_key_param = EXCLUDED.api_key_param,
       target_url_param = EXCLUDED.target_url_param, response_url_path = EXCLUDED.response_url_path,
       response_format = EXCLUDED.response_format, checkpoint_minutes = EXCLUDED.checkpoint_minutes,
       priority = EXCLUDED.priority, verification_mode = EXCLUDED.verification_mode,
       is_enabled = EXCLUDED.is_enabled, last_test_status = 'unknown', last_test_error = NULL, updated_at = NOW()
     RETURNING id, name, base_url, api_endpoint, checkpoint_minutes, priority, verification_mode, is_enabled, owner_telegram_id`,
    [
      input.name,
      input.baseUrl,
      input.apiEndpoint,
      encryptedKey,
      input.apiKeyParam,
      input.targetUrlParam,
      input.responseUrlPath,
      input.responseFormat,
      input.checkpointMinutes,
      input.priority,
      input.verificationMode,
      enabled,
      adminId,
      normalizedOwner,
    ],
  );
  return rows[0];
}

export async function updateShortenerName(pool, id, name, ownerId = undefined) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.length > 80) throw new Error('Provider name must be 1–80 characters.');
  const hasOwnerScope = ownerId !== undefined;
  const scope = hasOwnerScope ? ownerWhere(ownerId, 3) : null;
  const where = hasOwnerScope ? `id = $1 AND ${scope.clause}` : 'id = $1';
  const params = hasOwnerScope ? [id, trimmed, ...scope.params] : [id, trimmed];
  try {
    const { rows } = await pool.query(
      `UPDATE shortener_providers SET name = $2, updated_at = NOW() WHERE ${where} RETURNING id, name`,
      params,
    );
    return rows[0] ?? null;
  } catch (error) {
    if (error.code === '23505') throw new Error(`Another shortener is already named "${trimmed}".`);
    throw error;
  }
}

export async function updateShortenerCredentials(pool, config, id, { baseUrl, apiEndpoint, apiKey }, ownerId = undefined) {
  if (apiKey !== undefined && !config?.tokenEncryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required to store shortener API keys.');
  }
  const updates = [];
  const params = [id];
  if (baseUrl !== undefined) {
    params.push(baseUrl);
    updates.push(`base_url = $${params.length}`);
  }
  if (apiEndpoint !== undefined) {
    params.push(apiEndpoint);
    updates.push(`api_endpoint = $${params.length}`);
  }
  if (apiKey !== undefined) {
    params.push(encryptBotToken(apiKey, config.tokenEncryptionKey));
    updates.push(`api_key_ciphertext = $${params.length}`);
  }
  if (!updates.length) return getShortenerProviderById(pool, id, ownerId);
  updates.push("last_test_status = 'unknown'", 'last_test_error = NULL', 'updated_at = NOW()');

  let where = 'id = $1';
  if (ownerId !== undefined) {
    const scope = ownerWhere(ownerId, params.length + 1);
    where = `id = $1 AND ${scope.clause}`;
    params.push(...scope.params);
  }
  const { rows } = await pool.query(
    `UPDATE shortener_providers SET ${updates.join(', ')} WHERE ${where} RETURNING id, name, base_url, api_endpoint, is_enabled`,
    params,
  );
  return rows[0] ?? null;
}

export async function setShortenerEnabled(pool, id, enabled, ownerId = undefined) {
  const hasOwnerScope = ownerId !== undefined;
  const scope = hasOwnerScope ? ownerWhere(ownerId, 3) : null;
  const where = hasOwnerScope ? `id = $1 AND ${scope.clause}` : 'id = $1';
  const params = hasOwnerScope ? [id, enabled, ...scope.params] : [id, enabled];
  const { rows } = await pool.query(
    `UPDATE shortener_providers
     SET is_enabled = $2,
         verification_mode = CASE WHEN $2 = TRUE AND verification_mode = 'unverified' THEN 'callback' ELSE verification_mode END,
         updated_at = NOW()
     WHERE ${where}
     RETURNING id, name, verification_mode, is_enabled`,
    params,
  );
  return rows[0] ?? null;
}

export async function setShortenerDuration(pool, id, minutes, ownerId = undefined) {
  const hasOwnerScope = ownerId !== undefined;
  const scope = hasOwnerScope ? ownerWhere(ownerId, 3) : null;
  const where = hasOwnerScope ? `id = $1 AND ${scope.clause}` : 'id = $1';
  const params = hasOwnerScope ? [id, minutes, ...scope.params] : [id, minutes];
  const { rows } = await pool.query(
    `UPDATE shortener_providers SET checkpoint_minutes = $2, updated_at = NOW() WHERE ${where} RETURNING id, name, checkpoint_minutes`,
    params,
  );
  return rows[0] ?? null;
}

export async function setShortenerPriority(pool, id, priority, ownerId = undefined) {
  const hasOwnerScope = ownerId !== undefined;
  const scope = hasOwnerScope ? ownerWhere(ownerId, 3) : null;
  const where = hasOwnerScope ? `id = $1 AND ${scope.clause}` : 'id = $1';
  const params = hasOwnerScope ? [id, priority, ...scope.params] : [id, priority];
  const { rows } = await pool.query(
    `UPDATE shortener_providers SET priority = $2, updated_at = NOW() WHERE ${where} RETURNING id, name, priority`,
    params,
  );
  return rows[0] ?? null;
}

export async function removeShortenerProvider(pool, id, ownerId = undefined) {
  const existing = await getShortenerProviderById(pool, id, ownerId);
  if (!existing) return { removed: false, reason: 'not_found' };

  await pool.query(
    "UPDATE checkpoint_sessions SET status = 'expired' WHERE provider_id = $1 AND status = 'pending' AND expires_at <= NOW()",
    [id],
  ).catch(() => {});

  const pendingCheck = await pool.query(
    "SELECT 1 FROM checkpoint_sessions WHERE provider_id = $1 AND status = 'pending' LIMIT 1",
    [id],
  ).catch(() => ({ rowCount: 0 }));
  if (pendingCheck.rowCount > 0) {
    return { removed: false, reason: 'pending_sessions' };
  }

  await pool.query(
    "DELETE FROM checkpoint_sessions WHERE provider_id = $1 AND status <> 'pending'",
    [id],
  ).catch(() => {});

  const hasOwnerScope = ownerId !== undefined;
  const scope = hasOwnerScope ? ownerWhere(ownerId, 2) : null;
  const ownerFilter = hasOwnerScope ? ` AND ${scope.clause}` : '';
  const params = hasOwnerScope ? [id, ...scope.params] : [id];

  try {
    const { rows } = await pool.query(
      `DELETE FROM shortener_providers WHERE id = $1${ownerFilter} AND NOT EXISTS (SELECT 1 FROM checkpoint_sessions s WHERE s.provider_id = shortener_providers.id AND s.status = 'pending') RETURNING id, name`,
      params,
    );
    return rows[0] ? { removed: true, ...rows[0] } : { removed: false, reason: 'missing_or_pending' };
  } catch (error) {
    if (error.code === '23503') {
      const disabled = await setShortenerEnabled(pool, id, false, ownerId);
      return disabled ? { removed: false, disabled: true, ...disabled } : { removed: false, reason: 'referenced' };
    }
    throw error;
  }
}

export async function markShortenerTest(pool, id, status, error = null) {
  await pool.query(
    'UPDATE shortener_providers SET last_test_status = $2, last_test_error = $3, updated_at = NOW() WHERE id = $1',
    [id, status, error?.slice(0, 500) ?? null],
  );
}

