---
phase: 2
title: "Tool Implementations (3 read-only tools)"
status: completed
priority: P2
effort: "4-5h"
dependencies: [1]
---

# Phase 2: Tool Implementations (3 read-only control-plane tools)

## Overview

Replace the 3 `not_implemented` stubs with real implementations backed by existing repos. Pure tool logic + Zod validation — no transport work. After this phase, an in-process Client+Server pair can list and call every tool. All 3 tools are READ-ONLY; mutating tools are deferred to v2 (see `plan.md` out-of-scope).

## Requirements

### Functional — the 3 v1 tools

| Tool | Reads from | Output shape |
|------|-----------|--------------|
| `router.list_providers` | `connectionsRepo.getProviderConnections({ isActive: true })` + `getEffectiveStatus(conn)` | `{ connectionId, provider, name, email?, status, authType }[]` |
| `router.get_quota_status` | `usageRepo.getUsageStats('today')` + per-connection quota fields from `connectionsRepo` | `{ provider, dailyTokens, dailyRequests, quotaRemaining?, resetAt? }[]` |
| `router.get_usage_today` | `usageRepo.getUsageStats('today')` (+ optional `getChartData('today')` for breakdown) | `{ totals: { tokens, requests }, breakdown: [...] }` |

Inputs:
- `list_providers` → `{ includeInactive?: boolean }` (default false → repo filter `isActive: true`)
- `get_quota_status` → `{ provider?: string }`
- `get_usage_today` → `{ groupBy?: "provider" | "model" }`

### Non-functional
- Each handler completes <500ms on local DB.
- All inputs validated through Zod BEFORE touching repos.
- All outputs validated against the declared Zod output schema before returning.
- Errors returned as MCP tool errors: `isError: true` + machine-readable code.

### Real repo functions (verified — do NOT assume from name)

- `connectionsRepo.getProviderConnections(filter = {})` — `src/lib/db/repos/connectionsRepo.js:60`
- `connectionsRepo.getProviderConnectionById(id)` — `:73`
- `usageRepo.getUsageStats(period = "all")` — `src/lib/db/repos/usageRepo.js:351`; period `'today' | 'week' | 'month'`
- `usageRepo.getChartData(period = "7d")` — `:652` (time-series)
- `getEffectiveStatus(connection)` — `src/shared/utils/get-effective-status.js`

These do NOT exist (earlier draft was wrong): `usageRepo.getDailyAggregate`, `combosRepo.setActive/getActive`. Re-confirm signatures at phase start.

### Status enum

Use `getEffectiveStatus()` directly. Zod enum = its real return values:
```js
z.enum(["active", "needs_reauth", "expired", "unavailable", "error", "unknown"])
```
Do NOT invent `cooldown` / `disabled`. `isActive=false` is filtered at the repo query level, not surfaced as a status.

## Architecture

Handler pattern (inline in `src/lib/mcp/server.js`, or per-file if a tool exceeds ~50 lines):

```js
async function listProvidersHandler(rawInput) {
  const input = ListProvidersInput.parse(rawInput);
  try {
    const rows = await getProviderConnections({ isActive: !input.includeInactive });
    const out = rows.map(toSummary); // toSummary uses getEffectiveStatus(conn)
    ListProvidersOutput.parse(out);
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  } catch (err) {
    return mcpError("list_providers_failed", err.message);
  }
}
```

`mcpError(code, message)` is the shared helper from Phase 1.

## Related Code Files

- Modify: `src/lib/mcp/server.js` — flesh out 3 handlers + full Zod schemas + `toSummary` mapping
- Create: `tests/unit/mcp-tools.test.js` — 3 describe blocks, shared `beforeAll` DB setup

Read for context (do not modify):
- `src/lib/db/repos/connectionsRepo.js`
- `src/lib/db/repos/usageRepo.js`
- `src/shared/utils/get-effective-status.js`
- `tests/helpers/isolated-db.mjs` — SYNC helper: `setupIsolatedDb()` → `{ dir, cleanup }`; sets `DATA_DIR` only (does NOT init db)

## TDD — failing tests first

ONE file `tests/unit/mcp-tools.test.js`, 3 describe blocks, shared `beforeAll` using `tests/helpers/isolated-db.mjs`:

