---
title: "Opt-In Prompt Cache (in-memory LRU, header-driven)"
description: "Opt-in prompt-level cache via per-request header. In-memory LRU, strict key (model+messages+temp+max_tokens+tools), bypass on tools/temperature, streaming opt-in. Default OFF — zero impact on existing clients."
status: completed
priority: P2
branch: "feature/dylan-improve"
tags: ["cache", "performance", "cost-savings", "sse"]
blockedBy: ["260524-1311-mcp-control-plane-server"]
blocks: []
created: "2026-05-24T06:12:04.089Z"
createdBy: "ck:plan"
source: skill
---

# Opt-In Prompt Cache

## Overview

Identical prompts hammered repeatedly (test loops, lint cycles, warm-up patterns, agent retries) re-spend tokens and quota. This plan adds an opt-in cache: client sends `x-router-cache: ttl=<seconds>`, 9Router caches the response, second identical request within TTL returns cached body. Default OFF — zero impact on existing traffic.

**Brutal correctness focus:** wrong cache keys = silent broken responses. Plan ships with strict key (literal model+messages+params hash), bypasses on `tools` field and `temperature > 0`, defers streaming cache to opt-in (`x-router-cache-stream: true`).

## Phases

| Phase | Name                                                                                            | Status  |
| ----- | ----------------------------------------------------------------------------------------------- | ------- |
| 1     | [Foundation (LRU + SHA-256 key hasher + singleton + tests-first)](./phase-01-foundation-lru-sha-256-key-hasher-singleton-tests-first.md) — **see Red Team: Map+lastAccess, no setInterval, public clear()** | Completed |
| 2     | [Header Parsing + Bypass Conditions](./phase-02-header-parsing-bypass-conditions.md) — **see Red Team: Headers API, undefined-temp bypass** | Completed |
| 3     | [Wire into chat handler](./phase-03-wire-into-chat-handler.md) — **CANCELLED v1** per Red Team #1, #2, #3, #6 | Cancelled |
| 4     | [Wire into embeddings handler](./phase-04-wire-into-embeddings-handler.md) — **see Red Team: at route layer, handle Response shape, token-array bypass** | Completed |
| 5     | [Streaming cache opt-in (chunk replay)](./phase-05-streaming-cache-opt-in-chunk-replay.md) — **CANCELLED v1** per Red Team #4, #12 | Cancelled |
| 6     | [Docs + E2E benchmark](./phase-06-docs-e2e-benchmark.md) — **see Red Team: embeddings-only, document serverless limitation** | Completed |

## Dependencies

- **blockedBy:** `260524-1311-mcp-control-plane-server` — wait for MCP to ship + receive feedback before starting cache work. The two features are independent code-wise, but sequential delivery reduces risk (focus on one correctness-critical surface at a time).
- No other cross-plan blocking.

## Context Links

- Brainstorm: [reports/brainstorm-2026-05-24-mcp-and-prompt-cache.md](../reports/brainstorm-2026-05-24-mcp-and-prompt-cache.md)

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ /v1/chat/completions  /v1/embeddings  (request enters route)         │
│        ↓                                                             │
│   parseCacheHeader(req) → { enabled, ttl, stream, bypass }           │
│   if bypass → fall through (existing flow, no cache touch)           │
│        ↓                                                             │
│   key = sha256(model+JSON(messages)+temp+max_tokens+tools)           │
│   hit = cache.get(key)                                               │
│   if hit && !expired → return cachedBody + x-router-cache-hit:true   │
│        ↓ miss                                                        │
│   call upstream (existing flow)                                      │
│   if response.ok && cacheable → cache.set(key, body, ttl)            │
│   return body + x-router-cache-hit:false                             │
└──────────────────────────────────────────────────────────────────────┘

Cache Singleton (src/sse/services/prompt-cache.js):
  ├── Map<key, { body, expiresAt, sizeBytes }>
  ├── LRU eviction when total sizeBytes > MAX_BYTES (default 500MB)
  ├── TTL sweep on every get (lazy) + periodic (every 60s)
  └── stats: hits, misses, evictions, currentBytes, entryCount
