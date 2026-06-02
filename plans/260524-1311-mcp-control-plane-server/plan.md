---
title: "MCP Control-Plane Server (stdio, 3 read-only tools)"
description: "Expose 9Router introspection as MCP tools for Claude Desktop and other stdio MCP clients. Control-plane only (no chat tool). stdio transport; McpServer runs in-process inside the CLI binary. v1 ships 3 read-only tools."
status: completed
priority: P2
branch: "feature/dylan-improve"
tags: ["mcp", "control-plane", "integration", "claude-desktop"]
blockedBy: []
blocks: []  # prompt-cache plan shipped independently (commits c8e1ca5, e600d72); was never a real dependency
created: "2026-05-24T06:11:47.654Z"
createdBy: "ck:plan"
source: skill
---

# MCP Control-Plane Server

## Overview

9Router has no agent-native control surface today. Clients hit `/v1` for chat but cannot ask 9Router questions like "what providers are healthy?" or "what's my quota?" from inside an LLM conversation. This plan adds an MCP server exposing 3 read-only control-plane tools, reusing existing repos. One transport: stdio (Claude Desktop). The CLI binary runs the `McpServer` in-process and opens its own SQLite handle — no HTTP proxy, no coupling to a running Next.js process.

**Scope:** Control-plane introspection only — NO chat tool, NO state-mutating tools in v1. `/v1` remains the single chat surface. HTTP SSE transport, MCP authentication, MCP resources/prompts, and mutating tools (`switch_combo`, `mark_connection_needs_reauth`, `test_connection`) are deferred to v2.

## Phases

| Phase | Name | Status |
| ----- | ---- | ------ |
| 1 | [Foundation: toolchain bootstrap + deps + 3 tool stubs + tests-first](./phase-01-foundation-deps-zod-schemas-tests-first.md) | Complete |
| 2 | [Tool Implementations (3 read-only tools)](./phase-02-tool-implementations-6-control-plane-tools.md) | Complete |
| 3 | [HTTP SSE Transport](./phase-03-http-sse-transport-api-mcp-route.md) — **CANCELLED v1**, deferred to v2 | Cancelled |
| 4 | [stdio Binary (`cli/bin/9router-mcp.js`, in-process)](./phase-04-stdio-binary-bin-mcp-js-health-check.md) | Complete |
| 5 | [Docs + Claude Desktop Integration + E2E](./phase-05-docs-claude-desktop-integration-e2e.md) | Complete |

> Toolchain bootstrap (root `vitest`/`zod`/SDK deps, root `npm test` script) is folded into Phase 1 step 1 — no separate "Phase 0" file. Phase 3 is a tombstone retained for v2 design notes. Phase filenames are stable identifiers; content reflects final scope.

## Dependencies

No cross-plan blocking. Builds on existing repos in `src/lib/db/repos/` (connectionsRepo, usageRepo), warmup notifier ENV, and `src/sse/services/auth.js`. Does NOT touch in-flight reauth plan or warmup-scheduler plan.

## Context Links

- Brainstorm: [reports/brainstorm-2026-05-24-mcp-and-prompt-cache.md](../reports/brainstorm-2026-05-24-mcp-and-prompt-cache.md)
- MCP SDK docs: https://github.com/modelcontextprotocol/typescript-sdk

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Claude Desktop (stdio MCP client)                                     │
│        │ spawns `9router-mcp` subprocess                              │
└────────┼───────────────────────────────────────────────────────────────┘
         ↓
