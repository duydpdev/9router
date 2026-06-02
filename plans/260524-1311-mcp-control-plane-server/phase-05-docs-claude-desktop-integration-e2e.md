---
phase: 5
title: "Docs + Claude Desktop Integration + E2E"
status: completed
priority: P2
effort: "2-3h"
dependencies: [1, 2, 4]
---

# Phase 5: Docs + Claude Desktop Integration + E2E

## Overview

One in-process E2E test that links `createMcpServer()` to an SDK `Client`, lists the 3 tools, and calls each. Plus stdio-only user docs for Claude Desktop. Updates CHANGELOG + README + `docs/integrations/mcp.md`.

## Requirements

### Functional
- One E2E Vitest test that:
  1. Sets up an isolated temp `DATA_DIR` + seeds one healthy connection (via `tests/helpers/isolated-db.mjs`)
  2. `createMcpServer()` → links to an SDK `Client` via the SDK's linked-transport helper (verify exact import path against installed SDK `dist/`)
  3. Asserts handshake succeeds + lists exactly 3 tools
  4. Calls each tool with valid input, asserts non-error response
- `docs/integrations/mcp.md` covers:
  - What MCP is + why 9Router exposes it (1 paragraph)
  - 3-tool reference (name, description, input schema, output schema, example call/response)
  - Claude Desktop setup (config snippet, per-OS config path)
  - Security posture (stdio-only, local-trust, read-only tools)
- `README.md` adds a short "MCP control-plane" section linking to the docs
- `CHANGELOG.md` entry under the upcoming version

### Non-functional
- Docs use kebab-case naming (`docs/integrations/mcp.md`; create the folder if absent).
- E2E test isolated — temp `DATA_DIR`, no shared state.

## Architecture

```
tests/unit/mcp-e2e.test.js
  ├── setup: isolated temp DATA_DIR + seed one healthy connection
  ├── createMcpServer() ── linked transport ── SDK Client
  ├── assertions: handshake ok · listTools → 3 · callTool each → non-error
  └── teardown
```

Single transport path: SDK linked in-memory pair (stdio is exercised by the Phase 4 child-process test). No HTTP, no `SSEClientTransport`.

## Related Code Files

- Create: `tests/unit/mcp-e2e.test.js`
- Create: `docs/integrations/mcp.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md` (short section + link)

Read for context:
- All Phase 1, 2, 4 files
- `tests/helpers/isolated-db.mjs`

> `docs/system-architecture.md` and `docs/project-changelog.md` updates are NOT in this phase — defer the architecture doc to a post-merge docs-sync task; the changelog is handled by `/ck:journal` at session end. Keeps Phase 5 to 3 docs touched.

## TDD — failing test first

```js
// tests/unit/mcp-e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// Linked-transport helper: verify path with `cat node_modules/@modelcontextprotocol/sdk/dist/index.d.ts`

let client, cleanup;
beforeAll(async () => {
  const { setupIsolatedDb } = await import("../helpers/isolated-db.mjs");
  ({ cleanup } = setupIsolatedDb());             // SYNC: sets DATA_DIR, returns { dir, cleanup }
  const db = await import("@/lib/db/index.js");
  await db.initDb();                             // init AFTER DATA_DIR is set
  const repo = await import("@/lib/db/repos/connectionsRepo.js");
  await repo.createProviderConnection({ provider: "claude", authType: "oauth", email: "seed@x" });

  const { createMcpServer } = await import("@/lib/mcp/server.js");
  const server = createMcpServer();
  // const [c, s] = <SDK linked pair>; await server.connect(s);
  client = new Client({ name: "e2e", version: "0.0.0" });
  // await client.connect(c);
});
afterAll(() => cleanup?.());

describe("mcp e2e (in-process)", () => {
  it("handshake + lists 3 tools + calls each successfully", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "router.get_quota_status",
      "router.get_usage_today",
      "router.list_providers",
    ]);
    for (const t of tools.tools) {
      const res = await client.callTool({ name: t.name, arguments: {} });
      expect(res.isError).toBeFalsy();
    }
  });
});
```

## Implementation Steps

1. **Test-first:** write `tests/unit/mcp-e2e.test.js`. Run → red.
2. Verify the SDK linked-transport import path against the installed `dist/`; wire client+server.
3. Run → green.
4. Write `docs/integrations/mcp.md`:
   - 1-paragraph "what is MCP, why 9Router exposes it"
   - 3-tool reference table + per-tool input/output schema + response example
   - Claude Desktop section + config path per OS + snippet:
     ```json
     {
       "mcpServers": {
         "9router": { "command": "9router-mcp" }
       }
     }
     ```
     Note: `npm install -g 9router` makes `9router-mcp` resolvable (published from `cli/`).
   - Security posture: stdio-only, runs locally as the user, 3 read-only tools — no state mutation in v1.
5. Update `README.md`: short "MCP Control-Plane" section after Quick Start, link to `docs/integrations/mcp.md`.
6. Update `CHANGELOG.md`:
   ```
   ### Added
   - MCP control-plane server: 3 read-only introspection tools
     (router.list_providers, router.get_quota_status, router.get_usage_today)
     over stdio for Claude Desktop. McpServer runs in-process in the
     `9router-mcp` CLI binary (published from cli/). Local, read-only,
     no authentication in v1. See docs/integrations/mcp.md.
   ```
7. Run full Vitest suite → verify no regressions.

## Success Criteria

- [ ] `tests/unit/mcp-e2e.test.js` passes — handshake + listTools(3) + 3 callTool round-trips
- [ ] `docs/integrations/mcp.md` covers all 3 tools + Claude Desktop config + security posture
- [ ] `README.md` links to `docs/integrations/mcp.md`
- [ ] `CHANGELOG.md` entry present
- [ ] Manual: Claude Desktop config snippet works — list tools from chat
- [ ] `npm run build` clean
- [ ] No regressions in any prior test suite

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| SDK linked-transport import path drift | Verify against installed `dist/index.d.ts` before writing the test |
| Claude Desktop config format changes across versions | Document the tested Claude Desktop version range in the docs |
| Docs drift as schemas evolve | `docs/integrations/mcp.md` cites `src/lib/mcp/server.js` Zod schemas as source of truth |
| User confuses MCP with chat `/v1` | Docs state plainly: MCP = control/introspection, `/v1` = chat |

## Security Considerations

- Docs call out: the binary runs locally as the user; all 3 tools are read-only — no mutation surface in v1.
- `list_providers` enumerates accounts (provider/email/status) but never exposes tokens.
- Adding auth / remote transport is a separate v2 plan (see Phase 3 v2 notes + `plan.md` out-of-scope).

## Next Steps

After merge:
- Watch user feedback for v2 tool candidates: `list_combos`, `get_provider_health_history`.
- If remote MCP demand emerges → new plan: Streamable HTTP transport (`/api/mcp/control`) + MCP auth (Phase 3 v2 notes).
- Mutating tools (`switch_combo`, `mark_connection_needs_reauth`, `test_connection`) → v2 plan once safe primitives exist.

## Decision history

Final stdio-only / 3-tool / 3-docs scope incorporates the 2026-05-24 red-team + validation outcomes: HTTP SSE E2E dropped (Phase 3 cancelled), tool count 3, docs trimmed (architecture doc + project-changelog deferred), Claude Desktop snippet uses the `cli/`-published `9router-mcp` bin with no env vars. Full audit trail: `plan.md` → `## Red Team Review` and `## Validation Log`.
