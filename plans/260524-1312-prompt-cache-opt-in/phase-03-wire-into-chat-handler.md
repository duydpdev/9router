---
phase: 3
title: "Wire into chat handler"
status: pending
priority: P2
effort: "4-5h"
dependencies: [1, 2]
---

# Phase 3: Wire into chat handler (non-streaming only)

## Overview

Plug `parseCacheDirective` + `getPromptCache` into `src/sse/handlers/chat.js` for non-streaming requests only. Streaming defers to Phase 5. Strict invariant: clients without the header see byte-identical behavior to today. TDD covers hit/miss/expire/bypass/header echo.

## Requirements

### Functional
- In `chat.js` (or shared dispatch layer), before calling upstream:
  1. Compute `directive = parseCacheDirective(req, body)`
  2. If `!directive.enabled`: proceed as today
  3. Else: compute `key = hashKey({ model, messages, temperature, max_tokens, tools, seed })`
  4. `hit = getPromptCache().get(key)`
  5. If hit: return cached body + headers `x-router-cache-hit: true`, `x-router-cache-ttl-remaining: <s>`
  6. If miss: call upstream as today. On success → `getPromptCache().set(key, body, directive.ttl)`. Return body + `x-router-cache-hit: false`.
- Cache ONLY successful responses (HTTP 200, no upstream error)
- Non-streaming responses only this phase
- Response headers added regardless of hit/miss (so clients can detect cache active)

### Non-functional
- Latency added on miss < 2ms (hashKey + set)
- Latency on hit < 5ms (Map get + Buffer encode)
- Zero impact when `directive.enabled === false`

## Architecture

```
src/sse/handlers/chat.js
  ├── existing flow:
  │     parse body → resolve provider → call upstream → return
  └── new wrap:
        directive = parseCacheDirective(req, body)
        if directive.enabled:
          key = hashKey(extractCacheParams(body))
          hit = cache.get(key)
          if hit: return mkResponse(hit, { "x-router-cache-hit": "true", ... })
        result = existing flow
        if directive.enabled && result.ok:
          cache.set(key, result.body, directive.ttl)
        return mkResponse(result.body, { "x-router-cache-hit": "false", ... })
```

Helper `extractCacheParams(body)` lives next to `hashKey` in `prompt-cache.js` (Phase 1) or in the handler. Decision: live in `cache-directive.js` as `extractCacheKey(body)` → keeps key extraction near directive logic.

## Related Code Files

- Modify: `src/sse/handlers/chat.js` — wrap upstream call
- Modify: `src/sse/services/cache-directive.js` — add `extractCacheKey(body)` helper
- Create: `tests/unit/prompt-cache-chat-handler.test.js`

Read for context:
- `open-sse/handlers/chatCore.js` — if shared core handles upstream call, the wrap goes there instead. Verify before modifying.

## TDD — failing tests first

```js
// tests/unit/prompt-cache-chat-handler.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

let handleChat, getPromptCache, mockUpstream;

beforeEach(async () => {
  vi.resetModules();
  // mock upstream call so we control responses
  vi.doMock("@/sse/services/upstream-dispatch", () => ({
    callUpstreamChat: vi.fn(async () => ({ ok: true, body: { id: "1", choices: [...] } })),
  }));
  const cacheModule = await import("@/sse/services/prompt-cache.js");
  getPromptCache = cacheModule.getPromptCache;
  getPromptCache().__resetForTests();
  ({ handleChat } = await import("@/sse/handlers/chat.js"));
});

describe("chat handler cache", () => {
  it("no header → no cache touch, identical behavior", async () => {
    const req = mkReq({}, { model: "m", messages: [...] });
    const res = await handleChat(req);
    expect(res.headers.get("x-router-cache-hit")).toBeNull();
    expect(getPromptCache().stats()).toEqual({ hits: 0, misses: 0, evictions: 0, expirations: 0 });
  });

  it("with header + same body → second call is hit", async () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0 };
    const headers = { "x-router-cache": "ttl=60" };

    const res1 = await handleChat(mkReq(headers, body));
    expect(res1.headers.get("x-router-cache-hit")).toBe("false");

    const res2 = await handleChat(mkReq(headers, body));
    expect(res2.headers.get("x-router-cache-hit")).toBe("true");
    expect(getPromptCache().stats().hits).toBe(1);
  });

  it("different temperature → cache miss (strict key)", async () => {
    const headers = { "x-router-cache": "ttl=60" };
    await handleChat(mkReq(headers, { model: "m", messages: [...], temperature: 0 }));
    const res2 = await handleChat(mkReq(headers, { model: "m", messages: [...], temperature: 0.1 }));
    // Note: temperature 0.1 actually bypasses (>0). Test with different max_tokens instead:
    // ...
  });

  it("tools present → bypass even with header", async () => {
    const body = { model: "m", messages: [...], tools: [{ name: "search" }] };
    const headers = { "x-router-cache": "ttl=60" };
    await handleChat(mkReq(headers, body));
    await handleChat(mkReq(headers, body));
    expect(getPromptCache().stats()).toEqual({ hits: 0, misses: 0, evictions: 0, expirations: 0 });
  });

  it("upstream error → not cached", async () => {
    vi.mocked(callUpstreamChat).mockResolvedValueOnce({ ok: false, status: 500, body: {} });
    const headers = { "x-router-cache": "ttl=60" };
    const body = { model: "m", messages: [...], temperature: 0 };
    await handleChat(mkReq(headers, body));
    // success on second call → still a miss since first wasn't cached
    vi.mocked(callUpstreamChat).mockResolvedValueOnce({ ok: true, body: { ok: 1 } });
    const res = await handleChat(mkReq(headers, body));
    expect(res.headers.get("x-router-cache-hit")).toBe("false");
  });

  it("response headers always present when directive enabled (even on miss)", async () => {
    const res = await handleChat(mkReq({ "x-router-cache": "ttl=60" }, { model: "m", messages: [...], temperature: 0 }));
    expect(res.headers.get("x-router-cache-hit")).toBe("false");
    expect(res.headers.get("x-router-cache-ttl-remaining")).toBeNull(); // miss has no remaining
  });
});
```

