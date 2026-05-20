---
phase: 4
title: "Wire into embeddings handler"
status: pending
priority: P2
effort: "2-3h"
dependencies: [1, 2, 3]
---

# Phase 4: Wire into embeddings handler

## Overview

Embeddings are deterministic by design (same input → same vector) — highest-ROI cache wins. Wire same `parseCacheDirective` + `getPromptCache` into `src/sse/handlers/embeddings.js`. Same correctness invariants as chat (Phase 3). Streaming N/A for embeddings.

## Requirements

### Functional
- In embeddings handler, before upstream:
  1. Compute directive — same parser as chat
  2. Cache key for embeddings: `hashKey({ model, input, encoding_format, dimensions })`. NO tools, NO temperature, NO messages.
  3. Same hit/miss/set lifecycle as chat
- Embeddings have NO bypass-on-tools or bypass-on-temperature triggers (these fields absent). Only bypass conditions: explicit `no-store`, missing header.
- Cache only HTTP 200 responses

### Non-functional
- Latency on miss < 2ms additional
- Latency on hit < 5ms
- Zero impact when directive disabled

## Architecture

Same wrap pattern as Phase 3, in `src/sse/handlers/embeddings.js`. Different `extractCacheKey()` signature for embeddings shape.

```
parseCacheDirective uses embeddings-aware bypass (skip tools/temperature checks — N/A)
extractCacheKeyEmbeddings(body) → { model, input, encoding_format, dimensions }
```

Decision: add `extractCacheKeyEmbeddings(body)` to `cache-directive.js`. OR keep one `extractCacheKey(body, kind)` switching on `kind`. **Pick:** separate functions per kind for clarity (avoids if-branching the key extractor).

## Related Code Files

- Modify: `src/sse/handlers/embeddings.js`
- Modify: `src/sse/services/cache-directive.js` — add `extractCacheKeyEmbeddings(body)`
- Create: `tests/unit/prompt-cache-embeddings-handler.test.js`

Read for context:
- `open-sse/handlers/embeddingsCore.js` — same delegation question as chat
- `tests/unit/embeddingsCore.test.js` — existing pattern to follow

## TDD — failing tests first

```js
// tests/unit/prompt-cache-embeddings-handler.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("embeddings handler cache", () => {
  beforeEach(async () => {
    vi.resetModules();
    // mock upstream embeddings call
    vi.doMock("@/sse/services/upstream-dispatch", () => ({
      callUpstreamEmbeddings: vi.fn(async () => ({
        ok: true,
        body: { object: "list", data: [{ embedding: [0.1, 0.2, 0.3] }] },
      })),
    }));
    const cacheModule = await import("@/sse/services/prompt-cache.js");
    cacheModule.getPromptCache().__resetForTests();
  });

  it("no header → no cache touch", async () => { ... });

  it("same input array → cache hit", async () => {
    const body = { model: "text-embedding-3-small", input: ["hello", "world"] };
    const headers = { "x-router-cache": "ttl=300" };
    const r1 = await handleEmbeddings(mkReq(headers, body));
    const r2 = await handleEmbeddings(mkReq(headers, body));
    expect(r1.headers.get("x-router-cache-hit")).toBe("false");
    expect(r2.headers.get("x-router-cache-hit")).toBe("true");
  });

  it("different input order → cache miss (strict array)", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    await handleEmbeddings(mkReq(headers, { model: "m", input: ["a", "b"] }));
    const r2 = await handleEmbeddings(mkReq(headers, { model: "m", input: ["b", "a"] }));
    expect(r2.headers.get("x-router-cache-hit")).toBe("false");
  });

  it("different encoding_format → cache miss", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    await handleEmbeddings(mkReq(headers, { model: "m", input: "x", encoding_format: "float" }));
    const r = await handleEmbeddings(mkReq(headers, { model: "m", input: "x", encoding_format: "base64" }));
    expect(r.headers.get("x-router-cache-hit")).toBe("false");
  });

  it("different dimensions → cache miss", async () => { ... });

  it("upstream error not cached", async () => { ... });
});
```

## Implementation Steps

1. **Test-first:** write `tests/unit/prompt-cache-embeddings-handler.test.js`. Run → red.
2. Read `src/sse/handlers/embeddings.js` + `open-sse/handlers/embeddingsCore.js` to locate wrap point (likely embeddingsCore).
3. Add `extractCacheKeyEmbeddings(body)` to `cache-directive.js`:
   ```js
   export const extractCacheKeyEmbeddings = (body) => ({
     model: body.model,
     input: body.input,
     encoding_format: body.encoding_format ?? null,
     dimensions: body.dimensions ?? null,
   });
   ```
4. Wire same pattern as Phase 3 chat wrap, but call `extractCacheKeyEmbeddings`.
5. Run tests. Green.
6. Run existing `tests/unit/embeddingsCore.test.js` (36 tests) — confirm zero regressions.

## Success Criteria

