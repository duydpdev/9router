---
phase: 1
title: "Foundation (LRU + SHA-256 key hasher + singleton + tests-first)"
status: completed
priority: P2
effort: "4-5h"
dependencies: []
---

# Phase 1: Foundation

> ⚠️ **Body below is the PRE-red-team draft (doubly-linked-list LRU, `setInterval` TTL sweep, `__resetForTests()`, 4 split test files). It is SUPERSEDED by `## Red Team Adjustments` at the bottom** (Map+lastAccess, lazy expire only, public `clear()`, single test file). Implement from the Adjustments section. Body retained for traceability only.

## Overview

Build the pure cache module: `PromptCache` class with LRU eviction by byte size, SHA-256 key hasher, TTL expiry, and process-wide singleton. NO handler wiring yet. Heavy test coverage — this is the correctness-critical core.

## Requirements

### Functional
- `PromptCache` class with API: `get(key)`, `set(key, body, ttlSec)`, `delete(key)`, `stats()`, `clear()`
- Eviction policy: when total byte budget exceeded, evict least-recently-used (move-to-front on get/set, drop from tail)
- TTL: lazy expiry on `get()`; periodic sweep every 60s (interval clearable in tests)
- Byte accounting: track `Buffer.byteLength(JSON.stringify(body))` per entry
- `hashKey({ model, messages, temperature, max_tokens, tools, seed })` → SHA-256 hex string. Stable order. Optional fields normalized (undefined vs null → same).
- Singleton accessor: `getPromptCache()` returns process-wide instance, constructed with `PROMPT_CACHE_MAX_BYTES` env (default 500MB)

### Non-functional
- `get()` p99 < 1ms for 10K entries
- `hashKey()` p99 < 0.5ms for ~10KB messages
- Zero side effects at module load (singleton lazy)
- Reset hook for tests: `__resetForTests()`

## Architecture

```
src/sse/services/prompt-cache.js
  ├── class PromptCache
  │     constructor({ maxBytes, ttlSweepIntervalMs })
  │     #entries: Map<key, { body, expiresAt, sizeBytes, lruNode }>
  │     #lru: doubly-linked list (head=mru, tail=lru)
  │     #currentBytes: number
  │     #stats: { hits, misses, evictions, expirations }
  │     get(key) → body | null   (lazy expire, move-to-front)
  │     set(key, body, ttlSec)   (insert + evict tail if over budget)
  │     delete(key)
  │     clear()
  │     stats()                  (snapshot)
  │     __resetForTests()
  │
  ├── hashKey(params) → sha256 hex
  │     normalize: undefined → null; stable JSON stringification (sorted keys for top-level only)
  │     concat: model | messages-json | temperature | max_tokens | tools-json | seed
  │
  └── getPromptCache() → singleton (lazy)
```

LRU implementation: simple doubly-linked list pointers stored on entry objects to avoid Map → list lookup cost.

## Related Code Files

- Create: `src/sse/services/prompt-cache.js`
- Create: `tests/unit/prompt-cache-foundation.test.js`
- Create: `tests/unit/prompt-cache-hash-key.test.js`
- Create: `tests/unit/prompt-cache-lru-eviction.test.js`
- Create: `tests/unit/prompt-cache-ttl-expiry.test.js`

## TDD — failing tests first

Four test files cover orthogonal concerns:

```js
// tests/unit/prompt-cache-foundation.test.js
import { describe, it, expect, beforeEach } from "vitest";

let PromptCache, getPromptCache;
beforeEach(async () => {
  ({ PromptCache, getPromptCache } = await import("@/sse/services/prompt-cache.js"));
  getPromptCache().__resetForTests();
});

describe("PromptCache foundation", () => {
  it("get on missing key returns null", () => {
    expect(new PromptCache().get("nope")).toBeNull();
  });

  it("set then get returns body", () => {
    const c = new PromptCache();
    c.set("k", { hello: "world" }, 60);
    expect(c.get("k")).toEqual({ hello: "world" });
  });

  it("stats track hits/misses", () => {
    const c = new PromptCache();
    c.set("k", { x: 1 }, 60);
    c.get("k"); c.get("k"); c.get("missing");
    expect(c.stats()).toMatchObject({ hits: 2, misses: 1 });
  });
});
```