```

## Design decisions (locked from brainstorm)

| Decision                                  | Choice                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Activation                                | Opt-in per request via `x-router-cache: ttl=<s>` header                       |
| Default state                             | OFF — zero impact on existing clients                                          |
| Storage                                   | In-memory LRU (Map + byte-bound). Restart = clear. Persistent layer = future. |
| Cache key                                 | sha256(model + JSON.stringify(messages) + temperature + max_tokens + tools)   |
| Bypass: temperature > 0                   | YES (non-deterministic)                                                       |
| Bypass: `tools` field present             | YES (tool_use side-effect risk)                                               |
| Bypass: `stream: true`                    | YES by default. Opt-in via `x-router-cache-stream: true`                       |
| Bypass: explicit `x-router-cache: no-store` | YES                                                                          |
| Response headers added                    | `x-router-cache-hit: <true\|false>`, `x-router-cache-ttl-remaining: <s>`     |
| Invalidation API                          | NONE — v1 only TTL + restart                                                  |
| Metrics UI                                | NONE — v1 logs to console only                                                |
| Cross-provider dedup (gpt-4 vs claude-3)  | NO — strict per-model cache only                                              |
| Multi-user scoping                        | N/A in v1 (no multi-user yet)                                                 |
| Max byte budget                           | 500MB default, ENV `PROMPT_CACHE_MAX_BYTES` to override                       |

## Methodology: TDD per phase

Every phase opens with failing Vitest tests pinning the desired behavior, then minimum production change to pass. Cache module is correctness-critical; test matrix dense by design (positive, negative, bypass, expiry, eviction, header parsing).

Test file naming: `tests/unit/prompt-cache-<feature>.test.js`.

## Out of scope (v1)

- Cache invalidation REST endpoint (v1 uses TTL + server restart)
- Cache stats dashboard / chart UI
- Cross-provider cache key normalization (no `gpt-4` ↔ `claude-3` dedup)
- Persistent disk cache (better-sqlite3 layer)
- Per-user cache isolation (waits for multi-user feature)
- Semantic similarity caching (embedding-based)
- Cache warming jobs

## Success criteria (whole plan)

- [ ] Request without `x-router-cache` header → byte-for-byte identical behavior to pre-feature
- [ ] Request with `x-router-cache: ttl=300` → first call upstream, second returns cached body with `x-router-cache-hit: true`
- [ ] Different `temperature` / `max_tokens` / `tools` → cache miss (strict key)
- [ ] `tools` field present → cache bypassed regardless of header
- [ ] `temperature > 0` → cache bypassed regardless of header
- [ ] `stream: true` (default) → cache bypassed
- [ ] `stream: true` + `x-router-cache-stream: true` → chunks captured + replayed byte-identical
- [ ] LRU eviction triggers when budget exceeded (oldest evicted)
- [ ] TTL expiry returns miss after `ttl` seconds elapse
- [ ] Response headers `x-router-cache-hit` + `x-router-cache-ttl-remaining` present on both hit and miss
- [ ] All new Vitest tests pass; zero regressions in existing `/v1` test suite

## Open questions

- Cache key normalization — strip whitespace / lowercase model names before hashing? Default: NO (strict literal). Revisit if users report "same prompt different model alias misses".
- `x-router-cache-stream: true` cost overhead (memory pressure from buffering chunks) — Phase 5 measures
- Should cache key include `system` field separately from `messages[0]`? Current plan: `messages` array is hashed verbatim, so any field in there is part of the key. OK as-is.
- Bypass on `seed` field present? OpenAI `seed` parameter aims for determinism. Currently `seed` not in cache key → cached response may not honor seed if changed. Decision: ADD seed to cache key in Phase 1 schemas if `seed` field detected in chat handler.

## References

- Brainstorm decisions: B1-B7 in `reports/brainstorm-2026-05-24-mcp-and-prompt-cache.md`
- Existing handlers to wrap (post-red-team scope): `src/sse/handlers/embeddings.js`, `open-sse/handlers/embeddingsCore.js`. Chat handler DEFERRED to v2.

## Red Team Review

### Session — 2026-05-24

**Reviewers spawned:** 3 (Security Adversary blocked by Anthropic policy; Failure Mode Analyst + Assumption Destroyer + Scope Critic returned full reports).
**Reviewer outcomes:** 30 raw findings → 15 deduped (all evidence-backed with `file:line`).
**Severity breakdown:** 5 Critical, 9 High, 1 Medium. ALL 15 ACCEPTED.

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Anthropic `system` field NOT in cache key — Claude `/v1/messages` puts system at `body.system` top-level, not in `messages[]`. Two requests w/ same `messages` + different `system` collide → cache poisoning. Verified at `src/app/api/v1/messages/route.js:32-35` + `open-sse/translator/request/claude-to-openai.js:24-27` | Critical | Accept | plan.md, Phase 1 |
| 2 | Cache key omits `provider`/`effectiveProvider`. Combo + round-robin fallback non-deterministic → response from provider B served on cache hit when caller expected provider A. Verified at `src/sse/handlers/chat.js:121-138, 195-281` | Critical | Accept | plan.md, Phase 1 |
| 3 | 5 distinct route entry points (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1beta/models/[...path]` Gemini, `/v1/api/chat`) all hit `handleChat` AFTER format translation. Gemini route post-transforms response via `transformOpenAISSEToGeminiSSE` — cache placement determines correctness. Verified at `src/app/api/v1beta/models/[...path]/route.js:90-260`, `src/app/api/v1/messages/route.js:32-35` | Critical | Accept | plan.md, Phase 3 (cancel), Phase 4 |
| 4 | Stream-capture tee continues draining upstream after client abort → memory + token leak. `createCaptureTee(upstream, opts)` signature has NO `signal` param. Verified at `open-sse/utils/streamHandler.js:42-178` (existing pattern uses `streamController.abort`) | Critical | Accept | Phase 5 (cancel) |
| 5 | `handleChatCore` and `handleEmbeddingsCore` return `{ success, response: Response }` NOT `{ ok, body }`. `@/sse/services/upstream-dispatch` does NOT exist — wrap target wrong, test mocks reference phantom module. Verified at `open-sse/handlers/chatCore.js:30`, `open-sse/handlers/embeddingsCore.js:117-125`; grep for `upstream-dispatch` returns zero matches | Critical | Accept | plan.md, Phase 3 (cancel), Phase 4 |
| 6 | Cache stores mutated body — `chatCore.js:49-56` spreads body for thinking config, `chat.js:240` rewrites model to `${provider}/${model}`, `nonStreamingHandler.js:179-198` deletes response fields. Hit vs miss path diverge | High | Accept | Phase 3 (cancel) |
| 7 | Singleton + `setInterval` handle leak across vitest test files. `__resetForTests()` clears entries but NOT interval handle. Worker process hangs on suite exit. Verified `tests/vitest.config.js:1-23` (no pool isolation) | High | Accept | Phase 1 |
| 8 | Single entry > `maxBytes` causes infinite eviction loop or silent budget breach. No test for `body.size > maxBytes` case | High | Accept | Phase 1 |
| 9 | `temperature: undefined/null` treated as cacheable — but OpenAI/Anthropic default `temperature: 1.0` (NON-deterministic). Cache poisons with random outputs | High | Accept | Phase 2 |
| 10 | `embeddings.input` can be `number[]` / `number[][]` (pre-tokenized form) — plan doesn't handle. Big token arrays blow byte budget; hash cost prohibitive | High | Accept | Phase 4 |
| 11 | In-memory cache + serverless deployments (Vercel/Lambda) cold-start tear-down → hit rate ≈ 0. Plan never matches deployment topology | High | Accept | Phase 6, plan.md |
| 12 | Phase 5 streaming chunk replay = scope creep (default OFF, dual-header opt-in, multiple bypass conditions). Phase 5 retroactively amends Phase 1 contract | High | Accept | Phase 5 (cancel) |
| 13 | LRU doubly-linked list + setInterval TTL sweep + byte-budget = over-engineered for default-OFF feature. Simpler `Map` + `lastAccess` timestamp + lazy expire sufficient | High | Accept | Phase 1 |
| 14 | Phase 1 contract amended by Phase 3 (`ttlRemainingSec`) and Phase 5 (union value shape). TDD-first hollow when later phases rewrite API | High | Accept | Phase 1 |
| 15 | Header parsing tests use `new Map()` but production uses Web `Headers` (case-insensitive). Test/prod divergence on uppercase headers like `X-Router-Cache` | Medium | Accept | Phase 2 |

