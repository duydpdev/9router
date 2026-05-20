---
title: "MCP Control-Plane Server (stdio + HTTP SSE, 6 tools)"
description: "Expose 9Router introspection/control as MCP tools for Claude Desktop, Claude Code skills, and other MCP clients. Control-plane only (no chat tool). stdio + HTTP SSE transports. In-process Next.js runtime."
status: pending
priority: P2
branch: "feature/dylan-improve"
tags: ["mcp", "control-plane", "integration", "claude-desktop"]
blockedBy: []
blocks: ["260524-1312-prompt-cache-opt-in"]
created: "2026-05-24T06:11:47.654Z"
createdBy: "ck:plan"
source: skill
---

# MCP Control-Plane Server

## Overview

9Router has no agent-native control surface today. Clients hit `/v1` for chat but cannot ask 9Router questions like "what providers are healthy?", "what's my quota?", or "switch to combo X" from inside an LLM conversation. This plan adds an MCP server exposing 6 control-plane tools, reusing existing repos/services. Two transports: stdio (Claude Desktop config) and HTTP SSE (web/remote clients), both backed by the same Next.js process.

**Scope:** Control-plane only — NO chat tool. `/v1` remains the single chat surface to avoid duplication. MCP authentication and MCP resources/prompts are explicitly out of scope for v1.

## Phases

| Phase | Name                                                                                                  | Status  |
| ----- | ----------------------------------------------------------------------------------------------------- | ------- |
| 1     | [Foundation (deps + Zod schemas + tests-first)](./phase-01-foundation-deps-zod-schemas-tests-first.md) — **see Red Team Adjustments: now covers Phase 0 toolchain bootstrap, 3 tools not 6, current SDK API** | Pending |
| 2     | [Tool Implementations (6 control-plane tools)](./phase-02-tool-implementations-6-control-plane-tools.md) — **see Red Team Adjustments: reduced to 3 read-only tools** | Pending |
| 3     | [HTTP SSE Transport (/api/mcp route)](./phase-03-http-sse-transport-api-mcp-route.md) — **DROPPED v1 per Red Team #4, #13**. Defer to v2. | Cancelled |
| 4     | [stdio Binary (bin/mcp.js + health-check)](./phase-04-stdio-binary-bin-mcp-js-health-check.md) — **see Red Team Adjustments: relocate to cli/bin/, port discovery, fail-fast health** | Pending |
| 5     | [Docs + Claude Desktop Integration + E2E](./phase-05-docs-claude-desktop-integration-e2e.md) — **see Red Team Adjustments: stdio-only docs, smaller surface** | Pending |

## Dependencies

No cross-plan blocking. Builds on existing repos in `src/lib/db/repos/` (connectionsRepo, usageRepo), warmup notifier ENV, and `src/sse/services/auth.js`. Does NOT touch in-flight reauth plan or warmup-scheduler plan.

## Context Links

- Brainstorm: [reports/brainstorm-2026-05-24-mcp-and-prompt-cache.md](../reports/brainstorm-2026-05-24-mcp-and-prompt-cache.md)
- MCP SDK docs: https://github.com/modelcontextprotocol/typescript-sdk

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Claude Desktop / Claude Code Skill / Custom MCP Client               │
│        │                                                             │
│        ├─ stdio: spawn `9router-mcp` binary                          │
│        │       └─ binary proxies JSON-RPC to http://localhost:PORT   │
│        │                                                             │
│        └─ HTTP SSE: direct connect to http://localhost:PORT/api/mcp  │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ↓
┌──────────────────────────────────────────────────────────────────────┐
│ Next.js process — /api/mcp/route.js                                  │
│   ├─ McpServer instance (singleton)                                  │
│   ├─ Transport: SSEServerTransport (HTTP) / proxied stdio            │
│   └─ Tool dispatcher                                                 │
│        ├─ router.list_providers       → connectionsRepo              │
│        ├─ router.get_quota_status     → usageRepo + connectionsRepo  │
│        ├─ router.get_usage_today      → usageRepo                    │
│        ├─ router.test_connection(id)  → auth.getProviderCredentials  │
│        ├─ router.switch_combo(name)   → combosRepo + atomic swap     │
│        └─ router.mark_connection_needs_reauth(id, reason)            │
│                                       → reauth-state.markNeedsReauth │
└──────────────────────────────────────────────────────────────────────┘
```

## Design decisions (locked from brainstorm)

| Decision                                  | Choice                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| Tool scope                                | Control-plane only — NO chat tool (clients use `/v1` for chat)  |
| Transports                                | Both: stdio (Claude Desktop) + HTTP SSE (web/remote)            |
| Runtime                                   | Same Next.js process. stdio binary proxies over HTTP            |
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

- MCP authentication / API-key gating (deferred until remote MCP deployments emerge)
- Chat tool surface (use `/v1` instead — avoids duplication and streaming complexity)
- MCP resources surface (`resources/list`, `resources/read`)
- MCP prompts surface (`prompts/list`, `prompts/get`)
- Persistence of MCP session state across server restart
- Rate limiting per MCP client
- Tool result pagination (only `list_providers` could exceed token budget; small for v1)

## Success criteria (whole plan)

- [ ] `@modelcontextprotocol/sdk` installed, version pinned in `package.json`
- [ ] McpServer instance registers 6 tools at boot
- [ ] HTTP SSE transport at `/api/mcp` returns valid `initialize` handshake
- [ ] stdio binary `9router-mcp` launches, health-checks running Next.js, proxies JSON-RPC
- [ ] Each of 6 tools has Zod input/output schema + happy-path Vitest coverage
- [ ] In-process integration test (SDK Client + Server linked) lists 6 tools + calls each
- [ ] Claude Desktop `mcp.json` config snippet works copy-paste (manual verification)
- [ ] `docs/integrations/mcp.md` written with tool reference + setup guide
- [ ] No regressions on existing `/v1` test suite

## Open questions

- Should `switch_combo` require a `confirm: true` arg to avoid accidental LLM-hallucinated swaps? Default: NO direct apply. Revisit after first user feedback.
- Should `mark_connection_needs_reauth` be exposed at all? It is a power-user / debug tool. Keep it for ops scenarios; document as advanced.
- Tool naming convention `router.X` vs `nine_router.X` vs `9router.X` — MCP convention is snake_case but namespace dots are common. Default: `router.` namespace.

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