## Implementation Steps

1. **Test-first:** write `tests/unit/prompt-cache-chat-handler.test.js`. Run → red.
2. Read `src/sse/handlers/chat.js` + `open-sse/handlers/chatCore.js` to find the right wrap point (the function that returns the upstream-result object).
3. Add `extractCacheKey(body)` to `cache-directive.js`. Extracts `{ model, messages, temperature, max_tokens, tools, seed }`.
4. Modify chat handler:
   ```js
   const directive = parseCacheDirective(req, body);
   let cacheKey = null;
   if (directive.enabled) {
     cacheKey = hashKey(extractCacheKey(body));
     const hit = getPromptCache().get(cacheKey);
     if (hit) {
       return respond(hit, { "x-router-cache-hit": "true", "x-router-cache-ttl-remaining": String(hit.ttlRemainingSec) });
     }
   }
   const result = await /* existing upstream call */;
   if (directive.enabled && result.ok && cacheKey) {
     getPromptCache().set(cacheKey, result.body, directive.ttl);
   }
   const headers = directive.enabled ? { "x-router-cache-hit": "false" } : {};
   return respond(result.body, headers);
   ```
   Note: `cache.get()` may need to also return `ttlRemainingSec` — extend Phase 1's return shape (small Phase 1 amendment OR compute remaining from `expiresAt - Date.now()` in handler).
5. Run tests. Iterate to green.
6. Regression sweep — run existing chat handler tests + existing reauth tests.

## Success Criteria

- [ ] No-header request behavior byte-identical to before
- [ ] Cache hit/miss test matrix passes
- [ ] tools / temperature>0 bypass enforced
- [ ] Upstream errors NOT cached
- [ ] Response headers added only when directive enabled
- [ ] No regressions in existing `/v1/chat/completions` tests
- [ ] `npm run build` clean

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `chat.js` actually delegates to `chatCore.js` — wrap location wrong | Read both files first; wrap at the shared layer if delegation exists |
| Cache returns mutated object (callers expect frozen) | Wrap with `structuredClone()` on `get()` return — small perf cost, prevents downstream mutation bugs |
| `messages` content may include binary parts (Claude vision) — JSON.stringify unstable | Skip cache if any message part is non-text; add to bypass conditions; test it |
| Provider switches mid-key (fallback to next provider) — cached body from provider A served for provider B | Currently NO. Decision: cache key does NOT include provider. Same prompt → cache same response across providers? Reconsider: ADD `effectiveProviderId` to key to be safe. Update Phase 1 hash if needed. **Open question — confirm before implementing.** |
| `max_tokens` undefined vs default mismatch | Normalize at extractCacheKey: undefined → null |

## Security Considerations

- Cache shared globally — confirm v1 has no per-user routing. If multi-user lands later, add user id to key (out of scope here, documented in plan).
- Cached body may contain PII from prompts. v1 in-memory only; cleared on restart. Document.

## Red Team Adjustments — 2026-05-24

Findings **#1, #2, #3, #5, #6** ACCEPTED. **PHASE STATUS: CANCELLED for v1.**

### Why cancelled

1. **Anthropic `system` field missing from key (finding #1)** — Claude `/v1/messages` carries system at `body.system` (string OR array per `claude-to-openai.js:24-27`). Plan hashes only `messages` → cache poisoning. NOT a 5-min fix — requires audit of every chat-format flavor (OpenAI, Claude, Gemini, Responses).
2. **Provider in key (finding #2)** — `chat.js:121-138` (combo fan-out) + `:195-281` (round-robin fallback) mean the responding provider is non-deterministic. Cache hit may serve provider B's response when caller expected provider A. Brutal-correctness focus violated.
3. **5 route entry points + format translation (finding #3)** — `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1beta` Gemini, `/v1/api/chat` all converge on `handleChat` AFTER format translation. Gemini route POST-transforms response (`/v1beta/models/[...path]/route.js:96-260`). Cache placement decision affects correctness — wrap inside `handleChat` causes cross-format pollution.
4. **Wrap target wrong (finding #5)** — `handleChatCore` returns `{ success, response: Response }`, NOT `{ ok, body }`. `@/sse/services/upstream-dispatch` module DOES NOT EXIST (grep returns zero). Phase 3 entire mock pattern phantom.
5. **Body mutation pre-handler (finding #6)** — `chatCore.js:49-56` spreads body for thinking config. `chat.js:240` rewrites model. `nonStreamingHandler.js:179-198` deletes response fields. Cache hit returns body that diverges from a fresh upstream call.

### v1 path (revised)

**v1 caches EMBEDDINGS ONLY.** Chat re-considered for v2 plan after:
1. Audit of all 5 route entry points + decide cache layer (route vs handler vs core)
2. Resolve provider key inclusion (full provider name AFTER combo resolution)
3. Add `system` field handling for Claude format
4. Choose between "wrap before translator" (cache per-route) vs "wrap after translator" (cache shared OpenAI shape) — both have trade-offs

Trade-off cost of cutting chat: ROI loss. Most token spend is chat. Embeddings is the safer "prove cache works" surface.

### Phase status

**Cancelled.** Effort moves to Phase 4 reinforcement (now sole wire point). Plan.md success criteria updated to embeddings-only.