**Files modified:** `plan.md`, all 6 phase files. Phase 3 and Phase 5 CANCELLED for v1.

### MAJOR scope rework (post-red-team)

**v1 reduced to embeddings-only.** Chat handler ships in v2 after open correctness questions resolved:
- system field handling (Anthropic format)
- provider key inclusion (combo + fallback determinism)
- cache placement (before vs after translator)
- response shape (`Response` object vs body JSON)
- handler body mutation isolation

**v1 phases:**

| Phase | Name | Status | Notes |
|-------|------|--------|-------|
| 1 | Foundation — simpler Map+lastAccess, no setInterval, no doubly-linked list | Pending | Rewrite per #7, #8, #13, #14 |
| 2 | Header parsing — single header `x-router-cache: ttl=300`, fix `Headers` API usage | Pending | Apply #9, #15 |
| 3 | ~~Wire into chat handler~~ | **CANCELLED** | Defer to v2 per #1, #2, #3, #6 |
| 4 | Wire into embeddings handler — at `/v1/embeddings/route.js` BEFORE handleEmbeddings, store JSON body, reconstruct Response on hit | Pending | Apply #5, #10, #11 |
| 5 | ~~Streaming opt-in~~ | **CANCELLED** | Defer to v2 per #4, #12 |
| 6 | Docs + E2E (embeddings only) | Pending | Document serverless limitation per #11 |

