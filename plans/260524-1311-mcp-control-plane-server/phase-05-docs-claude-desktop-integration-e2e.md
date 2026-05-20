---
phase: 5
title: "Docs + Claude Desktop Integration + E2E"
status: pending
priority: P2
effort: "3-4h"
dependencies: [1, 2, 3, 4]
---

# Phase 5: Docs + Claude Desktop Integration + E2E

## Overview

End-to-end test that walks: spawn real HTTP server → MCP client connects → lists 6 tools → calls each. Plus user-facing documentation for Claude Desktop, Claude Code skill authors, and arbitrary MCP clients. Updates CHANGELOG, README, architecture docs.

## Requirements

### Functional
- One E2E Vitest test that:
  1. Starts the Next.js server in test-process via in-memory route handler (or spawns a real port)
  2. Connects an SDK Client via SSEClientTransport
  3. Asserts handshake succeeds, lists 6 tools
  4. Calls each tool with a valid input and asserts non-error response
- `docs/integrations/mcp.md` covers:
  - What MCP is (1-paragraph)
  - 6 tool reference (name, description, input schema, output schema, example call/response)
  - Claude Desktop setup (`mcp.json` copy-paste snippet)
  - Claude Code skill setup
  - Generic HTTP SSE client setup (curl example)
  - Security posture (localhost-only, no auth in v1, switch_combo risk)
- `README.md` adds short "MCP control-plane" section linking to docs
- `docs/system-architecture.md` adds one paragraph describing MCP surface
- `CHANGELOG.md` entry under upcoming version

### Non-functional
- Docs use kebab-case file naming (`mcp.md`, follows existing `docs/integrations/` if present, else creates the folder)
- E2E test isolated (temp DATA_DIR, no shared state)

## Architecture

```
tests/unit/mcp-e2e.test.js
  ├── setup: temp DATA_DIR + seed minimal connections
  ├── start: real http.createServer wrapping Next.js mcp routes (or use linked InMemoryTransport)
  ├── client: new Client + SSEClientTransport
  ├── assertions:
  │     - initialize handshake ok
  │     - listTools → 6 tools, schemas valid
  │     - call each tool → response shape matches outputSchema
  └── teardown
```

Realistic choice: this phase uses the SDK's `InMemoryTransport.createLinkedPair()` (already covered in Phase 3) AS WELL AS a real HTTP-port test that boots `http.createServer` and mounts the route handlers manually. Both run for completeness.

## Related Code Files

- Create: `tests/unit/mcp-e2e.test.js`
- Create: `docs/integrations/mcp.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md` (short section + link to docs)
- Modify: `docs/system-architecture.md` (add MCP paragraph)
- Modify: `docs/project-changelog.md` (per repo convention)

Read for context:
- All Phase 1-4 files

## TDD — failing test first

```js
// tests/unit/mcp-e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let tempDir, server, client;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mcp-e2e-"));
  process.env.DATA_DIR = tempDir;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  const repo = await import("@/lib/db/repos/connectionsRepo.js");
  await repo.createProviderConnection({ provider: "claude", authType: "oauth", email: "seed@x" });

  const { createMcpServer } = await import("@/lib/mcp/server.js");
  server = createMcpServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(c);
});

afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("mcp e2e", () => {
  it("handshakes, lists 6 tools, calls each", async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);

    const callList = await client.callTool({ name: "router.list_providers", arguments: {} });
    expect(callList.isError).toBeFalsy();

    // ... call remaining 5 with valid args (test_connection needs valid id)
  });
});
```

## Implementation Steps

1. **Test-first:** write `tests/unit/mcp-e2e.test.js`. Run → red.
2. Implement the test loop to walk all 6 tools. Verify against Phase 2 implementations.
3. Run → green.
4. Write `docs/integrations/mcp.md`:
   - 1-paragraph "What is MCP, why 9Router exposes it"
   - Tool reference table with name + description + example call
   - Per-tool detailed section with input schema, output schema, response example
   - Claude Desktop section: where `mcp.json` lives (per OS), copy-paste snippet:
     ```json
     {
       "mcpServers": {
         "9router": {
           "command": "9router-mcp",
           "env": { "NINEROUTER_URL": "http://localhost:20128" }
         }
       }
     }
     ```
   - Claude Code skill section: SDK call example
   - Generic HTTP SSE section: curl example
   - **Security posture**: localhost-only, no auth, switch_combo + mark_needs_reauth are mutation tools; if HOSTNAME=0.0.0.0, any LAN device can use them
