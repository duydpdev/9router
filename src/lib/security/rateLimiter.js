// In-memory sliding-window rate limiter. Keyed by arbitrary string (IP or
// ip:key). Resets on process restart; single-instance only (multi-instance
// would need a shared store — intentionally out of scope, documented).

const buckets = new Map(); // key → number[] (hit timestamps within the window)

// Hard cap on distinct keys. A spoofed-XFF flood can otherwise create one
// bucket per fake IP; insertion-order eviction keeps memory + sweep bounded.
const MAX_KEYS = 50_000;

function defaultNow() {
  return Date.now();
}

// Record a hit for `key` and decide whether it is allowed under `limit`
// requests per `windowMs`. Returns { allowed, retryAfter } (retryAfter in
// seconds, 0 when allowed). `now` is injectable for deterministic tests.
export function check(key, { limit, windowMs, now = defaultNow }) {
  const t = now();

  // Evict oldest-inserted key when at capacity (Map preserves insertion order).
  if (!buckets.has(key) && buckets.size >= MAX_KEYS) {
    buckets.delete(buckets.keys().next().value);
  }

  const hits = buckets.get(key) || [];
  // Drop hits that have aged out of the window.
  const fresh = hits.filter((ts) => ts > t - windowMs);

  // Block once `limit` hits already sit in the window (the (limit+1)th request).
  if (fresh.length >= limit) {
    // Oldest in-window hit is fresh[0] (appended in time order); the window
    // frees a slot when it expires at fresh[0] + windowMs.
    const retryAfter = Math.max(1, Math.ceil((fresh[0] + windowMs - t) / 1000));
    return { allowed: false, retryAfter };
  }

  // Allowed: record this hit. A blocked request is NOT recorded, so a flood
  // cannot keep extending its own lockout.
  fresh.push(t);
  buckets.set(key, fresh);
  return { allowed: true, retryAfter: 0 };
}

// Prune empty/expired buckets. Lazy pruning on access is primary; this is the
// periodic backstop, guarded so it is harmless where setInterval is absent.
export function sweep(windowMs, now = defaultNow) {
  const t = now();
  for (const [key, hits] of buckets) {
    const fresh = hits.filter((ts) => ts > t - windowMs);
    if (fresh.length === 0) buckets.delete(key);
    else buckets.set(key, fresh);
  }
}

export const __test__ = {
  reset: () => buckets.clear(),
  size: () => buckets.size,
  MAX_KEYS,
};
