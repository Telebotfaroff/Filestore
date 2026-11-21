const cache = new Map();
const inflight = new Map();
const generations = new Map();
const MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 60_000;

export function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { cache.delete(key); return undefined; }
  cache.delete(key);
  cache.set(key, entry);
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
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) {
      generations.set(key, (generations.get(key) ?? 0) + 1);
      inflight.delete(key);
    }
  }
}
export async function cached(key, ttlMs, loader) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const generation = generations.get(key) ?? 0;
  const pending = Promise.resolve().then(loader).then(value => {
    if ((generations.get(key) ?? 0) === generation) cacheSet(key, value, ttlMs);
    return value;
  }).finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}
export function cacheStats() { return { entries: cache.size, inflight: inflight.size, maxEntries: MAX_ENTRIES }; }
export function clearCache() {
  cache.clear();
  for (const key of inflight.keys()) generations.set(key, (generations.get(key) ?? 0) + 1);
  inflight.clear();
}
