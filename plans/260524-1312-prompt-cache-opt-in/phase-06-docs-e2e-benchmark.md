---
phase: 6
title: "Docs + E2E benchmark"
status: completed
priority: P2
effort: "3-4h"
dependencies: [1, 2, 4]
---

# Phase 6: Docs + E2E benchmark

> ⚠️ **Body below is the PRE-red-team draft (chat + streaming scope). It is SUPERSEDED by `## Red Team Adjustments` at the bottom of this file (embeddings-only).** When implementing, follow the Adjustments section; the Overview/Requirements/TDD prose here references cancelled chat/streaming E2E, `__resetForTests()`, and `scripts/cache-bench.js` — all dropped. Retained for traceability only.

## Overview

One end-to-end scenario that exercises chat + embeddings + streaming cache across multiple requests. A reproducible micro-benchmark proving the token-save claim (1000 identical prompts → 99% hit rate). User-facing docs covering header usage, bypass rules, env vars, and limitations.

## Requirements

### Functional
- E2E test (`tests/unit/prompt-cache-e2e.test.js`):
  1. Spin up cache (reset to clean)
  2. Send 1000 identical chat requests with `x-router-cache: ttl=300` → assert: 1 upstream call, 999 hits
  3. Send 1 request with different `max_tokens` → asserts miss + 1 more upstream call
  4. Send 1 request with `tools` → assert bypass, upstream called
  5. Stream test: 5 identical requests with `x-router-cache-stream: true`, stream:true → 1 upstream, 4 replays, downstream bytes identical
  6. Sleep past TTL → next request misses
- Micro-benchmark script `scripts/cache-bench.js` printing hit-rate + latency p50/p99
- `docs/integrations/prompt-cache.md` covers:
  - When to use (test loops, lint cycles, agent retries)
  - Header reference (`x-router-cache: ttl=<s>` / `no-store`, `x-router-cache-stream: true`)
  - Bypass rules (tools, temperature>0, stream-default)
  - Response headers (hit-status, ttl-remaining)
  - ENV vars (`PROMPT_CACHE_MAX_BYTES`, `STREAM_CACHE_MAX_ENTRY_BYTES`)
  - Limitations (in-memory, no auth, no multi-user, no cross-provider dedup)
  - Example: curl with header, expected hit/miss behavior
- `README.md` short section on token-saving cache feature linking to docs
- `docs/system-architecture.md` adds cache subsection
- `CHANGELOG.md` entry

### Non-functional
- E2E test < 10s wall clock (vitest default timeout)
- Benchmark script standalone, no test runner needed

## Architecture

```
tests/unit/prompt-cache-e2e.test.js
  ├── setup: reset cache singleton, mock upstream dispatch
  ├── scenario 1: 1000 identical chat → 1 upstream, 999 hits
  ├── scenario 2: change max_tokens → miss
  ├── scenario 3: tools present → bypass
  ├── scenario 4: streaming capture + replay 5x
  ├── scenario 5: TTL expiry (vi.useFakeTimers)
  └── teardown

scripts/cache-bench.js
  ├── reset cache
  ├── time loop: 1000 identical hashKey + cache.get/set
  └── print { p50, p99, hitRate, totalBytes }
```

## Related Code Files

- Create: `tests/unit/prompt-cache-e2e.test.js`
- Create: `scripts/cache-bench.js`
- Create: `docs/integrations/prompt-cache.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/system-architecture.md`
- Modify: `docs/project-changelog.md`

## TDD — failing test first

