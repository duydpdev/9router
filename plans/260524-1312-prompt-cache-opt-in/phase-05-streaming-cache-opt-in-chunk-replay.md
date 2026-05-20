---
phase: 5
title: "Streaming cache opt-in (chunk replay)"
status: pending
priority: P2
effort: "5-6h"
dependencies: [1, 2, 3]
---

# Phase 5: Streaming cache opt-in (chunk replay)

## Overview

Optional streaming cache: when client sends BOTH `x-router-cache: ttl=<s>` AND `x-router-cache-stream: true` AND `stream: true` in body, 9Router captures chunks during first call, replays them byte-identical on subsequent hits. Memory pressure managed by per-entry size cap. Default OFF (Phase 2 sets default bypass on `stream:true`).

## Requirements

### Functional
- Stream capture: wrap upstream SSE stream, tee each chunk into:
  1. The downstream client (existing flow)
  2. A `chunks: string[]` buffer
- On stream complete (`[DONE]` or stream end): persist `{ chunks, completedAt }` to cache via `cache.set(key, { kind: "stream", chunks }, ttl)`
- On stream error or abort: DO NOT cache (partial responses break replay)
- On cache hit for a streaming cached entry: replay chunks via SSE with same Content-Type + delimiter pattern (`data: <chunk>\n\n`), then `data: [DONE]\n\n`
- Per-entry size cap: if `totalBytes > STREAM_CACHE_MAX_ENTRY_BYTES` (default 5MB), abort capture (don't cache), drop buffer
- Same key as non-streaming: `hashKey({ model, messages, temperature, max_tokens, tools, seed })`
- Same bypass rules: tools/temperature override stream-enabled

### Non-functional
- Replay latency per chunk < 10ms (Node event loop reschedule)
- Capture overhead per chunk < 1ms
- Per-entry abort never breaks downstream client flow

## Architecture

```
src/sse/services/stream-capture.js
  ├── createCaptureTee(upstreamStream, { maxBytes }) → { downstream, completion }
  │     downstream: ReadableStream forwarded to client
  │     completion: Promise<{ ok: true, chunks: string[] } | { ok: false, reason }>
  │
  └── replayCachedStream(chunks, responseWriter) → Promise
        writes each chunk through downstream, ends with [DONE]

src/sse/handlers/chat.js (streaming path)
  ├── if directive.enabled && directive.streamEnabled:
  │     hit = cache.get(key)
  │     if hit && hit.kind === "stream":
  │       return replayCachedStream(hit.chunks, res)
  │     [miss → call upstream]
  │     tee = createCaptureTee(upstream, { maxBytes: STREAM_CACHE_MAX_ENTRY_BYTES })
  │     pipe tee.downstream → res
  │     on tee.completion ok: cache.set(key, { kind: "stream", chunks }, ttl)
```

## Related Code Files

- Create: `src/sse/services/stream-capture.js`
- Modify: `src/sse/handlers/chat.js` (streaming branch)
- Modify: `open-sse/handlers/chatCore.js` if streaming dispatch lives there
- Modify: `src/sse/services/prompt-cache.js` — accept either `body` (object) or `{ kind: "stream", chunks }` value shape. Update byte accounting for chunks array (sum of `Buffer.byteLength` per chunk).
- Create: `tests/unit/prompt-cache-streaming-capture.test.js`
- Create: `tests/unit/prompt-cache-streaming-replay.test.js`

## TDD — failing tests first

```js
// tests/unit/prompt-cache-streaming-capture.test.js
import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";

describe("createCaptureTee", () => {
  it("forwards chunks to downstream + collects into buffer", async () => {
    const { createCaptureTee } = await import("@/sse/services/stream-capture.js");
    const upstream = Readable.from(["chunk1", "chunk2", "[DONE]"]);
    const { downstream, completion } = createCaptureTee(upstream, { maxBytes: 1000 });

    const forwarded = [];
    for await (const c of downstream) forwarded.push(c.toString());

    const result = await completion;
    expect(forwarded).toEqual(["chunk1", "chunk2", "[DONE]"]);
    expect(result.ok).toBe(true);
    expect(result.chunks).toEqual(["chunk1", "chunk2", "[DONE]"]);
  });

  it("aborts capture when maxBytes exceeded — downstream still flows", async () => {
    const upstream = Readable.from(["x".repeat(600), "y".repeat(600)]);
    const { downstream, completion } = createCaptureTee(upstream, { maxBytes: 1000 });
    const forwarded = [];
    for await (const c of downstream) forwarded.push(c.toString().length);
    const result = await completion;
    expect(forwarded).toEqual([600, 600]); // downstream got both
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_bytes_exceeded");
  });

  it("upstream error → completion ok=false, no cache", async () => { ... });
});
```

```js
// tests/unit/prompt-cache-streaming-replay.test.js
describe("replayCachedStream", () => {
  it("replays chunks as SSE then [DONE]", async () => {
    const { replayCachedStream } = await import("@/sse/services/stream-capture.js");
    const writes = [];
    const writer = { write: (c) => writes.push(c.toString()), end: () => {} };
    await replayCachedStream(["data: c1\n\n", "data: c2\n\n"], writer);
    expect(writes).toEqual(["data: c1\n\n", "data: c2\n\n", "data: [DONE]\n\n"]);
  });
});
```

Plus integration test wiring the streaming chat handler with both capture and replay across two calls.

## Implementation Steps

1. **Test-first:** write 2 unit tests + 1 integration test. Run → red.
2. Create `src/sse/services/stream-capture.js`:
   - `createCaptureTee(upstreamStream, { maxBytes })`:
     - return a new `Readable` (downstream)
     - on each upstream chunk: push to downstream AND append to `chunks[]` IF total ≤ maxBytes
     - if exceeded: set `aborted = true`, drop chunks, continue forwarding
     - on upstream end: resolve completion `{ ok: !aborted, chunks: aborted ? [] : chunks, reason }`
     - on upstream error: resolve `{ ok: false, reason: "upstream_error", error }`
3. Implement `replayCachedStream(chunks, writer)`:
   - For each chunk: `writer.write(chunk)`, optionally `await new Promise(setImmediate)` to allow event loop
   - At end: `writer.write("data: [DONE]\n\n")`, `writer.end()`
4. Update `src/sse/services/prompt-cache.js` to accept both shapes:
   - On `set`: detect shape, compute size: object → `Buffer.byteLength(JSON.stringify(body))`; `{kind:"stream", chunks}` → sum of chunk byte lengths
   - On `get`: return as-is; caller dispatches on `kind`
5. Modify chat streaming handler — wire capture + replay per architecture
6. Run tests. Iterate green.
7. Manual SSE smoke test: curl with stream + cache header twice; verify second call returns byte-identical chunks.

## Success Criteria

- [ ] First streaming request with both headers → chunks captured, response replayed normally
- [ ] Second streaming request with same key → cache hit, chunks replayed byte-identical, NO upstream call
- [ ] Stream exceeds `maxBytes` → cache skipped, downstream still receives full response
- [ ] Stream error mid-flight → cache skipped, downstream gets error per existing flow
- [ ] tools / temperature>0 still bypass even with streaming enabled
- [ ] `x-router-cache-stream: true` without `x-router-cache: ttl=...` → disabled (stream-only header is meaningless)
- [ ] Per-entry byte cap configurable via `STREAM_CACHE_MAX_ENTRY_BYTES` env
- [ ] No regression in existing streaming chat tests
- [ ] `npm run build` clean

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Chunk boundary differs between providers (Claude vs OpenAI SSE format) | Cache stores RAW chunks as received; replay produces identical bytes regardless of provider format |
| Replay too fast → client backpressure ignored | Optional `setImmediate` between chunks; configurable replay-rate if needed (v2) |
| Cache buffer holds 5MB per entry — memory blow-up | Per-entry cap + total LRU byte budget enforced together |
| Stream abort by client mid-capture leaves partial data | Detect via `req.signal.aborted` → abort capture, drop chunks |
| `[DONE]` sentinel varies per upstream (some providers omit) | Capture-tee forwards literal upstream bytes; replay writes literal captured bytes + appends `[DONE]` ONLY if last chunk doesn't end with it |
| Trailer metadata (usage tokens in last SSE event) replays stale usage stats | Document: cached responses bill 0 tokens (cache hit metric). Usage table updates skip on cache hit. |

## Security Considerations

- Same PII concern as non-streaming. In-memory only; clears on restart.
- Replay does NOT include `x-request-id` from original upstream call — generate fresh per replay if downstream depends on it (most don't)
- Cached streams may contain partial sensitive content if user input had it; same risk as non-streaming

## Red Team Adjustments — 2026-05-24

Findings **#4, #12** ACCEPTED. **PHASE STATUS: CANCELLED for v1.**

### Why cancelled

1. **Memory + token leak on client abort (finding #4)** — `createCaptureTee` has no `signal` param. Client disconnect mid-stream → tee continues draining upstream → memory grows + provider tokens burn. Plan's mitigation "Detect via `req.signal.aborted`" is unrealized in the architecture as designed.
2. **Format translation per provider (finding #3 cross-impact)** — Chunks captured are post-translation (OpenAI SSE shape from `chatCore/streamingHandler.js`). Gemini route post-transforms again. Replay format depends on cache placement; ambiguity unresolved.
3. **Provider non-determinism (finding #2 cross-impact)** — Streaming responses share the same provider-routing issue as non-streaming chat.
4. **Scope creep for default OFF (finding #12)** — Two opt-in headers needed (`x-router-cache: ttl=300` + `x-router-cache-stream: true`). Phase 5 retroactively amends Phase 1 contract (union value shape). Effort 5-6h is largest of all six phases for a feature gated by 3 conditions.
5. **`[DONE]` sentinel synthesis** — Gemini SSE has no `[DONE]` (verified `[...path]/route.js:189` "Drop empty lines and the OpenAI [DONE] sentinel"). Replay format per source format = additional complexity.

### v1 path

**v1 ships non-streaming cache only.** Streaming cache is a v2 candidate requiring:
- Signal-aware capture tee with proper upstream abort propagation
- Format-aware replay (per-provider SSE shape)
- Provider in cache key
- Token-billing accounting for cached responses

### Phase status

**Cancelled.** Phase 1 contract simplified — value type is plain JSON body, no union shape. Phase 4 wires non-streaming embeddings only.
