---
title: "MCP control-plane + prompt cache — brainstorm summary"
date: 2026-05-24
author: brainstorm
status: agreed
branch: feature/dylan-improve
---

# Brainstorm: MCP control-plane server + opt-in prompt cache

## Problem statement

9Router is a local AI router (Next.js, 422 JS files, ~70K LOC) exposing OpenAI-compat `/v1` with multi-provider fallback. Two product gaps blocking growth:

1. **No agent-native control surface.** Claude Desktop / Claude Code skills can hit `/v1` for chat but cannot introspect or reconfigure 9Router inside a conversation (quota, providers, combo switch, test connection).
2. **No request-level cache.** Identical prompts (test loops, lint cycles, warm-up patterns, agent retries) repeatedly hit upstreams — wasted tokens and quota.

## Solution scope (locked)

Two independent features, **MCP first then cache** (sequential, not parallel):

### Feature A: MCP control-plane server (P2, ~2-3 days)

- **Transport:** stdio + HTTP SSE (both, via `@modelcontextprotocol/sdk`)
- **Runtime:** same Next.js process. New route `/api/mcp` for HTTP SSE. Standalone `9router mcp` CLI binary for stdio mode that wraps an HTTP call to the running Next.js instance.
- **Tool surface (control-plane only — NO chat tool):**
  - `router.list_providers` — return active OAuth + API-key connections with status flags (active / needsReauth / cooldown)
  - `router.get_quota_status` — per-provider quota / cost-day-to-date
  - `router.get_usage_today` — aggregate request count + token totals
  - `router.test_connection(id)` — ping a connection, return latency + auth state
  - `router.switch_combo(name)` — change active model combo
  - `router.mark_connection_needs_reauth(id, reason)` — manual override
- **NO auth in v1** (local-trust assumption matches `/v1` today). Auth deferred.
- **NO MCP resources/prompts.** v1 ships tools only.

### Feature B: Opt-in prompt cache (P2, ~4-7 days)

- **Activation:** per-request header `x-router-cache: ttl=<seconds>`. Default OFF — zero impact on existing clients.
- **Storage:** in-memory LRU (Map + size-bounded). v1 max ~500MB configurable via env. Restart = clear. Persistent SQLite layer is future phase.
- **Key:** strict `sha256(model + JSON.stringify(messages) + temperature + max_tokens + tools)`. Cache hit only when ALL params identical.
- **Skip conditions (cache bypass):**
  - `temperature > 0` (non-deterministic)
  - `tools` field present (tool_use side-effect risk)
  - `stream: true` AND `x-router-cache-stream: false` (default skip streams in v1)
  - Header `x-router-cache: no-store` explicit
- **Streaming cache (gated):** when `x-router-cache-stream: true`, capture chunks during first call, replay on hit. v1 keeps disabled by default.
- **Response headers added:** `x-router-cache-hit: <true|false>`, `x-router-cache-ttl-remaining: <s>`
- **NO invalidation API.** v1 only TTL expiry + server restart.
- **NO metrics UI.** v1 logs hits/misses to console.

## Out of scope (v1)

- MCP authentication / API-key gating (matches `/v1` local-trust)
- Cache invalidation REST endpoint
- MCP resources / prompts surface
- Cache stats dashboard / chart
- Cross-provider cache deduplication (gpt-4 vs claude-3 same prompt)
- Multi-user cache isolation (no multi-user yet)
- Persistent disk cache

These notes carried forward to `plan.md` "Future phases" section.

## Acceptance criteria

### Feature A (MCP)

- [ ] Add `@modelcontextprotocol/sdk` dep, register MCP server at boot
- [ ] HTTP SSE transport mounted at `/api/mcp` returns valid `initialize` handshake
- [ ] stdio binary `9router mcp` (or `bin/mcp.js`) talks to running 9Router on localhost:20128
- [ ] 6 tools registered and callable: `router.list_providers`, `router.get_quota_status`, `router.get_usage_today`, `router.test_connection`, `router.switch_combo`, `router.mark_connection_needs_reauth`
- [ ] Each tool returns JSON matching declared input/output schema (Zod or JSON Schema)
- [ ] Claude Desktop config snippet documented in `docs/integrations/mcp.md` with copy-paste mcp.json entry
- [ ] Vitest test suite hits MCP server in-process via SDK client, asserts 6 tools listable + 1 happy-path call per tool
- [ ] No regressions on existing `/v1` tests

### Feature B (Cache)