**v1 scope cuts (locked):**
- Chat handler — CUT (defer v2 after correctness questions)
- Streaming cache — CUT (defer v2)
- Doubly-linked list LRU — REPLACE with simpler Map+lastAccess
- `setInterval` TTL sweep — DROP (lazy expire only)
- `__resetForTests()` dunder method — REPLACE with public `clear()`
- `x-router-cache-stream: true` second header — DROP (streaming cut)
- `x-router-cache-ttl-remaining` response header — DROP (telemetry without consumer)
- `scripts/cache-bench.js` — DROP (gold plating, not in CI)
- 4 split test files for Phase 1 — REPLACE with 1 file, 4 describe blocks
- `extractCacheKeyEmbeddings` separate function — UNIFIED with `extractCacheKey()`

**Effort revised:** was ~26-32h across 6 phases. **Now ~10-14h across 3 active phases** (1, 2, 4 + 6).

### Whole-Plan Consistency Sweep — 2026-05-24

- **Files re-read:** `plan.md`, all 6 `phase-*.md` files
- **Decision deltas applied:** 15 findings + major scope cut to embeddings-only
- **Reconciled stale references:**
  - "wraps chat + embeddings" → "wraps embeddings only" (plan.md success criteria + architecture)
  - `extractCacheKey` + `extractCacheKeyEmbeddings` → single unified `extractCacheKey()` for embeddings
  - Cache value union shape `{kind:"stream", chunks}` → DROPPED (Phase 5 cancelled)
  - `setInterval` TTL sweep → DROPPED (lazy expire only)
  - Doubly-linked list LRU → simpler Map+lastAccess
  - `__resetForTests` method → public `clear()` method
  - `x-router-cache-stream` header → DROPPED
  - `x-router-cache-ttl-remaining` response header → DROPPED
  - `@/sse/services/upstream-dispatch` mock path → DROPPED (mock `handleEmbeddingsCore` instead)
  - `result.body` / `result.ok` → `response.json()` from cloned Response
- **Unresolved contradictions:** 0
- **Status:** Plan adjustments authoritative. Phase 3 + 5 marked cancelled. Original body retained for traceability; `## Red Team Adjustments — 2026-05-24` sections in each phase supersede conflicting earlier prose.

### Post-review fix pass — 2026-06-02

Second-pass audit caught issues the red-team + sweep missed (new findings, not reversals):

1. **CRITICAL — Phase 4 return-shape bug.** Route-layer wrap assumed `handleEmbeddings` returns `{ success, response }` and gated caching on `result.success`. Verified `src/sse/handlers/embeddings.js:135,147` → `handleEmbeddings` returns a **raw `Response`**; `{ success, response }` is the inner `handleEmbeddingsCore` shape (`open-sse/handlers/embeddingsCore.js:117-125`). With the wrong shape `result.success` is `undefined` → cache `set()` never runs → 0% hit, silent. Fixed: gate on `response.ok`, `response.clone().json()`. Test mock corrected to return raw `Response` (was re-introducing the finding-#15 test/prod divergence).
2. **Frontmatter deps stale.** Phase 4 `dependencies: [1,2,3]` → `[1,2]` (3 cancelled). Phase 6 `[1,2,3,4,5]` → `[1,2,4]` (3,5 cancelled).
3. **Bypass ownership.** `isTokenInput` + 100KB `oversize_input` cap now defined in Phase 2 (`parseCacheDirective` module owns all bypass) with tests; Phase 4 reduced to a consumer pointer.
4. **Stale-body readability.** Added superseded-banner to Phase 1/4/6 headers so cook implements from `## Red Team Adjustments`, not the retained pre-review draft.

**Unresolved contradictions after fix pass:** 0.
