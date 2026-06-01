import { createHash } from "node:crypto";

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024; // 500MB

/**
 * In-memory, byte-bounded, LRU prompt cache.
 *
 * Eviction is least-recently-used by a monotonic `accessSeq` counter (O(n) scan
 * on insert — acceptable for a default-OFF feature). A counter rather than a
 * wall-clock timestamp keeps recency ordering correct even when many ops land
 * in the same millisecond. TTL is enforced lazily on
 * `get()`; there is no background sweep, so the cache has zero side effects at
 * rest. `get()` returns a structuredClone so a caller mutating the result can
 * never corrupt a cached body.
 */
export class PromptCache {
  #entries = new Map(); // key → { body, expiresAt, sizeBytes, accessSeq }
  #currentBytes = 0;
  #maxBytes;
  #accessSeq = 0; // monotonic recency counter — robust LRU ordering independent of clock resolution
  #stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };

  constructor({ maxBytes } = {}) {
    this.#maxBytes = maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** @returns {object|null} cloned body, or null on miss/expiry */
  get(key) {
    const e = this.#entries.get(key);
    if (!e) {
      this.#stats.misses++;
      return null;
    }
    if (e.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      this.#currentBytes -= e.sizeBytes;
      this.#stats.expirations++;
      this.#stats.misses++;
      return null;
    }
    e.accessSeq = ++this.#accessSeq;
    this.#stats.hits++;
    return structuredClone(e.body);
  }

  set(key, body, ttlSec) {
    let sizeBytes;
    try {
      sizeBytes = Buffer.byteLength(JSON.stringify(body));
    } catch {
      // Unserializable body (circular ref) — never fall back to 0, which would
      // let an unbounded entry slip past the budget. Treat as too-big → skip.
      sizeBytes = Infinity;
    }
    // A single entry larger than the whole budget can never fit. Skip it
    // outright rather than evict everything and still overflow (infinite loop).
    if (sizeBytes > this.#maxBytes) return;

    // Replacing an existing key: remove it fully first so the eviction loop
    // below can never pick the key being replaced (which would double-subtract
    // its bytes and skew the accounting).
    const prev = this.#entries.get(key);
    if (prev) {
      this.#entries.delete(key);
      this.#currentBytes -= prev.sizeBytes;
    }

    while (this.#currentBytes + sizeBytes > this.#maxBytes && this.#entries.size > 0) {
      this.#evictOldest();
    }

    this.#entries.set(key, {
      body,
      expiresAt: Date.now() + ttlSec * 1000,
      sizeBytes,
      accessSeq: ++this.#accessSeq,
    });
    this.#currentBytes += sizeBytes;
  }

  clear() {
    this.#entries.clear();
    this.#currentBytes = 0;
    this.#stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  stats() {
    return { ...this.#stats, currentBytes: this.#currentBytes, entryCount: this.#entries.size };
  }

  #evictOldest() {
    let oldestKey = null;
    let oldestSeq = Infinity;
    for (const [k, e] of this.#entries) {
      if (e.accessSeq < oldestSeq) {
        oldestSeq = e.accessSeq;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      const e = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      this.#currentBytes -= e.sizeBytes;
      this.#stats.evictions++;
    }
  }
}

/**
 * Stable SHA-256 cache key. Every field normalizes undefined → null so a
 * missing field and an explicit-undefined field hash identically. Includes
 * `provider` + `system` (Anthropic top-level) so v2 chat re-use is collision
 * safe; unused fields are null for embeddings and don't affect the digest.
 *
 * @param {object} p
 * @returns {string} 64-char hex digest
 */
export const hashKey = (p) => {
  const norm = {
    provider: p.provider ?? null,
    model: p.model ?? null,
    system: p.system ?? null,
    messages: p.messages ?? null,
    input: p.input ?? null,
    temperature: p.temperature ?? null,
    max_tokens: p.max_tokens ?? null,
    tools: p.tools ?? null,
    seed: p.seed ?? null,
    encoding_format: p.encoding_format ?? null,
    dimensions: p.dimensions ?? null,
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
};

let singleton = null;

/** Process-wide cache instance, lazily constructed from PROMPT_CACHE_MAX_BYTES. */
export const getPromptCache = () => {
  if (!singleton) {
    const envBytes = Number(process.env.PROMPT_CACHE_MAX_BYTES);
    const maxBytes = Number.isFinite(envBytes) && envBytes > 0 ? envBytes : DEFAULT_MAX_BYTES;
    singleton = new PromptCache({ maxBytes });
  }
  return singleton;
};