`setupIsolatedDb()` is **synchronous** (`tests/helpers/isolated-db.mjs`): it `mkdtemp`s a dir, sets `process.env.DATA_DIR`, and returns `{ dir, cleanup }`. It does NOT init the DB. Order matters: call it FIRST (sync), THEN dynamic-`import` the db module and call `initDb()`, so `DATA_DIR` is set before any module reads it at import time.

```js
import { describe, it, expect, beforeAll, afterAll } from "vitest";

let createMcpServer, repo, callTool, cleanup;

beforeAll(async () => {
  const { setupIsolatedDb } = await import("../helpers/isolated-db.mjs");
  ({ cleanup } = setupIsolatedDb());             // SYNC: sets DATA_DIR, returns { dir, cleanup }
  const db = await import("@/lib/db/index.js");
  await db.initDb();                             // init AFTER DATA_DIR is set
  repo = await import("@/lib/db/repos/connectionsRepo.js");
  ({ createMcpServer } = await import("@/lib/mcp/server.js"));
  // callTool: helper that resolves the registered handler by name and invokes it
});

afterAll(() => cleanup?.());

describe("router.list_providers", () => {
  it("returns active connections by default", async () => {
    await repo.createProviderConnection({ provider: "claude", authType: "oauth", email: "a@x" });
    const res = await callTool("router.list_providers", {});
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body[0]).toMatchObject({ provider: "claude", authType: "oauth", status: "active" });
  });
  it("rejects invalid input type", async () => {
    const res = await callTool("router.list_providers", { includeInactive: "yes" });
    expect(res.isError).toBe(true);
  });
});

describe("router.get_quota_status", () => { /* happy + filter-by-provider */ });
describe("router.get_usage_today", () => { /* totals + groupBy */ });
```

Write all 3 blocks first. Run → red. Then implement handlers one by one.

## Implementation Steps

1. **Test-first:** write `tests/unit/mcp-tools.test.js` (3 describe blocks, shared `beforeAll`). Run → red.
2. Read the 3 repo files; confirm function signatures + return shapes.
3. Flesh out the 3 Zod input/output schemas in `server.js`.
4. Implement `router.list_providers` — wire `getProviderConnections({ isActive: !includeInactive })`; add `toSummary(conn)` using `getEffectiveStatus(conn)`.
5. Implement `router.get_quota_status` — `getUsageStats('today')` + per-connection quota fields, optional `provider` filter.
6. Implement `router.get_usage_today` — `getUsageStats('today')`, optional `getChartData('today')` for `groupBy` breakdown.
7. Run all 3 blocks → green. Re-run `mcp-foundation.test.js` → update/remove the stub `not_implemented` assertion (tools are real now).

## Success Criteria

- [ ] All 3 tool handlers return real data from repos
- [ ] `tests/unit/mcp-tools.test.js` passes (1 happy + ≥1 edge case per tool)
- [ ] Input validation rejects bad types before touching the repo
- [ ] Output validation catches schema drift before returning
- [ ] Foundation test updated/passing (tools no longer stubs)
- [ ] No regressions in reauth / warmup suites
- [ ] `npm run build` clean

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Repo function signature drift | Read each repo file at phase start; do not assume from name |
| Output schema too strict for optional quota fields | Make `quotaRemaining?`/`resetAt?` optional; validate against real `getUsageStats` output |
| `DATA_DIR` import-time evaluation in tests | Use `tests/helpers/isolated-db.mjs` (handles ordering) — do not set env after import |
| Status mapping surprises | Drive status purely from `getEffectiveStatus`; never compute ad-hoc |

## Security Considerations

- All 3 tools READ local DB only — no remote calls, no mutations.
- No secrets in output: `list_providers` surfaces account enumeration (provider/email/status) but NOT tokens. Confirm `toSummary` never copies credential fields.

## Decision history

Final 3-tool read-only scope above incorporates the 2026-05-24 red-team + validation outcomes: `test_connection` cut (`getProviderCredentials` has routing-layer side effects, no safe probe), `switch_combo` cut (no `setActive` / no active-combo model), `mark_connection_needs_reauth` cut (mutation + hallucination risk); real repo function names substituted for the non-existent `getDailyAggregate`; status enum corrected to `getEffectiveStatus` values. Full audit trail: `plan.md` → `## Red Team Review`.
