---
phase: 1
title: "Foundation: toolchain bootstrap + deps + 3 tool stubs + tests-first"
status: completed
priority: P2
effort: "5-6h"
dependencies: []
---

# Phase 1: Foundation (toolchain + deps + Zod schemas + tests-first)

## Overview

Bootstrap the test toolchain at the repo root, install the MCP SDK + Zod, and land a failing Vitest suite that pins tool registration. Then create `src/lib/mcp/server.js` exposing `createMcpServer()` with **3 read-only** control-plane tool stubs registered via the current SDK API. NO production behavior yet — stub handlers return `not_implemented`.

## Requirements

### Functional
- Root `package.json` gains `@modelcontextprotocol/sdk` (pinned exact), `zod` (pinned), and `vitest` (dev).
- Root `package.json` gains a `"test"` script that runs Vitest without the `/tmp/node_modules` bootstrap.
- `src/lib/mcp/server.js` exports `createMcpServer()` returning a configured `McpServer` with 3 tool stubs registered.
- Each tool stub declares a Zod input + output schema; handler returns an MCP error with code `not_implemented`.
- Failing test `tests/unit/mcp-foundation.test.js` asserts: exactly 3 tools listed, each has schemas + a handler, each stub handler returns `isError: true` + `not_implemented`.

### Non-functional
- Zero impact on existing `/v1` flows (new module only).
- `createMcpServer()` is a lazy factory — no top-level side effects, no boot-time cost.
- No collision with existing `src/lib/mcp/stdioSseBridge.js` (different module, different purpose).

## Toolchain bootstrap (do this FIRST)

The repo currently has no root `test` script, no root `vitest`, and `zod` only transitively (via `eslint-config-next`). Tests rely on a `/tmp/node_modules` quirk that breaks on fresh checkouts and CI. Fix before any TDD work:

1. Add `vitest` to root `package.json` devDependencies — match `tests/package.json` constraint (`^4.0.0`).
2. Add root `"test"` script: `"test": "vitest run --config tests/vitest.config.js --reporter=verbose"`. `cd tests && npm test` becomes the legacy path; root `npm test` is canonical.
3. Add `zod` to root `package.json` dependencies (pin). Without it, `import { z } from "zod"` fails on a strict resolver / fresh `npm ci`.
4. Pin the MCP SDK exactly: `npm view @modelcontextprotocol/sdk version` → add `"@modelcontextprotocol/sdk": "<exact>"` (no caret). **Read the installed SDK's `dist/index.d.ts` before writing tests** — verify the real export paths and API surface.

### Verified SDK API (re-confirm against installed version)

Current SDK uses `server.registerTool(name, { description, inputSchema }, handler)` — NOT the old `server.tool(name, shape, handler)`. `inputSchema` is a full Zod schema (Standard Schema), not `.shape`. `SSEServerTransport` is deprecated (irrelevant here — v1 is stdio only). The in-memory linked-transport helper path differs across versions — verify against `dist/` before relying on it.

## Architecture

v1 ships 3 stubs — does NOT warrant 9 files. Single module:

```
src/lib/mcp/
└── server.js   ← createMcpServer() factory + 3 inline tool defs (stub handlers) + inline Zod schemas + mcpError() helper
```

Split a tool into its own file ONLY if Phase 2 pushes it past ~50 lines. Keep Zod schemas inline until shared across files.

**Import-style contract (critical for Phase 4):** any db/shared imports inside `src/lib/mcp/*` MUST be **relative** (`../db/repos/connectionsRepo.js`, `../../shared/utils/get-effective-status.js`) — NEVER the `@/` alias. Phase 4 ships this module as loose files inside the CLI standalone bundle and runs it under plain `node` with no alias resolver; relative imports resolve there, `@/` does not. The db layer is already relative-internal, so this just keeps the new files consistent.

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const mcpError = (code, message) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
});