- [ ] Request without header → identical behavior pre-feature (zero side effects)
- [ ] Request with `x-router-cache: ttl=300` → first call upstream, second call within 300s returns cached body with `x-router-cache-hit: true`
- [ ] After TTL → cache miss, upstream fetched fresh
- [ ] Cache key strict — different `temperature` / `max_tokens` / `tools` → cache miss
- [ ] `tools` present → cache bypassed regardless of header
- [ ] LRU eviction when memory budget exceeded (test: 1000 fake entries on 1MB budget → oldest evicted)
- [ ] Streaming opt-in test: capture + replay chunks identical byte-for-byte
- [ ] Vitest covers: hit, miss, expire, bypass-on-tools, bypass-on-temperature, LRU evict, header echo, stream replay

## Touchpoints (files)

### Feature A new files
- `src/app/api/mcp/route.js` — Next.js route handler for HTTP SSE transport
- `src/lib/mcp/server.js` — MCP server instance + tool registration
- `src/lib/mcp/tools/*.js` — one file per tool (or grouped logically)
- `bin/mcp.js` — stdio wrapper binary
- `docs/integrations/mcp.md` — user-facing docs

### Feature A modified
- `package.json` — add `@modelcontextprotocol/sdk` dep, add `bin` entry for `9router-mcp`
- `src/instrumentation.js` or `src/server-init.js` — register MCP server at boot (HTTP path)
- `README.md` — link to mcp.md

### Feature B new files
- `src/sse/services/prompt-cache.js` — LRU cache + key hasher + TTL gate
- `tests/unit/prompt-cache.test.js`

### Feature B modified
- `src/sse/handlers/chat.js` — wrap upstream call with cache check
- `src/sse/handlers/embeddings.js` — same wrap (embeddings = obvious cache win)
- `src/sse/services/auth.js` or shared executor — header parsing
- `open-sse/handlers/chatCore.js` — for cache hit shortcircuit in streaming path
- `README.md` — document `x-router-cache` header section

## Build order (locked)

1. **MCP first** (Phase A): smaller scope, lower risk, ship as v0.5.0 minor
2. **Cache second** (Phase B): wait for MCP feedback. Cache needs more design time for correctness.

## Risks + mitigations

| Feature | Risk | Mitigation |
|---------|------|------------|
| MCP | Tool schema drift across SDK versions | Pin `@modelcontextprotocol/sdk` exact version; test against Claude Desktop release matrix |
| MCP | `switch_combo` mutation racing with running requests | Atomic swap of combo ref; document brief inconsistency window |
| MCP | stdio binary launch order — Next.js must be up first | Add health-check ping with retry-backoff in `bin/mcp.js` |
| Cache | Wrong key → false hit → silent broken response | Strict key (D2 decision); skip-on-tools; comprehensive test matrix |
| Cache | Memory blow-up under concurrent unique prompts | LRU + hard byte budget; track total size, not entry count |
| Cache | TTL of streamed responses replays stale tool_use | Streams cache-bypassed by default; opt-in only |
| Cache | Cross-test leakage in vitest | Reset cache singleton in `beforeEach` |

## Success metrics

- **MCP:** at least 3 community user reports of "set up MCP in Claude Desktop, can list providers from chat" within 2 weeks of release. Zero regression issues on `/v1`.
- **Cache:** measurable token-save on a benchmark run (1000 repeated identical prompts → expect 99% hit rate, near-zero upstream calls after warmup). Latency on hit < 5ms.

## Future phases (not in v1)

- MCP auth via API key (if remote MCP deployments emerge)
- MCP resources/prompts surface
- Persistent cache (better-sqlite3 layer)
- Cache invalidation API + dashboard UI
- Cross-provider cache key normalization (model alias mapping)
- Cache metrics dashboard
- Multi-user cache scoping (when multi-user lands)

## Open questions

- Should `switch_combo` MCP tool require a confirmation dance (preview → commit) to prevent accidental config changes from LLM-hallucinated arguments? Default in plan: NO confirmation, direct apply. Revisit if real-world misuse.
- Cache key normalization — should we strip whitespace / lowercase model names before hashing? Default: NO (strict literal). Adds debug clarity.
- MCP stdio binary install path — npm `bin` entry creates `9router-mcp` globally. Confirm naming during plan.

## Dependencies

- `@modelcontextprotocol/sdk` (latest stable)
- No other new deps

## Next step

User to invoke `/ck:plan` with this report path. Recommended mode: **`/ck:plan` (default)** — feature is additive (new module), not a refactor of critical behavior. TDD mode optional but not required since both features have isolated test surfaces.