```js
// tests/unit/prompt-cache-hash-key.test.js
describe("hashKey", () => {
  it("identical params → identical hash", () => {
    const a = hashKey({ model: "claude-3", messages: [{ role: "user", content: "hi" }], temperature: 0 });
    const b = hashKey({ model: "claude-3", messages: [{ role: "user", content: "hi" }], temperature: 0 });
    expect(a).toBe(b);
  });
  it("different temperature → different hash", () => { ... });
  it("different model → different hash", () => { ... });
  it("undefined vs missing field treated same", () => { ... });
  it("tools field present changes hash", () => { ... });
  it("seed field present changes hash", () => { ... });
});
```

```js
// tests/unit/prompt-cache-lru-eviction.test.js
describe("LRU eviction", () => {
  it("evicts oldest when over byte budget", () => {
    const c = new PromptCache({ maxBytes: 100 });
    c.set("a", { v: "x".repeat(40) }, 60);  // ~45 bytes
    c.set("b", { v: "y".repeat(40) }, 60);  // ~45 bytes
    c.set("c", { v: "z".repeat(40) }, 60);  // ~45 bytes → triggers eviction of "a"
    expect(c.get("a")).toBeNull();
    expect(c.get("b")).not.toBeNull();
    expect(c.get("c")).not.toBeNull();
  });
  it("get() promotes entry to head (move-to-front)", () => {
    const c = new PromptCache({ maxBytes: 100 });
    c.set("a", ...);
    c.set("b", ...);
    c.get("a"); // promote
    c.set("c", ...); // should evict "b" not "a"
    expect(c.get("a")).not.toBeNull();
    expect(c.get("b")).toBeNull();
  });
});
```

```js
// tests/unit/prompt-cache-ttl-expiry.test.js
import { vi } from "vitest";

describe("TTL expiry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns body before TTL elapses", () => {
    const c = new PromptCache();
    c.set("k", { v: 1 }, 60);
    vi.advanceTimersByTime(59_000);
    expect(c.get("k")).not.toBeNull();
  });
  it("returns null after TTL elapses (lazy expire on get)", () => {
    const c = new PromptCache();
    c.set("k", { v: 1 }, 60);
    vi.advanceTimersByTime(61_000);
    expect(c.get("k")).toBeNull();
    expect(c.stats().expirations).toBeGreaterThan(0);
  });
});
```

## Implementation Steps

1. **Test-first:** write all 4 test files. Run → red.
2. Create `src/sse/services/prompt-cache.js`:
   - `class PromptCache` with byte-bound LRU (doubly-linked list nodes inline with entries)
   - `hashKey(params)` — normalize undefined → null, stable stringify, concat, sha256
   - `getPromptCache()` — singleton with `process.env.PROMPT_CACHE_MAX_BYTES` parsed (fallback 500 * 1024 * 1024)
   - `__resetForTests()` on singleton instance
   - Periodic TTL sweep via `setInterval` guarded by `ttlSweepIntervalMs > 0` (test passes `0` to disable)
3. Run all tests, iterate until green.
4. Add JSDoc to public API.

## Success Criteria

- [ ] All 4 test files pass with full assertion coverage
- [ ] Byte budget enforced; eviction order matches LRU
- [ ] TTL lazy + periodic sweep both work
- [ ] hashKey stable across calls, sensitive to all required fields
- [ ] Singleton lazy + resettable
- [ ] No top-level side effects (no setInterval at import time, only on singleton construction)
- [ ] `npm run build` clean

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| LRU pointer bugs corrupt eviction order | Heavy unit tests cover head/tail/mid promote + insert + delete |
| `JSON.stringify` non-determinism on object key order | Document: caller MUST pass canonical objects. Or apply `stable-stringify` (add tiny dep) on messages field — Phase 1 decision: rely on canonical inputs, Phase 2 normalization handles param shape |
| `Buffer.byteLength` on circular bodies throws | Cache values should be plain JSON (chat completion responses). Document. Add try/catch with `sizeBytes = 0` fallback + warning log. |
| Memory spike from large single entry | If a single body > maxBytes, skip caching (warn). Test covers. |
| Singleton leak across tests | `__resetForTests()` clears entries + stats + LRU. `beforeEach` in every test calls it. |

## Security Considerations

- Cache module never logs body content (only sizes)
- No user data persisted to disk in v1
- Cache shared across all `/v1` callers — acceptable v1 (no multi-user). Document for future multi-user plan.