5. Update `README.md`: short "MCP Control-Plane" section after Quick Start, linking to `docs/integrations/mcp.md`.
6. Update `docs/system-architecture.md` with one paragraph + the architecture block from `plan.md`.
7. Update `CHANGELOG.md`:
   ```
   ### Added
   - MCP control-plane server: expose 6 introspection/control tools
     (router.list_providers, .get_quota_status, .get_usage_today,
     .test_connection, .switch_combo, .mark_connection_needs_reauth)
     via stdio + HTTP SSE transports. Backed by the running Next.js
     process. See docs/integrations/mcp.md for Claude Desktop setup.
     New binary: `9router-mcp` (installed via npm bin).
     Localhost-only; no authentication in v1.
   ```
8. Update `docs/project-changelog.md` per repo doc rules.
9. Run full vitest suite — verify no regressions.

## Success Criteria

- [ ] `mcp-e2e.test.js` passes — handshake + listTools(6) + 6 callTool round-trips
- [ ] `docs/integrations/mcp.md` covers all 6 tools + Claude Desktop config + security
- [ ] `README.md` links to mcp.md
- [ ] `docs/system-architecture.md` mentions MCP surface
- [ ] `CHANGELOG.md` + `docs/project-changelog.md` entries present
- [ ] Manual test: Claude Desktop config snippet works — list tools from chat
- [ ] `npm run build` clean
- [ ] No regressions in any prior test suite

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Claude Desktop config format changes across versions | Test against Claude Desktop release matrix; document tested version range |
| E2E test slow if real HTTP port used | Prefer InMemoryTransport for CI; manual HTTP smoke for release verification |
| Docs drift later when tool schemas evolve | docs/integrations/mcp.md links to `src/lib/mcp/schemas.js` as source of truth |
| User confuses MCP `/v1` with chat `/v1` | docs clearly state: MCP for control, `/v1` for chat |

## Security Considerations

- Docs explicitly call out: ANY MCP client with reach to the bind interface can mutate state. Security posture matches `/v1`.
- Suggest `HOSTNAME=127.0.0.1` as the safe default in docs
- Note that adding auth is a future plan if remote MCP becomes a use case

## Next Steps

Plan complete. After merge:
- Monitor user feedback on tool coverage — likely candidates for v2: `list_combos`, `get_provider_health_history`, `disable_connection`
- If demand for remote MCP emerges → spin off new plan for MCP auth (API-key or signed token)
- If chat-tool requests common → reconsider exposing `router.send_chat` (currently rejected per architectural separation)

## Red Team Adjustments — 2026-05-24

Findings **#1, #13** (downstream) ACCEPTED. Body scope SHRUNK to match Phase 3 cancellation + tool reduction.

### v1 docs cover ONLY:

- 3 read-only tools (`list_providers`, `get_quota_status`, `get_usage_today`) — NOT 6
- stdio transport ONLY — drop "HTTP SSE" section, drop "generic web client" section
- Claude Desktop config snippet using `cli/bin/9router-mcp.js` path:
  ```json
  {
    "mcpServers": {
      "9router": {
        "command": "9router-mcp"
      }
    }
  }
  ```
  Document `npm install -g 9router` makes `9router-mcp` resolvable (since published from `cli/`).

### E2E test (corrected)

Drop the InMemoryTransport-based test for Phase 3 (cancelled). Replace with in-process test linking `createMcpServer()` directly to a `Client` via the SDK's linked-transport pattern (verify correct import path from installed SDK version, finding #5).

```js
// tests/unit/mcp-e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Use SDK's linked-transport helper (path TBD per current SDK).
// Verify with: cat node_modules/@modelcontextprotocol/sdk/dist/index.d.ts

let tempDir, client, server;
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mcp-e2e-"));
  process.env.DATA_DIR = tempDir;
  // seed via existing isolated-db helper
  const { setupIsolatedDb } = await import("../helpers/isolated-db.mjs");
  await setupIsolatedDb();
  // ... seed one healthy connection
  const { createMcpServer } = await import("@/lib/mcp/server.js");
  server = createMcpServer();
  // Link via SDK helper. Path verified pre-implementation.
  // ... connect client
});

afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("mcp e2e (stdio in-process)", () => {
  it("handshake + lists 3 tools + calls each successfully", async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(3);
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

### Docs file scope cut

CHANGELOG, README, `docs/integrations/mcp.md` — keep. DROP:
- `docs/system-architecture.md` update (defer to a docs-sync task post-merge per Scope Critic #10)
- `docs/project-changelog.md` update (handled by ck:journal at session end)

Reduces Phase 5 from 5 docs touched to 3.

### Effort revised

Was 3-4h. **Now 2-3h** (single transport, 3 tools, narrower docs).