- [ ] All embeddings cache tests pass
- [ ] No regression in existing embeddingsCore.test.js (36 tests)
- [ ] Cache key sensitive to model, input order, encoding_format, dimensions
- [ ] No-header request behavior unchanged
- [ ] `npm run build` clean

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `input` can be string OR array — hashKey serialization | `JSON.stringify` handles both consistently; test covers both shapes |
| Large input arrays (batch embedding 1000+ items) blow byte budget | Single entry > maxBytes → cache skips (Phase 1 LRU edge case); document expected user behavior |
| Provider returns different vector for same input across API versions | Out of scope. v1 trusts upstream determinism. Users on shaky provider can omit header. |
| `embeddingsCore.test.js` mock pattern interferes with cache singleton | Test resets cache in `beforeEach`; verify isolation works |
| `dimensions` field provider-specific (OpenAI vs Gemini) | Include if present, null otherwise — key strictness wins |

## Security Considerations

- Embeddings cache stores vector arrays — same PII concern as chat (input might contain user data). In-memory + clears on restart. Document.
- Embedding vectors are not reversible to text, but the cached `input` field is text. Treat cache memory as sensitive.

## Red Team Adjustments — 2026-05-24

Findings **#5, #10, #11** ACCEPTED. **This phase is now the SOLE v1 wire point** (chat cancelled). Body's wrap location + mock pattern SUPERSEDED.

### Wrap location: ROUTE layer, not handler layer (finding #3, #5)

Wrap at `src/app/api/v1/embeddings/route.js` BEFORE calling `handleEmbeddings()`. NOT inside the handler. Reasons:
- Embeddings has only ONE route entry point (verified: no `v1beta`/`messages` flavor for embeddings) → no format-translation ambiguity
- Avoids touching `handleEmbeddingsCore` internals
- Cache placement is decoupled from handler implementation
- Response shape (`{ success, response }`) handled at route layer, not at cache layer

```js
// src/app/api/v1/embeddings/route.js
export async function POST(request) {
  const body = await request.json();
  const directive = parseCacheDirective(request, body, "embeddings");

  let cacheKey = null;
  if (directive.enabled) {
    cacheKey = hashKey({
      kind: "embeddings",
      model: body.model,
      input: body.input,
      encoding_format: body.encoding_format,
      dimensions: body.dimensions,
    });
    const hit = getPromptCache().get(cacheKey);
    if (hit) {
      return new Response(JSON.stringify(hit), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-router-cache-hit": "true" },
      });
    }
  }

  // existing flow: clone request body back since we already consumed it
  const newRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
  const result = await handleEmbeddings(newRequest);

  // result = { success, response: Response }
  if (directive.enabled && result.success && cacheKey) {
    const clone = result.response.clone();
    const cachedBody = await clone.json();
    getPromptCache().set(cacheKey, cachedBody, directive.ttl);
    // attach hit:false header to original response
    return new Response(JSON.stringify(cachedBody), {
      status: 200,
      headers: { ...Object.fromEntries(result.response.headers), "x-router-cache-hit": "false" },
    });
  }
  return result.response;
}
```

### Token-array input bypass (finding #10)

```js
const isTokenInput = (input) => {
  if (Array.isArray(input) && input.length > 0) {
    const first = input[0];
    if (typeof first === "number") return true;             // number[]
    if (Array.isArray(first) && typeof first[0] === "number") return true;  // number[][]
  }
  return false;
};

// In parseCacheDirective for "embeddings" kind:
if (isTokenInput(body.input)) {
  return { enabled: false, ttl: 0, bypassReason: "tokenized_input" };
}
```

Plus: bypass when `JSON.stringify(body.input).length > 100_000` (100KB cap on hash input to avoid CPU spike).

### Drop `extractCacheKeyEmbeddings` (finding from Scope Critic #5)

Use unified `hashKey()` from Phase 1 (already updated to handle null fields). No new function.

### Test mock pattern fixed (finding #5)

Mock `handleEmbeddings` directly, not the phantom `upstream-dispatch`:

```js
vi.mock("@/sse/handlers/embeddings.js", () => ({
  handleEmbeddings: vi.fn(async () => ({
    success: true,
    response: new Response(JSON.stringify({
      object: "list",
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }), { headers: { "Content-Type": "application/json" } }),
  })),
}));
```

### Deployment topology disclaimer (finding #11)

This phase + Phase 6 docs MUST state: cache is in-memory, ONLY effective for long-lived Node processes (npm start, Docker, self-hosted). Serverless deployments (Vercel, Lambda) tear down JS context between invocations → hit rate ≈ 0. Not a v1 deployment target.

### Updated success criteria

- [ ] Wrap at `src/app/api/v1/embeddings/route.js` BEFORE `handleEmbeddings`
- [ ] No header → byte-identical to pre-feature
- [ ] Same input → cache hit on second call
- [ ] Token-array input (number[] / number[][]) → bypass with reason
- [ ] Input > 100KB → bypass with reason
- [ ] `handleEmbeddings` failure (success=false) → not cached
- [ ] Test mocks `handleEmbeddings` directly (no phantom modules)
- [ ] Response headers `x-router-cache-hit: true|false` echo correctly

### Effort revised

Was 2-3h. **Now 3-4h** (route-layer wrap + token bypass + response-shape handling).