┌──────────────────────────────────────────────────────────────────────┐
│ cli/bin/9router-mcp.js  (no HTTP, no running Next.js required)        │
│   ├─ createMcpServer()                  (McpServer in-process)        │
│   ├─ StdioServerTransport               (talks to Claude Desktop)     │
│   ├─ opens own SQLite handle via shared src/lib/db/ (read-only use)   │
│   └─ Tool dispatcher (3 read-only tools)                              │
│        ├─ router.list_providers   → connectionsRepo.getProviderConnections + getEffectiveStatus
│        ├─ router.get_quota_status → usageRepo.getUsageStats('today') + connectionsRepo
│        └─ router.get_usage_today  → usageRepo.getUsageStats / getChartData('today')
└──────────────────────────────────────────────────────────────────────┘
```

## Design decisions (locked from brainstorm)

| Decision                                  | Choice                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| Tool scope                                | Control-plane only — NO chat tool (clients use `/v1` for chat)  |
| Transports                                | stdio only (Claude Desktop). HTTP SSE deferred to v2            |
| Runtime                                   | CLI binary runs McpServer in-process. MCP source closure bundled into `cli/app/` (updater pattern); sqlite + DATA_DIR resolved like `cli.js`; read-only DB use. `src/lib/mcp/*` uses relative imports only |
| Authentication                            | NONE in v1 (matches local-trust posture of `/v1`)               |
| MCP resources / prompts                   | Out of scope v1 — tools only                                    |
| SDK                                       | `@modelcontextprotocol/sdk` (TypeScript/JavaScript, latest stable) |
| Schema validation                         | Zod (matches MCP SDK examples + repo convention)                |
| Schema versioning                         | Pin SDK to exact version; document tested Claude Desktop version |
| Tool naming                               | Dotted: `router.list_providers`, `router.get_quota_status`, etc. |
| Error responses                           | MCP tool error format with `isError: true` + structured body    |

## Methodology: TDD per phase

Each phase opens with a failing Vitest test or test-suite pinning the desired behavior, followed by the smallest production change to pass. Validation runs against the existing `tests/` directory using Vitest (verified pattern from `tests/unit/*.test.js`). MCP-specific tests use the SDK's in-process Client + linked Server pattern — no external process spawning.

Test file naming convention: `tests/unit/mcp-<feature>.test.js`.

## Out of scope (v1)

- HTTP SSE transport (`/api/mcp` route) — namespace collides with existing `[plugin]` bridge; `SSEServerTransport` deprecated. v2 = Streamable HTTP under a `/api/mcp/control` namespace
- State-mutating tools: `switch_combo` (no `setActive` in `combosRepo`), `mark_connection_needs_reauth` (LLM-hallucination risk), `test_connection` (`getProviderCredentials` has routing-layer side effects). v2 candidates
- MCP authentication / API-key gating (deferred until remote MCP deployments emerge)
- Chat tool surface (use `/v1` instead — avoids duplication and streaming complexity)
- MCP resources surface (`resources/list`, `resources/read`)
- MCP prompts surface (`prompts/list`, `prompts/get`)
- Persistence of MCP session state across server restart
- Rate limiting per MCP client
- Tool result pagination (only `list_providers` could exceed token budget; small for v1)

## Success criteria (whole plan)

- [ ] `@modelcontextprotocol/sdk` + `zod` + `vitest` added to ROOT `package.json`; SDK pinned to exact version
- [ ] Root `npm test` works without the `/tmp/node_modules` bootstrap
- [ ] `createMcpServer()` registers 3 read-only tools using the current SDK `registerTool(name, { description, inputSchema }, handler)` API
- [ ] stdio binary `cli/bin/9router-mcp.js` launches, runs McpServer in-process, lists 3 tools
- [ ] Each of 3 tools has Zod input/output schema + happy-path + edge-case Vitest coverage
- [ ] In-process integration test (SDK Client + Server linked) lists 3 tools + calls each
- [ ] Claude Desktop config snippet works copy-paste (manual verification)
- [ ] `docs/integrations/mcp.md` written with 3-tool reference + stdio setup guide
- [ ] No collision with existing `src/lib/mcp/stdioSseBridge.js` or `src/app/api/mcp/[plugin]/`
- [ ] No regressions on existing `/v1` + reauth + warmup test suites

## Open questions

- (Resolved) `switch_combo`, `mark_connection_needs_reauth`, `test_connection` — CUT from v1 (state-mutating / no safe read-only primitive). Re-add as a dedicated v2 plan once an "active combo" persistence model and a side-effect-free probe helper exist.
- (Resolved) Tool naming locked to `router.*` dotted namespace + snake_case method (validation D-V2). Avoids leading-digit identifier validators.
- (Open) Should v1 binary open the SQLite handle in explicit read-only mode, or open default read-write and rely on tools only calling read functions? Default chosen: latter (simpler; the 3 v1 tools are read-only). Revisit if a write tool lands.

## References

- Brainstorm decisions: A1-A6 in `reports/brainstorm-2026-05-24-mcp-and-prompt-cache.md`
- MCP TypeScript SDK: `@modelcontextprotocol/sdk`
- Existing repos to reuse: `src/lib/db/repos/connectionsRepo.js`, `src/lib/db/repos/usageRepo.js`, `src/lib/oauth/reauth-state.js`
- Existing MCP infra to coexist with: `src/lib/mcp/stdioSseBridge.js` (outgoing plugin-bridge), `src/app/api/mcp/[plugin]/{sse,message}/route.js`

## Red Team Review

### Session — 2026-05-24

**Reviewers spawned:** 3 (Security Adversary blocked by Anthropic policy mid-spawn; Failure Mode Analyst + Assumption Destroyer + Scope Critic returned full reports).
**Reviewer outcomes:** 30 raw findings → 15 deduped (all evidence-backed with `file:line`).
**Severity breakdown:** 5 Critical, 8 High, 2 Medium. ALL 15 ACCEPTED.

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | `combosRepo.setActive/getActive` do NOT exist — `switch_combo` unimplementable. No "active combo" concept in `schema.js`. `combosRepo.js` exports: `getCombos, getComboById, getComboByName, createCombo, updateCombo, deleteCombo` only | Critical | Accept | plan.md, Phase 2 |
| 2 | `usageRepo.getDailyAggregate` does NOT exist. Real exports: `getUsageStats(period)`, `getChartData(period)`, `getRecentLogs` | Critical | Accept | Phase 2 |
| 3 | `test_connection`: wrong API (`connectionId` vs `provider`); `getProviderCredentials` HAS mutation side-effects (mutex, `lastUsedAt`, `consecutiveUseCount`); probe primitive `src/lib/oauth/utils/server.js#testConnection` does NOT exist; per-provider probe scope creep | Critical | Accept | Phase 2 |
| 4 | `/api/mcp/*` namespace ALREADY taken by `src/app/api/mcp/[plugin]/{sse,message}/route.js` + `src/lib/mcp/stdioSseBridge.js` (outgoing MCP-tool bridge). Adding `/api/mcp/route.js` may shadow or be shadowed by the dynamic `[plugin]` segment | Critical | Accept | Phase 3, plan.md |
| 5 | MCP SDK API mismatch: `server.tool(name, shape, fn)` is OLD API — current SDK uses `registerTool(name, { description, inputSchema }, handler)`. `SSEServerTransport` is DEPRECATED → Streamable HTTP. `@modelcontextprotocol/sdk/inMemory.js` path is wrong | Critical | Accept | All phases |
| 6 | SSE session GC via `cancel()` callback is UNRELIABLE in Next.js (precedent: `src/app/api/translator/console-logs/stream/route.js:21-23` comment confirms). Need `request.signal.addEventListener("abort")` + TTL sweep | High | Accept | Phase 3 |
| 7 | Mutation tools (`switch_combo`, `mark_connection_needs_reauth`) carry LLM-hallucination risk. Plan's own open question doubts their inclusion. Violates plan's stated "control-plane introspection" framing | High | Accept | plan.md, Phase 2 |
| 8 | `zod` NOT in root `package.json` dependencies — only transitive via `eslint-config-next`. `import { z } from "zod"` breaks on strict resolver / fresh `npm ci` | High | Accept | Phase 1 |
| 9 | `9router-mcp` bin in root `package.json` will NOT reach end users — root is `private: true, name: "9router-app"`. Published CLI ships from `cli/package.json` (`name: "9router"`) | High | Accept | Phase 4 |
| 10 | Binary hardcodes `localhost:20128`, ignores `--port` (`cli/cli.js:99-117` shows `MAX_PORT_ATTEMPTS=10`). Need port discovery via `$DATA_DIR/runtime.json` or similar | High | Accept | Phase 4 |
| 11 | `McpServer` singleton at module scope LEAKS across Next.js dev hot-reload. Precedent: `src/lib/mcp/stdioSseBridge.js:14` uses `globalThis[G_KEY]` for this exact reason | High | Accept | Phase 3 |
| 12 | Root `package.json` has NO `test` script + no vitest dep. Test toolchain rests on `/tmp/node_modules` quirk (broken-by-design on fresh checkouts/CI) | High | Accept | Phase 0 (new) |
| 13 | Both transports (stdio + HTTP SSE) doubles surface for ONE consumer (Claude Desktop, stdio-only). Stdio binary even depends on HTTP being up (coupling without value) | High | Accept | plan.md, Phase 3, Phase 4 |
| 14 | Status enum invented (`cooldown`, `disabled`). Real enum lives at `src/shared/utils/get-effective-status.js:6-21`: `needs_reauth/expired/unavailable/error/active/unknown`. `cooldownUntil` field doesn't exist | Medium | Accept | Phase 2 |
| 15 | Health-check 5-attempt exponential backoff (31s total) over-engineered for "is local app running". Fail fast better signal | Medium | Accept | Phase 4 |

**Files modified:** `plan.md`, all 5 phase files. Each phase ends with `## Red Team Adjustments — 2026-05-24` superseding conflicting body sections.

**Scope reduction (locked):**
- Phase 2 tool count: **6 → 3** (`list_providers`, `get_quota_status`, `get_usage_today`). Cut `test_connection`, `switch_combo`, `mark_connection_needs_reauth`.
- Transports: **stdio only**. Drop HTTP SSE from v1. Drop Phase 3 entirely OR redirect it to Phase 0 (test toolchain + zod dep + namespace coexistence audit).
- Binary lives in `cli/bin/9router-mcp.js` not root `bin/mcp.js`.
- Health-check: single attempt, 2s timeout, fail-fast.

**Plan structure update (post-red-team):**
- **Phase 0 NEW**: Test toolchain bootstrap + zod dep + namespace coexistence audit + SDK version pin
- **Phase 1**: Foundation (3 tools instead of 6, current SDK API, single file)
- **Phase 2**: Tool implementations (3 read-only tools, real repo functions, real probe path)
- **Phase 3 DROPPED v1** (was HTTP SSE transport) — defer to v2 when web client emerges
- **Phase 4 RENAMED**: stdio binary (`cli/bin/9router-mcp.js`, port discovery, fail-fast health check)
- **Phase 5**: Docs + Claude Desktop config + E2E (smaller scope: stdio-only)

**Updated effort estimate:** 2-3 days (was 2-3 days but with major scope cuts — the offset is real fixes for SDK API, namespace, toolchain).

### Whole-Plan Consistency Sweep — 2026-05-24

- **Files re-read:** `plan.md`, all 5 `phase-*.md` files
- **Decision deltas applied:** 15 findings converted to adjustments
- **Reconciled stale references:**
  - `combosRepo.setActive/getActive` → REMOVED from plan.md architecture, Phase 2
  - `usageRepo.getDailyAggregate` → REPLACED with `getUsageStats(period)` in Phase 2
  - `switch_combo` + `mark_connection_needs_reauth` + `test_connection` → REMOVED from v1 tool list (plan.md table)
  - Transport "Both" → "stdio only" in plan.md design decisions
  - HTTP SSE route path → namespace-collision fixed by dropping Phase 3 entirely
  - `9router-mcp` bin path → relocated to `cli/bin/9router-mcp.js`
  - `server.tool(name, shape, fn)` → `server.registerTool(name, { description, inputSchema }, handler)` everywhere
  - `SSEServerTransport` → DROPPED (defer to v2 with Streamable HTTP)
  - `@modelcontextprotocol/sdk/inMemory.js` → verify with SDK docs in Phase 0 + use correct path
  - Status enum → `getEffectiveStatus()` return values in Phase 2
- **Unresolved contradictions:** 0
- **Status:** plan adjustment sections are authoritative; original body retained for traceability. Phase files end with `## Red Team Adjustments — 2026-05-24` that supersede conflicting earlier prose.

## Validation Log

### Session 1 — 2026-05-24

**Trigger:** Post-red-team validation pass to lock final decision points before cook.
**Verification pass:** SKIPPED per workflow guard — `## Red Team Review` already provides Fact Checker + Contract Verifier + Scope Auditor evidence (all 15 findings have `file:line` citations, 0 failed verifications). No remaining `[UNVERIFIED]` tags in plan.
**Questions asked:** 4

#### Questions & Answers

1. **[Tooling]** MCP SDK version pin strategy?
   - Options: Pin exact latest stable (Recommended) | Pin ^minor | Pin without API verify
   - **Answer:** Pin exact latest stable
   - **Rationale:** SDK API drift is fast (`registerTool` vs `tool`, Streamable HTTP vs SSE). Pre-cook step in Phase 1 adjustments: `npm view @modelcontextprotocol/sdk version` → pin EXACT version, read installed SDK README before writing tests. Verify exports against `node_modules/@modelcontextprotocol/sdk/dist/index.d.ts`.

2. **[Architecture]** Tool naming convention?
   - Options: `router.list_providers` (Recommended) | `nine_router.list_providers` | `9router.list_providers`
   - **Answer:** `router.list_providers`
   - **Rationale:** Dotted namespace + snake_case method. Short, readable, matches plan default. Avoids leading-digit identifier validators.

3. **[Distribution]** Binary name + npm bin entry?
   - Options: Standalone `9router-mcp` (Recommended) | Subcommand `9router mcp`
   - **Answer:** Standalone `9router-mcp`
   - **Rationale:** `cli/package.json` declares `bin: { "9router": "./cli.js", "9router-mcp": "./bin/9router-mcp.js" }`. Claude Desktop config snippet uses `"command": "9router-mcp"` — single string, copy-paste friendly. Phase 4 adjustments already locked this path.

4. **[Tooling]** Drop `/tmp/node_modules` test toolchain quirk?
   - Options: Drop /tmp + root vitest (Recommended) | Keep + add root alias | Defer
   - **Answer:** Drop /tmp + root vitest
   - **Rationale:** Add vitest + zod + @modelcontextprotocol/sdk to ROOT `package.json` devDependencies / dependencies. Add root `"test"` script using `vitest run --config tests/vitest.config.js`. `tests/package.json` script becomes legacy/deprecated. Clean break — fresh checkouts and CI work without `/tmp` bootstrap.

#### Confirmed Decisions

- **D-V1** SDK pinned EXACTLY (e.g. `"@modelcontextprotocol/sdk": "1.18.2"` no caret). Pre-cook: verify version + API.
- **D-V2** Tool namespace `router.*` locked. snake_case method names. 3 v1 tools: `router.list_providers`, `router.get_quota_status`, `router.get_usage_today`.
- **D-V3** Binary distributed via `cli/package.json` `bin: { ..., "9router-mcp": "./bin/9router-mcp.js" }`. Resolvable after `npm install -g 9router`.
- **D-V4** Root `package.json` gains `vitest`, `zod`, `@modelcontextprotocol/sdk` deps + `"test"` script. `/tmp/node_modules` pattern deprecated.

#### Action Items

- [ ] Phase 1 adjustment: add pre-cook step "verify SDK version + API export paths against installed `dist/`"
- [ ] Phase 1 adjustment: drop `/tmp/node_modules` references, document root `npm test` as canonical
- [ ] Phase 5 docs (Claude Desktop section): copy-paste snippet uses `"command": "9router-mcp"` (no args, no env vars unless port discovery needed in v2)

#### Impact on Phases

- **Phase 1**: Adjustments already cover D-V1 (SDK pin + verify) and D-V4 (root vitest). No further changes.
- **Phase 2**: D-V2 tool naming already applied in adjustments. No further changes.
- **Phase 4**: D-V3 binary location (`cli/bin/9router-mcp.js`) already locked in adjustments. No further changes.
- **Phase 5**: D-V3 Claude Desktop config snippet already correct in adjustments. No further changes.

### Whole-Plan Consistency Sweep — Validation Pass

- **Files re-read:** `plan.md`, all 5 `phase-*.md` files
- **Decision deltas checked:** 4 (D-V1 through D-V4)
- **Reconciled stale references:** 0 — all validation decisions already aligned with Red Team Adjustments
- **Unresolved contradictions:** 0
- **Status:** Plan ready for `/ck:cook`. All 15 red-team findings + 4 validation decisions applied. No outstanding open questions for v1 scope.

## Pre-Cook Review — 2026-06-02

Deep verification pass against live code before cook. Two issues the red-team missed; both fixed.

**PC-1 (Critical) — Phase 4 in-process model broke the published artifact.** The red-team cancelled Phase 3's HTTP transport and pivoted the binary to "import root `src/lib/mcp/server.js` in-process". Verified against `cli/scripts/build-cli.js`: the published `9router` package ships `cli/app/` = a compiled Next.js **standalone** bundle; root `src/` is not included, and `better-sqlite3` is stripped (self-heals into `~/.9router/runtime/node_modules`, resolved via `NODE_PATH` by `cli.js`). So the in-process import works in the dev monorepo but throws `ERR_MODULE_NOT_FOUND` after `npm i -g 9router`.
- **New data the red-team missed:** the build compiles app code into webpack chunks; loose `src/lib` is absent from the package; sqlite is runtime-resolved.
- **User decision:** bundle the MCP source closure into `cli/app/` following the existing updater/MITM precedent (`build-cli.js` steps 7/7b). Bin replicates `cli.js` sqlite `NODE_PATH` + DATA_DIR resolution.
- **Derived constraint:** `src/lib/mcp/*` must use **relative** imports (no `@/`) so the loose bundle resolves under plain `node`. Locked into Phase 1.
- **Applied to:** Phase 4 (full rewrite), Phase 1 (import-style contract). Effort Phase 4 2-3h → 5-6h.

**PC-2 (Medium) — wrong `isolated-db.mjs` usage in test snippets.** Verified `tests/helpers/isolated-db.mjs`: `setupIsolatedDb()` is SYNC, returns `{ dir, cleanup }`, sets `DATA_DIR` only — does NOT init the DB. Phase 2 + 5 snippets `await`-ed it and assumed init. Fixed: call sync FIRST, then dynamic-import `@/lib/db/index.js` + `await initDb()`, then import repos.
- **Applied to:** Phase 2, Phase 5.

**Verified-correct (no change):** WAL mode (`src/lib/db/schema.js:5`); repo function names (`getProviderConnections`, `getUsageStats`, `getChartData`, `getEffectiveStatus`); db layer uses relative imports; `combosRepo` has no `setActive`/`getActive`; `zod`/SDK absent from root `package.json`.

**Still verify at phase start (cheap, in-phase):** installed SDK export paths (`registerTool`, `server/stdio.js`, linked-transport helper); `getUsageStats('today')` + `getProviderConnections` return shapes (to finalize Zod output schemas); `uuid` traced into the bundle node_modules.

## Implementation Outcome — 2026-06-02

Status: **COMPLETE**. All 4 active phases done; 15 MCP tests pass (foundation/tools/stdio-binary/e2e); reauth+warmup 28/28; bundled layout empirically verified from an isolated `/tmp` copy. SDK pinned `1.29.0`, zod `3.25.76`.

Two issues surfaced at cook time that the pre-cook review missed (both fixed):

- **CU-1 — db closure was NOT fully relative.** `paths.js` imported `@/lib/dataDir.js` on the hot path (`driver→paths→dataDir`), plus lazy `@/` in `pricingRepo.js`/`apiKeysRepo.js`. Under plain `node` the bundled closure could not resolve `@/`. Fix: relativized those 4 imports (behavior-preserving — same files; Next build + reauth/warmup verified). Chosen over a runtime alias hook (KISS, fixes both dev-tree test and bundle uniformly).
- **CU-2 — `build-cli.js` Step 3 + SDK dep closure.** Workspace tracing mode nests standalone at `standalone/<project>/server.js`; Step 3 only probed root/`app/`. Added a nested-path fallback (user-approved). Also the SDK's deep prod-dep tree is never traced by Next → added `ensureModuleClosureInBundle()` walking prod deps (bundled 92 packages). Bin's SDK import moved into `src/lib/mcp/stdio-runner.js` (under `app/`) since the bin sits outside `app/` and can't resolve bundled `node_modules`. Bin layout probe order = dev-first (avoids stale `cli/app/src`).

Deferred (noted, not blocking): MCP `outputSchema`/`structuredContent` registration (v1 returns internally-validated text-JSON, matching the locked phase-02 pattern) — v2 candidate.