```js
// tests/unit/prompt-cache-e2e.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("prompt cache e2e", () => {
  let upstreamCalls = 0;

  beforeEach(async () => {
    upstreamCalls = 0;
    vi.resetModules();
    vi.doMock("@/sse/services/upstream-dispatch", () => ({
      callUpstreamChat: vi.fn(async () => {
        upstreamCalls++;
        return { ok: true, body: { id: `r${upstreamCalls}`, choices: [{ text: "ok" }] } };
      }),
    }));
    const c = await import("@/sse/services/prompt-cache.js");
    c.getPromptCache().__resetForTests();
  });

  it("1000 identical chats → 1 upstream call, 999 hits", async () => {
    const { handleChat } = await import("@/sse/handlers/chat.js");
    const body = { model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0 };
    const headers = { "x-router-cache": "ttl=300" };
    for (let i = 0; i < 1000; i++) await handleChat(mkReq(headers, body));
    expect(upstreamCalls).toBe(1);
    const stats = (await import("@/sse/services/prompt-cache.js")).getPromptCache().stats();
    expect(stats.hits).toBe(999);
  });

  it("different max_tokens → miss", async () => { ... });
  it("tools present → bypass, no cache touch", async () => { ... });
  it("streaming capture + replay byte-identical 5x", async () => { ... });
  it("ttl expiry triggers refetch", async () => { ... });
});
```

## Implementation Steps

1. **Test-first:** write `tests/unit/prompt-cache-e2e.test.js`. Run → red (depends on Phases 1-5 done, which they are at this point).
2. Iterate against integration bugs that only surface in glue (concurrent set/get, key stability across calls).
3. Write `scripts/cache-bench.js`:
   ```js
   import { performance } from "node:perf_hooks";
   import { getPromptCache, hashKey } from "../src/sse/services/prompt-cache.js";
   const c = getPromptCache(); c.__resetForTests();
   const params = { model: "m", messages: [{ role: "user", content: "hi".repeat(100) }], temperature: 0 };
   const key = hashKey(params);
   const N = 10_000;
   const t = []; let hits = 0;
   for (let i = 0; i < N; i++) {
     const a = performance.now();
     if (!c.get(key)) c.set(key, { ok: true }, 60);
     else hits++;
     t.push(performance.now() - a);
   }
   t.sort((a, b) => a - b);
   console.log({ p50: t[5000], p99: t[9900], hitRate: hits / N, ...c.stats() });
   ```
   Run: `node scripts/cache-bench.js`. Document numbers in `docs/integrations/prompt-cache.md`.
4. Write `docs/integrations/prompt-cache.md`:
   - Section: When to enable
   - Section: How to enable (header examples)
   - Section: Bypass rules table
   - Section: Response headers
   - Section: ENV vars
   - Section: Limitations (v1)
   - Section: Benchmark results (from step 3)
5. Update `README.md` with short link to docs.
6. Update `docs/system-architecture.md` with cache paragraph + architecture block from `plan.md`.
7. Update `CHANGELOG.md`:
   ```
   ### Added
   - Opt-in prompt cache via `x-router-cache: ttl=<seconds>` header.
     In-memory LRU, default 500MB budget (PROMPT_CACHE_MAX_BYTES override).
     Strict key (model + messages + temperature + max_tokens + tools + seed).
     Automatic bypass on `tools` field, `temperature > 0`, or `stream: true`
     (streaming opt-in via `x-router-cache-stream: true`). Wired into
     /v1/chat/completions and /v1/embeddings. See
     docs/integrations/prompt-cache.md.
   ```
8. Update `docs/project-changelog.md`.
9. Run full vitest suite — confirm zero regressions on chat / embeddings / reauth / warmup tests.

## Success Criteria

- [ ] E2E test passes — 1000 identical → 1 upstream + 999 hits asserted
- [ ] Benchmark script prints sub-millisecond hit latency
- [ ] `docs/integrations/prompt-cache.md` covers header API + bypass + env vars + limitations
- [ ] `README.md` + `docs/system-architecture.md` updated
- [ ] CHANGELOG + project-changelog entries present
- [ ] `npm run build` clean
- [ ] Full vitest suite green (excluding the 25 pre-existing unrelated failures documented in branch state)

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| E2E test flake from singleton state leak across tests | `beforeEach` resets cache singleton; tests use fresh `vi.resetModules()` |
| Benchmark numbers vary across machines | Document hardware in docs; goal is order-of-magnitude not absolute numbers |
| Docs drift when bypass rules change | docs/integrations/prompt-cache.md links to `src/sse/services/cache-directive.js` as source of truth |
| Users expect cache to dedupe across providers — disappointed | Docs explicitly state: per-model cache only. Future cross-provider plan can extend. |
| `scripts/cache-bench.js` not run in CI | Document as manual / pre-release script; not part of CI suite |