export function createMcpServer() {
  const server = new McpServer({ name: "9router", version: "1.0.0" });
  server.registerTool(
    "router.list_providers",
    { description: "List provider connections with health status.", inputSchema: ListProvidersInput },
    async () => mcpError("not_implemented", "Phase 2 fills this in."),
  );
  // ...router.get_quota_status, router.get_usage_today (same shape)
  return server;
}
```

VERIFY the exact import path + `registerTool` signature against the installed SDK before writing tests.

## Related Code Files

- Create: `src/lib/mcp/server.js`
- Create: `tests/unit/mcp-foundation.test.js`
- Modify: `package.json` (root) — add `@modelcontextprotocol/sdk`, `zod`, `vitest` deps + `"test"` script

Read for context (do not modify):
- `src/lib/mcp/stdioSseBridge.js` — confirm no naming/module collision
- `tests/vitest.config.js`, `tests/package.json` — toolchain reference

## TDD — failing test first

Write `tests/unit/mcp-foundation.test.js` BEFORE `src/lib/mcp/server.js`. Run, watch it fail (module missing), then implement.

```js
import { describe, it, expect } from "vitest";

describe("mcp foundation", () => {
  it("registers exactly 3 read-only control-plane tools", async () => {
    const { createMcpServer } = await import("@/lib/mcp/server.js");
    const server = createMcpServer();
    const tools = server._registeredTools ?? server.listTools?.();
    expect(Object.keys(tools).sort()).toEqual([
      "router.get_quota_status",
      "router.get_usage_today",
      "router.list_providers",
    ]);
  });

  it("each tool has zod schemas + a handler", async () => {
    const { createMcpServer } = await import("@/lib/mcp/server.js");
    const server = createMcpServer();
    const tools = server._registeredTools ?? server.listTools?.();
    for (const t of Object.values(tools)) {
      expect(t.inputSchema).toBeDefined();
      expect(typeof t.callback ?? t.handler).toBe("function");
    }
  });

  it("stub handlers return not_implemented error", async () => {
    // call each registered handler with {} → expect isError + "not_implemented"
  });
});
```

`server._registeredTools` is a private field — if the installed SDK exposes a different inspection surface, adjust the test to the public `listTools()` shape.

## Implementation Steps

1. Toolchain bootstrap (4 steps above): root `vitest` + `zod` + SDK deps + root `test` script.
2. **Test-first:** write `tests/unit/mcp-foundation.test.js`. Run `npm test -- mcp-foundation`. Confirm red.
3. Read installed SDK `dist/index.d.ts` — confirm `registerTool` signature + import path.
4. Create `src/lib/mcp/server.js`: `createMcpServer()` factory, inline `mcpError()`, 3 inline Zod input/output schemas, 3 `registerTool` calls with stub handlers returning `not_implemented`.
5. Run test. Confirm green.
6. `npm run build` — verify no Next.js boot regression (factory is lazy, no top-level side effects).

## Success Criteria

- [ ] Root `package.json` has `vitest`, `zod`, `@modelcontextprotocol/sdk` (SDK pinned exact) + a working `"test"` script
- [ ] Root `npm test` runs without `/tmp/node_modules`
- [ ] `src/lib/mcp/server.js` exports `createMcpServer()` with 3 tools registered via current SDK `registerTool` API
- [ ] `tests/unit/mcp-foundation.test.js` passes (tool count, schema presence, stub error shape)
- [ ] `npm run build` clean — no Next.js boot regression
- [ ] `src/lib/mcp/*` uses relative imports for any db/shared deps (no `@/` alias) — Phase 4 bundling depends on this
- [ ] No collision with `src/lib/mcp/stdioSseBridge.js`

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| SDK API drift across versions | Pin exact version; read installed `dist/index.d.ts` before writing tests; document tested SDK version in Phase 5 |
| Zod version conflict with transitive copy | Pin a version compatible with what `node_modules` already resolves; reuse same major |
| `_registeredTools` is private | Fall back to public `listTools()` inspection; adjust test to installed SDK |
| Top-level import side-effects | Lazy factory only; document in module header |

## Security Considerations

- No authentication at this phase (matches `/v1` local-trust posture).
- Stub handlers return only `not_implemented` — no DB reads, no secrets.

## Decision history

Final scope above already incorporates the 2026-05-24 red-team + validation outcomes: tool count cut 6→3 (mutating tools removed), single-file module (not 9 files), current `registerTool` SDK API, root-level toolchain bootstrap (no `/tmp/node_modules`). Full audit trail: see `plan.md` → `## Red Team Review` and `## Validation Log`.