## Red Team Adjustments — 2026-05-24

Findings **#1, #2, #7, #8, #13, #14** ACCEPTED. Architecture SIMPLIFIED. Body's doubly-linked list / setInterval / dunder method SUPERSEDED by adjustments below.

### Simpler cache impl (findings #7, #13)

Drop doubly-linked list. Drop `setInterval`. Drop `__resetForTests()` dunder.

```js
// src/sse/services/prompt-cache.js
class PromptCache {
  #entries = new Map();          // key → { body, expiresAt, sizeBytes, lastAccess }
  #currentBytes = 0;
  #maxBytes;
  #stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };

  constructor({ maxBytes }) { this.#maxBytes = maxBytes; }

  get(key) {
    const e = this.#entries.get(key);
    if (!e) { this.#stats.misses++; return null; }
    if (e.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      this.#currentBytes -= e.sizeBytes;
      this.#stats.expirations++;
      this.#stats.misses++;
      return null;
    }
    e.lastAccess = Date.now();
    this.#stats.hits++;
    return structuredClone(e.body);   // prevent caller mutation (finding #6)
  }

  set(key, body, ttlSec) {
    let sizeBytes;
    try { sizeBytes = Buffer.byteLength(JSON.stringify(body)); }
    catch { sizeBytes = Infinity; }   // never default to 0 (finding #8 risk)
    if (sizeBytes > this.#maxBytes) {
      // single entry too big — skip (finding #8). NEVER enter infinite loop.
      return;
    }
    // evict by lastAccess until fits (O(n) scan, fine for default-OFF feature)
    while (this.#currentBytes + sizeBytes > this.#maxBytes && this.#entries.size > 0) {
      this.#evictOldest();
    }
    this.#entries.set(key, { body, expiresAt: Date.now() + ttlSec * 1000, sizeBytes, lastAccess: Date.now() });
    this.#currentBytes += sizeBytes;
  }

  clear() { this.#entries.clear(); this.#currentBytes = 0; this.#stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 }; }
  stats() { return { ...this.#stats, currentBytes: this.#currentBytes, entryCount: this.#entries.size }; }

  #evictOldest() {
    let oldestKey = null; let oldestT = Infinity;
    for (const [k, e] of this.#entries) {
      if (e.lastAccess < oldestT) { oldestT = e.lastAccess; oldestKey = k; }
    }
    if (oldestKey) {
      const e = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      this.#currentBytes -= e.sizeBytes;
      this.#stats.evictions++;
    }
  }
}
```

**No** `setInterval`. **No** `lastAccess` linked list. **No** `__resetForTests()` dunder — use `clear()`. Lazy expire only.

### Updated `hashKey` — include `system` + `provider` (findings #1, #2)

```js
import { createHash } from "node:crypto";

export const hashKey = (p) => {
  const norm = {
    provider: p.provider ?? null,        // NEW per #2 — effective provider id
    model: p.model ?? null,
    system: p.system ?? null,            // NEW per #1 — Anthropic top-level field
    messages: p.messages ?? null,
    input: p.input ?? null,              // for embeddings
    temperature: p.temperature ?? null,
    max_tokens: p.max_tokens ?? null,
    tools: p.tools ?? null,
    seed: p.seed ?? null,
    encoding_format: p.encoding_format ?? null,
    dimensions: p.dimensions ?? null,
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
};
```

Single unified `hashKey` works for both chat (when re-enabled in v2) and embeddings. Unused fields normalize to `null` → don't affect hash for embeddings calls.

### Stable contract (finding #14)

Phase 1 NEVER amended by Phase 4 / Phase 6. `get()` returns `body | null`. No `ttlRemainingSec`. No union value shape (streaming cut). Phase 4 wires this exact contract.

### Tests consolidated (single file)

`tests/unit/prompt-cache.test.js` with describe blocks:
- "PromptCache foundation" (get/set/clear/stats)
- "hashKey stability + sensitivity"
- "LRU eviction" (oversize entry skipped, byte budget enforced)
- "TTL lazy expiry"

Per-test: instantiate fresh `new PromptCache({ maxBytes: 1000 })`. NO singleton state pollution.

Singleton accessor `getPromptCache()` tested separately in one assertion: `expect(getPromptCache()).toBe(getPromptCache())`.

### Effort revised

Was 4-5h. **Now 3h** (simpler impl, fewer tests).
