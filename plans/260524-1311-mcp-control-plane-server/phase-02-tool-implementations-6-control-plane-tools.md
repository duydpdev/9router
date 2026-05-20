---
phase: 2
title: "Tool Implementations (6 control-plane tools)"
status: pending
priority: P2
effort: "6-8h"
dependencies: [1]
---

# Phase 2: Tool Implementations

## Overview

Replace 6 `not_implemented` stubs with real implementations backed by existing repos. Each tool gets dedicated TDD coverage. NO transport work — pure tool logic + Zod schema validation. After this phase, an in-process Client+Server pair can list and call every tool.

## Requirements

### Functional

Each tool implemented:

1. **router.list_providers** — input: `{ includeInactive?: boolean }`. Output: array of `{ provider, connectionId, name, email?, status: "active"|"needs_reauth"|"cooldown"|"disabled", authType }`. Reads `connectionsRepo.getProviderConnections()`.
2. **router.get_quota_status** — input: `{ provider?: string }`. Output: per-provider `{ provider, dailyTokens, dailyRequests, quotaRemaining?, resetAt? }`. Reads `usageRepo.getDailyAggregate()`.
3. **router.get_usage_today** — input: `{ groupBy?: "provider"|"model"|"connection" }`. Output: `{ totals: { tokens, requests, costUsd }, breakdown: [...] }`.
4. **router.test_connection** — input: `{ connectionId: string }`. Output: `{ ok, latencyMs, status, errorMessage? }`. Calls `auth.getProviderCredentials()` + pings provider's lightest endpoint (models list or similar).
5. **router.switch_combo** — input: `{ name: string }`. Output: `{ previousCombo, activeCombo, switchedAt }`. Calls `combosRepo.setActive()`. Atomic.
6. **router.mark_connection_needs_reauth** — input: `{ connectionId: string, reason: string }`. Output: `{ marked: boolean, reauthAt }`. Calls existing `src/lib/oauth/reauth-state.js#markNeedsReauth`.

### Non-functional
- Each handler completes <500ms on local DB (no slow JSON parse)
- All inputs validated through Zod BEFORE touching repos
- All outputs match declared Zod schema (validate before returning)
- Errors returned as MCP tool errors with `isError: true` + machine-readable code

## Architecture

Tool handler pattern:

```js
export default {
  name: "router.list_providers",
  description: "List provider connections with health status.",
  inputSchema: ListProvidersInput,   // Zod
  outputSchema: ListProvidersOutput, // Zod
  handler: async (rawInput) => {
    const input = ListProvidersInput.parse(rawInput);
    try {
      const rows = await getProviderConnections({ isActive: !input.includeInactive });
      const out = rows.map(toSummary);
      ListProvidersOutput.parse(out);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    } catch (err) {
      return mcpError("list_providers_failed", err.message);
    }
  },
};
```

Shared helper: `src/lib/mcp/tool-helpers.js` exports `mcpError(code, message)`.

## Related Code Files

- Modify: `src/lib/mcp/tools/list-providers.js`
- Modify: `src/lib/mcp/tools/get-quota-status.js`
- Modify: `src/lib/mcp/tools/get-usage-today.js`
- Modify: `src/lib/mcp/tools/test-connection.js`
- Modify: `src/lib/mcp/tools/switch-combo.js`
- Modify: `src/lib/mcp/tools/mark-connection-needs-reauth.js`
- Create: `src/lib/mcp/tool-helpers.js`
- Modify: `src/lib/mcp/schemas.js` — flesh out per-tool schemas
- Create: `tests/unit/mcp-tool-list-providers.test.js`
- Create: `tests/unit/mcp-tool-get-quota-status.test.js`
- Create: `tests/unit/mcp-tool-get-usage-today.test.js`
- Create: `tests/unit/mcp-tool-test-connection.test.js`
- Create: `tests/unit/mcp-tool-switch-combo.test.js`
- Create: `tests/unit/mcp-tool-mark-connection-needs-reauth.test.js`

Read for context (do not modify):
- `src/lib/db/repos/connectionsRepo.js`
- `src/lib/db/repos/usageRepo.js`
- `src/lib/db/repos/combosRepo.js`
- `src/lib/oauth/reauth-state.js`
- `src/sse/services/auth.js`

## TDD — failing tests first

Six test files, one per tool. Each follows pattern:

```js
// tests/unit/mcp-tool-list-providers.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir, repo, tool;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mcp-"));
  process.env.DATA_DIR = tempDir;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/connectionsRepo.js");
  tool = (await import("@/lib/mcp/tools/list-providers.js")).default;
});

afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("router.list_providers", () => {
  it("returns active connections by default", async () => {
    await repo.createProviderConnection({ provider: "claude", authType: "oauth", email: "a@x" });
    const res = await tool.handler({});
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ provider: "claude", authType: "oauth", status: "active" });
  });

  it("includes inactive when includeInactive=true", async () => { ... });

  it("validates input — rejects invalid types", async () => {
    const res = await tool.handler({ includeInactive: "yes" });
    expect(res.isError).toBe(true);
  });
});
```

Write all 6 test files first. Run. Confirm red. Then implement handlers one by one.

## Implementation Steps

