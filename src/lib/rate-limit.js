/**
 * Sliding-window rate limiter held in memory.
 *
 * It is per process: behind several instances each one counts on its own, so the real limit is
 * (limit x instances). Account lockout (in the database) is the shared defence for passwords.
 */
export function createLimiter({ now = () => Date.now(), enabled = true } = {}) {
  const buckets = new Map(); // key -> { hits: number[], windowMs }
  let lastSweep = now();

  function sweep(t) {
    if (t - lastSweep < 60_000) return;
    lastSweep = t;
    for (const [key, b] of buckets) {
      if (b.hits.length === 0 || t - b.hits[b.hits.length - 1] > b.windowMs) buckets.delete(key);
    }
  }

  return {
    enabled,
    /** Counts one hit. Returns { allowed, remaining, retryAfterMs }. */
    hit(key, { limit, windowMs }) {
      if (!enabled) return { allowed: true, remaining: limit, retryAfterMs: 0 };
      const t = now();
      sweep(t);
      let b = buckets.get(key);
      if (!b) {
        b = { hits: [], windowMs };
        buckets.set(key, b);
      }
      b.windowMs = windowMs;
      while (b.hits.length && t - b.hits[0] >= windowMs) b.hits.shift();
      if (b.hits.length >= limit) {
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, windowMs - (t - b.hits[0])) };
      }
      b.hits.push(t);
      return { allowed: true, remaining: limit - b.hits.length, retryAfterMs: 0 };
    },
    /** Forget a key (after a successful login, for example). */
    reset(key) {
      buckets.delete(key);
    },
    size: () => buckets.size,
  };
}