## Security Considerations

- Docs include warning: cached bodies hold input PII in memory
- Docs note: `PROMPT_CACHE_MAX_BYTES` should be sized to deployment memory budget — over-commit risks Node OOM
- Cache is process-wide. If running multi-tenant deployments, document scope-isolation as TODO for multi-user feature

## Next Steps

Plan complete. Post-merge monitoring:
- Watch `cache.stats()` logs after deployment for unexpected hit-rate (too high → review key strictness; too low → review user adoption)
- Collect feedback on whether default-off was the right call (vs default-on with opt-out)
- If users request invalidation API → spin off follow-up plan
- Persistent layer (better-sqlite3) candidate for v2 if memory budget tight in prod

## Red Team Adjustments — 2026-05-24

Findings **#11** (serverless cold start) + downstream scope cuts ACCEPTED. Body's "1000 chats + streaming" E2E scope SHRUNK to embeddings-only.

### E2E test scope reduction

Drop chat E2E + streaming E2E (Phases 3 and 5 cancelled). Single scenario:

```js
// tests/unit/prompt-cache.e2e.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("prompt cache e2e (embeddings only)", () => {
  let upstreamCalls = 0;

  beforeEach(async () => {
    upstreamCalls = 0;
    vi.resetModules();
    vi.mock("@/sse/handlers/embeddings.js", () => ({
      handleEmbeddings: vi.fn(async () => {
        upstreamCalls++;
        return {
          success: true,
          response: new Response(JSON.stringify({ object: "list", data: [{ embedding: [0.1] }] }), {
            headers: { "Content-Type": "application/json" },
          }),
        };
      }),
    }));
    const c = await import("@/sse/services/prompt-cache.js");
    c.getPromptCache().clear();
  });

  it("1000 identical embeddings → 1 upstream call, 999 hits", async () => { ... });
  it("token-array input → bypass", async () => { ... });
  it("input > 100KB → bypass", async () => { ... });
  it("upstream error → not cached", async () => { ... });
  it("ttl expiry triggers refetch", async () => { ... });
});
```

5 scenarios instead of 6. No streaming, no provider-failover.

### Drop `scripts/cache-bench.js` (Scope Critic #9)

Not in CI. Machine-dependent. Bit-rots. If perf number needed, run once locally, hard-code with date + hardware in docs.

### Docs scope cut

Document covers ONLY:
- Header usage (`x-router-cache: ttl=<s>` and `no-store`)
- Embeddings-only support (NOT chat — v1 limitation)
- Bypass rules (token input, oversize input, no-header default)
- Response headers (`x-router-cache-hit` only — drop `ttl-remaining`)
- ENV var (`PROMPT_CACHE_MAX_BYTES`)
- **Serverless limitation** — in-memory cache requires long-lived Node process. Document Vercel/Lambda as NOT supported for v1 cache.
- Limitations (no invalidation, no metrics UI, no chat support v1)

Drop: cross-provider dedup (N/A — embeddings deterministic per model anyway), multi-user scoping discussion (N/A).

### CHANGELOG entry (revised)

```
### Added
- Opt-in embeddings cache via `x-router-cache: ttl=<seconds>` header.
  In-memory LRU, default 500MB budget (PROMPT_CACHE_MAX_BYTES override).
  Strict key (model + input + encoding_format + dimensions). Automatic
  bypass on `no-store` header, tokenized input (number arrays), or
  input >100KB. Wired into /v1/embeddings only (chat support deferred).
  See docs/integrations/prompt-cache.md. NOT compatible with serverless
  deployments (in-memory only — Vercel/Lambda cold starts clear cache).
```

### Docs files

KEEP: `docs/integrations/prompt-cache.md`, `CHANGELOG.md`, short `README.md` link.
DROP: `docs/system-architecture.md` update (defer to docs-sync task), `docs/project-changelog.md` update (handled by ck:journal), `scripts/cache-bench.js`.

### Effort revised

Was 3-4h. **Now 2h** (fewer tests, smaller docs, no bench script).
