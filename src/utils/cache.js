const cache = new Map();
const inflight = new Map();
const MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 60_000;

export function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { cache.delete(key); return undefined; }
  cache.delete(key);
  cache.set(key, entry); // LRU refresh
  return entry.value;
}
export function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + Math.max(1, ttlMs) });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}
export function cacheDeletePrefix(prefix) {
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
  for (const key of inflight.keys()) if (key.startsWith(prefix)) inflight.delete(key);
}
export async function cached(key, ttlMs, loader) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const pending = Promise.resolve().then(loader).then(value => cacheSet(key, value, ttlMs))
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}
export function cacheStats() { return { entries: cache.size, inflight: inflight.size, maxEntries: MAX_ENTRIES }; }
export function clearCache() { cache.clear(); inflight.clear(); }
