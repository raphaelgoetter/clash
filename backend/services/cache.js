// ============================================================
// Simple in-memory TTL cache
// ============================================================

const store = new Map(); // key → { value, expiresAt }

/**
 * Get a cached value, or compute + store it if missing/expired.
 *
 * @param {string}   key
 * @param {Function} fn       - async factory: () => Promise<value>
 * @param {number}   ttlMs    - time-to-live in milliseconds (default: 15 min)
 * @returns {Promise<{ value: any, fromCache: boolean }>}
 */
export async function getOrSet(key, fn, ttlMs = 15 * 60 * 1000) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return { value: hit.value, fromCache: true };
  }
  const value = await fn();
  store.set(key, { value, expiresAt: now + ttlMs });
  return { value, fromCache: false };
}

/** Manually invalidate a cache entry (useful for tests). */
export function invalidate(key) {
  store.delete(key);
}

/** Purge all expired entries (call periodically to avoid memory leak). */
export function purgeExpired() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

// Auto-purge every 10 minutes
setInterval(purgeExpired, 10 * 60 * 1000).unref();
