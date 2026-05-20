---
phase: 1
title: "Foundation (deps + Zod schemas + tests-first)"
status: pending
priority: P2
effort: "3-4h"
dependencies: []
---

# Phase 1: Foundation (deps + Zod schemas + tests-first)

## Overview

Install MCP SDK, scaffold the `src/lib/mcp/` module, define Zod schemas for all 6 tool inputs/outputs, and land the failing test suite that pins tool registration + schema validation. NO production behavior yet beyond an empty McpServer with 6 registered tool stubs.

## Requirements

### Functional
- `@modelcontextprotocol/sdk` added to `package.json` dependencies, pinned to an exact version
- `src/lib/mcp/server.js` exports `createMcpServer()` returning configured McpServer instance with 6 tool stubs registered
- Each tool stub has Zod input + output schema declared; handler throws `not_implemented` (placeholder)
- Failing test in `tests/unit/mcp-foundation.test.js` asserts: 6 tools listed, each has correct schema, each handler returns `not_implemented` error

### Non-functional
- Zero impact on existing `/v1` flows (new module only)
- No new boot-time side effects; `createMcpServer()` lazy on first call

## Architecture

```
src/lib/mcp/
├── server.js               ← createMcpServer() factory + tool registration
├── tools/
│   ├── index.js            ← re-export 6 tools
│   ├── list-providers.js   ← stub (Phase 2 fills)
│   ├── get-quota-status.js
│   ├── get-usage-today.js
│   ├── test-connection.js
│   ├── switch-combo.js
│   └── mark-connection-needs-reauth.js
└── schemas.js              ← Zod schemas shared across tools (input + output)
```

Each tool file exports `{ name, description, inputSchema, outputSchema, handler }`. `server.js` iterates over `tools/index.js` and calls `server.tool(name, inputSchema.shape, handler)`.

## Related Code Files

- Create: `src/lib/mcp/server.js`
- Create: `src/lib/mcp/schemas.js`
- Create: `src/lib/mcp/tools/index.js`
- Create: `src/lib/mcp/tools/list-providers.js`
- Create: `src/lib/mcp/tools/get-quota-status.js`
- Create: `src/lib/mcp/tools/get-usage-today.js`
- Create: `src/lib/mcp/tools/test-connection.js`
- Create: `src/lib/mcp/tools/switch-combo.js`
- Create: `src/lib/mcp/tools/mark-connection-needs-reauth.js`
- Create: `tests/unit/mcp-foundation.test.js`
- Modify: `package.json` — add `@modelcontextprotocol/sdk` dep

## TDD — failing test first

Write `tests/unit/mcp-foundation.test.js` BEFORE creating any `src/lib/mcp/*` file. Run it, watch it fail. Then create the module surface to pass.

```js
import { describe, it, expect } from "vitest";

describe("mcp foundation", () => {
  it("registers exactly 6 control-plane tools", async () => {
    const { createMcpServer } = await import("@/lib/mcp/server.js");
    const server = createMcpServer();
    const tools = server._registeredTools ?? server.listTools?.();
    expect(Object.keys(tools)).toHaveLength(6);
    expect(Object.keys(tools).sort()).toEqual([
      "router.get_quota_status",
      "router.get_usage_today",
      "router.list_providers",
      "router.mark_connection_needs_reauth",
      "router.switch_combo",
      "router.test_connection",
    ]);
  });

  it("each tool has zod input schema with required fields", async () => {
    const { tools } = await import("@/lib/mcp/tools/index.js");
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
      expect(t.outputSchema).toBeDefined();
      expect(typeof t.handler).toBe("function");
    }
  });

  it("stub handlers return not_implemented error", async () => {
    const { tools } = await import("@/lib/mcp/tools/index.js");
    for (const t of tools) {
      const res = await t.handler({});
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toContain("not_implemented");
    }
  });
});
```

## Implementation Steps

1. **Test-first:** write `tests/unit/mcp-foundation.test.js`. Run `npm test -- unit/mcp-foundation.test.js`. Confirm red (module missing).
2. Install SDK: `npm install @modelcontextprotocol/sdk@<latest-stable>`. Pin exact version (no `^`).
3. Define `src/lib/mcp/schemas.js` — shared Zod schemas (connection summary, quota row, usage row, error shape).
4. Create `src/lib/mcp/tools/*.js` stubs — each exports `{ name, description, inputSchema, outputSchema, handler }`. Handler returns `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "not_implemented" }) }] }`.
5. Create `src/lib/mcp/tools/index.js` exporting `tools` array.
6. Create `src/lib/mcp/server.js` — `createMcpServer()` factory that builds new `McpServer` instance, iterates tools, calls `server.tool(...)` for each.
7. Run test. Confirm green.
8. Compile check: `npm run build` — verify no Next.js boot regression (server.js is lazy, no top-level side effects).