1. **Test-first:** write all 6 `tests/unit/mcp-tool-*.test.js` files. Run, confirm red.
2. Flesh out `src/lib/mcp/schemas.js` — full Zod schemas per tool.
3. Create `src/lib/mcp/tool-helpers.js` with `mcpError(code, message)` + `mcpOk(payload)` helpers.
4. Implement `list-providers.js` — wire to `connectionsRepo.getProviderConnections()`. Add `toSummary(conn)` mapping (computed status from `data.needsReauth`, `cooldownUntil`, `disabled`).
5. Implement `get-quota-status.js` — wire to `usageRepo.getDailyAggregate()` + connection quota fields.
6. Implement `get-usage-today.js` — wire to `usageRepo` with optional groupBy.
7. Implement `test-connection.js` — call `auth.getProviderCredentials()` then ping provider's lightest endpoint (provider-specific; reuse `src/lib/oauth/utils/server.js#testConnection` if exists, otherwise add minimal probe).
8. Implement `switch-combo.js` — read current via `combosRepo.getActive()`, call `setActive(name)`, return both.
9. Implement `mark-connection-needs-reauth.js` — import + call `src/lib/oauth/reauth-state.js#markNeedsReauth`.
10. Run all 6 test files. Confirm green. Fix any handler with regression.
11. Re-run mcp-foundation.test.js → all 6 tools no longer return `not_implemented`. Update foundation test if needed (or remove that assertion now that stubs are replaced).

## Success Criteria

- [ ] All 6 tool handlers return real data from repos
- [ ] All 6 dedicated test files pass (1 happy + 1+ edge case per tool)
- [ ] Input validation rejects bad types before touching repo
- [ ] Output validation catches schema drift before returning
- [ ] Foundation test updated/passing (tools no longer stubs)
- [ ] No regressions in existing reauth / warmup test suites
- [ ] `npm run build` clean

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| `test_connection` probe differs per provider | Reuse existing health-check primitive if present in `src/lib/oauth/utils/server.js`; otherwise minimal HTTP HEAD/`/v1/models` per provider's known cheap endpoint |
| `switch_combo` race with running requests | Combo ref is atomic in current `combosRepo` (single JSON write); document brief inconsistency window in tool description |
| LLM-hallucinated args to `switch_combo` swap combo accidentally | Document risk. v1 accepts direct apply per plan decision. Phase 5 docs warn users. |
| `mark_connection_needs_reauth` fires notifier webhook | Verify with reauth plan's notifier dedup; manual mark should still notify (acts as ops escalation) |
| Repo function signature drift | Read each repo file at start of phase; do not assume from name |

## Security Considerations

- All tools read/write LOCAL DB only — no remote calls except `test_connection` probe (which is the point)
- `switch_combo` and `mark_connection_needs_reauth` are state-mutating — document in Phase 5 docs that MCP grants full local control
- Phase 3 transport binds localhost-only (covered next phase)

## Red Team Adjustments — 2026-05-24

Findings **#1, #2, #3, #7, #14** ACCEPTED. Tool count REDUCED 6 → 3. Body sections above for the cut tools are SUPERSEDED.

### v1 ships ONLY these 3 tools

| Tool | Reads from | Output shape |
|------|-----------|--------------|
| `router.list_providers` | `connectionsRepo.getProviderConnections({ isActive: true })` + `getEffectiveStatus(conn)` | `{ connectionId, provider, name, email?, status, authType }[]` |
| `router.get_quota_status` | `usageRepo.getUsageStats('today')` + per-connection quota fields from `connectionsRepo` | `{ provider, dailyTokens, dailyRequests, quotaRemaining?, resetAt? }[]` |
| `router.get_usage_today` | `usageRepo.getUsageStats('today')` + optional `getChartData('today')` | `{ totals: { tokens, requests }, breakdown: [...] }` |

### CUT from v1 (findings #1, #3, #7)

- **`router.test_connection`** — Cut. `getProviderCredentials()` has mutation side effects (`selectionMutex`, `lastUsedAt`, `consecutiveUseCount` per `src/sse/services/auth.js:8,149-156`). No safe pure-read probe primitive exists. Per-provider probe = full feature, not a tool wrapper. Re-add in a dedicated v2 plan with a `connectionsRepo.testConnectionById(id)` helper that doesn't touch routing-layer state.
- **`router.switch_combo`** — Cut. `combosRepo` has NO `setActive/getActive`; `schema.js` has NO active flag (finding #1). Requires schema migration + UI surface + race semantics. Full feature, not a tool. Re-add in v2 after "active combo" persistence model is designed.
- **`router.mark_connection_needs_reauth`** — Cut. LLM-hallucination risk; mutation tool; notifier semantics undefined (finding #7 + Failure Mode #7). Ops can mark via dashboard.

### Real repo function names (finding #2 corrections)

Stop saying "reuses `usageRepo.getDailyAggregate()`" — that doesn't exist. Real exports:
- `usageRepo.getUsageStats(period)` — period: `'today' | 'week' | 'month'`. Returns aggregate.
- `usageRepo.getChartData(period)` — time-series.
- `connectionsRepo.getProviderConnections({ isActive, provider })` — actual filter shape.
- `connectionsRepo.getProviderConnectionById(id)`.

VERIFY function signatures at Phase 2 start. Do not assume from name.

### Status enum (finding #14)

Use `import { getEffectiveStatus } from "@/shared/utils/get-effective-status.js"` directly. Status Zod enum:
```js
z.enum(["active", "needs_reauth", "expired", "unavailable", "error", "unknown"])
```
Drop invented `cooldown` and `disabled`. `isActive=false` is filtered at the repo query level, not surfaced as a status.

### Tests file consolidation

ONE file `tests/unit/mcp-tools.test.js` with 3 describe blocks (one per tool). Shared `beforeAll` for DB setup using `tests/helpers/isolated-db.mjs` (existing helper that handles `DATA_DIR` import-time evaluation correctly — addresses Assumption Destroyer finding #8).

### Effort revised

Was 6-8h. **Now 4-5h** (3 read-only tools, no probe scope creep, shared test setup).