## Success Criteria

- [ ] `package.json` lists `@modelcontextprotocol/sdk` with pinned version
- [ ] All 9 source files exist and import without error
- [ ] `tests/unit/mcp-foundation.test.js` passes with 3 assertions
- [ ] `npm run build` clean — no Next.js boot regression
- [ ] No new tests in `/v1` suite fail (regression sweep)

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| SDK API drift across versions | Pin exact version; document tested Claude Desktop release in Phase 5 |
| Zod version conflict with existing deps | Check if Zod already in `node_modules`; reuse same major version |
| `server._registeredTools` private API in test | Fall back to `listTools()` MCP method; adjust test if SDK exposes different inspection API |
| Top-level import side-effects | Use lazy factory pattern; document in module header |

## Security Considerations

- No authentication added at this phase (matches `/v1` local-trust). Phase 3 documents bind-address constraint (localhost only).
- Tool handlers in this phase return only `not_implemented` — no DB reads, no secrets exposed.

## Red Team Adjustments — 2026-05-24

Findings **#5, #8, #12** ACCEPTED. Plus scope reduction from `#7` (mutation tools cut). Body sections above are STALE for SDK API + tool count + dep list — adjustments below supersede.

### Toolchain bootstrap (new — was assumed)

Before any TDD work:

1. **Add `vitest` to root `package.json` devDependencies** (currently absent — finding #12). Choose version matching `tests/package.json` constraint (`^4.0.0`). Drop reliance on `/tmp/node_modules`.
2. **Add root `package.json` `"test"` script:** `"test": "vitest run --config tests/vitest.config.js --reporter=verbose"`. Document that `cd tests && npm test` is the legacy path; root-level `npm test` is the new canonical path.
3. **Add `zod` to root `package.json` dependencies** (finding #8). Pin version. Without this, `import { z } from "zod"` fails on strict resolver or after a transitive bump.
4. **Pin MCP SDK version explicitly.** Read SDK README first (finding #5): the current API is `server.registerTool(name, { description, inputSchema }, handler)` NOT `server.tool(name, shape, handler)`. The `inputSchema` is a full Zod schema (Standard Schema), not `.shape`. `SSEServerTransport` is DEPRECATED → Streamable HTTP is the current default. `@modelcontextprotocol/sdk/inMemory.js` is not the current export path — verify against installed version's `dist/` layout.

### Tool count: 6 → 3 (finding #7 scope cut)

v1 ships ONLY read-only introspection tools:

1. `router.list_providers`
2. `router.get_quota_status`
3. `router.get_usage_today`

CUT from v1: `test_connection`, `switch_combo`, `mark_connection_needs_reauth` (findings #1, #3, #7). Documented as v2 candidates in plan.md.

### Modularization cut (finding #15 from Scope Critic — implicit in scope reduction)

Phase 1 with 3 stubs ≠ 9 files. Ship ONE file `src/lib/mcp/server.js` containing:
- `createMcpServer()` factory
- 3 inline tool definitions with stub handlers
- Zod schemas inline

Split per-tool ONLY if Phase 2 implementation pushes a tool past ~50 lines.

### Tests file: 1 file, 3 describe blocks

`tests/unit/mcp-foundation.test.js` covers: tool count (3), schema presence, stub handler shape. No per-tool test files in Phase 1.

### SDK API examples (corrected)

Replace body's `server.tool(name, inputSchema.shape, handler)` with:

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function createMcpServer() {
  const server = new McpServer({ name: "9router", version: "1.0.0" });
  server.registerTool(
    "router.list_providers",
    {
      description: "List provider connections with health status.",
      inputSchema: ListProvidersInput,   // full Zod schema, not .shape
    },
    async (input) => {
      return { content: [{ type: "text", text: JSON.stringify({ error: "not_implemented" }) }], isError: true };
    },
  );
  return server;
}
```

VERIFY exact import path against installed SDK version before writing tests. SDK exports may differ from this snippet.

### Updated success criteria

- [ ] Root `package.json` has `vitest`, `zod`, and `@modelcontextprotocol/sdk` deps (pinned)
- [ ] Root `npm test` works (no `/tmp/node_modules` dependency)
- [ ] `src/lib/mcp/server.js` exports `createMcpServer()` with 3 tools registered using current SDK API
- [ ] `tests/unit/mcp-foundation.test.js` passes (3 describe blocks)
- [ ] No collision with existing `src/lib/mcp/stdioSseBridge.js`

### Effort revised

Was 3-4h. **Now 5-6h** (extra time for toolchain bootstrap + SDK verification).
