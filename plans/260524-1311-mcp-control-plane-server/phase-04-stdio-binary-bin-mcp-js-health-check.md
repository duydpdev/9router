---
phase: 4
title: "stdio Binary (bin/mcp.js + health-check)"
status: pending
priority: P2
effort: "3-4h"
dependencies: [1, 2, 3]
---

# Phase 4: stdio Binary

## Overview

Ship a small Node CLI (`bin/mcp.js`) that Claude Desktop launches as a subprocess. It speaks MCP over stdio with the client, and proxies all JSON-RPC traffic to the running Next.js process's `/api/mcp` (HTTP SSE). Health-check + retry on startup if Next.js isn't up yet.

## Requirements

### Functional
- `bin/mcp.js` is a Node entry point with shebang `#!/usr/bin/env node`
- `package.json` declares `"bin": { "9router-mcp": "bin/mcp.js" }`
- On launch: health-check `GET http://localhost:20128/api/mcp/health` (NEW lightweight ping endpoint) with retry backoff (5 attempts, 1s/2s/4s/8s/16s)
- After health-check: open MCP stdio transport, open SSE client transport to running 9Router, pipe messages bidirectionally
- Honors `NINEROUTER_URL` env var to override default `http://localhost:20128`
- Clean exit on stdin close (Claude Desktop killed the subprocess)

### Non-functional
- Binary startup <1s when Next.js already up
- Health-check failure → exit code 1 with clear stderr message
- No new heavy deps in binary (reuse `@modelcontextprotocol/sdk`)

## Architecture

```
Claude Desktop
    │  spawns "9router-mcp" subprocess
    ↓
bin/mcp.js (stdio)
    │  ├─ health-check loop → GET /api/mcp/health
    │  ├─ open StdioServerTransport (talk to Claude Desktop)
    │  └─ open SSEClientTransport (talk to running Next.js)
    │  pipe: stdio.request → sse.send; sse.notification → stdio.send
    ↓
Next.js /api/mcp (HTTP SSE)
```

Two design choices considered:
- **Proxy mode** (chosen): binary is dumb pipe. Real McpServer lives in Next.js. Single source of truth for tool implementations. Health-check forces a running app.
- **Standalone mode** (rejected): binary contains the McpServer + duplicate DB access. Doubles state surface, conflicts with running app on DB writes. NO.

## Related Code Files

- Create: `bin/mcp.js`
- Create: `src/app/api/mcp/health/route.js` — lightweight 200 OK with `{ ok: true, version }`
- Modify: `package.json` — add `bin` entry
- Create: `tests/unit/mcp-stdio-binary.test.js`

## TDD — failing test first

Test focuses on the proxy logic in isolation. Spawn a fake Next.js mock-server (node:http) that speaks MCP-over-HTTP-SSE, launch `bin/mcp.js` as a child process, send MCP request via stdin, assert response on stdout.

```js
// tests/unit/mcp-stdio-binary.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";

let mockServer, mockPort;

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    if (req.url === "/api/mcp/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "test" }));
      return;
    }
    // ... minimal MCP SSE mock for handshake + tools/list
  });
  await new Promise((r) => mockServer.listen(0, r));
  mockPort = mockServer.address().port;
});

afterAll(() => new Promise((r) => mockServer.close(r)));

describe("9router-mcp stdio binary", () => {
  it("exits 1 if health-check fails", async () => {
    const child = spawn("node", ["bin/mcp.js"], {
      env: { ...process.env, NINEROUTER_URL: "http://localhost:1" },
      timeout: 60_000,
    });
    const code = await new Promise((r) => child.on("exit", r));
    expect(code).toBe(1);
  }, 20_000);

  it("proxies tools/list request to upstream", async () => {
    // launch with NINEROUTER_URL=mockPort, send JSON-RPC over stdin, parse stdout
  });
});
```

## Implementation Steps

1. **Test-first:** write the two binary tests. Run → red (binary doesn't exist).
2. Create `src/app/api/mcp/health/route.js`:
   ```js
   export async function GET() {
     return Response.json({ ok: true, version: require("../../../../../package.json").version });
   }
   ```
3. Create `bin/mcp.js`:
   - Shebang, read `NINEROUTER_URL` (default `http://localhost:20128`)
   - Health-check loop (5 attempts exponential backoff). On final fail: `console.error("...")` + `process.exit(1)`.
   - Construct `StdioServerTransport` for Claude Desktop side
   - Construct `SSEClientTransport(new URL("/api/mcp", baseUrl))` for upstream
   - Connect a `Client` to SSEClientTransport, then for every request from stdio → forward to client; for every notification from upstream → forward to stdio
4. Update `package.json` `"bin": { "9router-mcp": "./bin/mcp.js" }`. Add `chmod +x` instruction in install hook or document.
5. Run tests. Confirm green.
6. Manual smoke: start `npm run dev`. Run `node bin/mcp.js < /dev/null` and verify health-check passes + clean exit.
7. Document Claude Desktop config snippet (Phase 5).

## Success Criteria

- [ ] `bin/mcp.js` created with executable shebang
- [ ] `package.json` `bin` entry installed and `9router-mcp` resolvable after `npm link`
- [ ] Health-check retries 5 times with exponential backoff, exits 1 on total failure
- [ ] Stdio → SSE → Next.js → SSE → stdio round-trip works for `initialize`, `tools/list`, `tools/call`
- [ ] Both vitest assertions pass
- [ ] Manual: Claude Desktop config snippet launches binary and lists 6 tools (manual smoke test)
- [ ] No regressions

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Binary launched before Next.js boots | Health-check loop with backoff (5/30s total) |
| Claude Desktop spawns binary in non-interactive env without `NINEROUTER_URL` | Default to `http://localhost:20128`; document in Phase 5 |
| Binary stays alive if SSE upstream dies mid-session | Listen for SSE error events → propagate via stdio → exit |
| Cross-platform shebang on Windows | `npm` bin shim handles it; document Windows users use the shim path |
| Test child-process flakiness in CI | Use ports allocated dynamically (`listen(0)`), generous timeouts, no shared state |

## Security Considerations

- Binary trusts `NINEROUTER_URL` from env. Document that user-owned env only — no escalation possible since binary already runs as user
- Binary makes no DB calls directly — pure proxy
- Health-check exposes 9Router version; acceptable (already in `package.json` and many UI surfaces)

## Red Team Adjustments — 2026-05-24

Findings **#9, #10, #13, #15** ACCEPTED. Body's "proxy to running Next.js via HTTP SSE" model is SUPERSEDED — see Phase 3 cancellation. Binary now runs McpServer in-process.

### Architecture pivot (finding #13)

Phase 3 cancelled → binary no longer proxies HTTP. Binary instead:
1. Imports `src/lib/mcp/server.js` directly
2. Opens its own `connectionsRepo`/`usageRepo` SQLite handles (via shared `src/lib/db/`)
3. Connects to MCP client over `StdioServerTransport`
4. No health check needed — no upstream process to wait for

```
Claude Desktop
    │  spawns "9router-mcp" subprocess
    ↓
cli/bin/9router-mcp.js
    │  ├─ open DB handles (read-only mode preferred)
    │  ├─ createMcpServer()
    │  └─ connect StdioServerTransport
    ↓
Claude Desktop reads JSON-RPC over stdio
```

### Binary location (finding #9)

Move `bin/mcp.js` → `cli/bin/9router-mcp.js`. Reasons:
- Root `package.json` is `private: true, name: "9router-app"` — NEVER published. Root `bin` entry only works via local `npm link`.
- Published CLI lives in `cli/package.json` (`name: "9router"`). Add `"bin": { "9router": "...", "9router-mcp": "./bin/9router-mcp.js" }` there.
- Update `cli/package.json` `files: [...]` array to include `bin/`.

### Port discovery (finding #10)

Drop hardcoded `localhost:20128`. Since Phase 3 dropped, binary runs in-process — no port needed. **Finding obsolete given Phase 3 cancellation, but retained as v2 note** when HTTP transport returns.

### Health-check (finding #15)

OBSOLETE per Phase 3 cancellation. Binary runs McpServer in-process; no external dependency to health-check.

If v2 HTTP transport returns: single attempt, 2s timeout, fail-fast with stderr message `"9Router not reachable at $NINEROUTER_URL — start it first."` No exponential backoff (31s wait is hostile UX for "is local app running").

### Concurrent DB access concern

Binary + Next.js both opening SQLite. better-sqlite3 supports WAL mode (concurrent reads + serialized writes). v1 binary is read-only (Phase 2's 3 tools = read-only after cuts) → safe.

Add `connectionsRepo.openReadOnly()` helper if needed, OR document that binary opens DB with default (read-write) handle but tools only call read functions. v1: latter (simpler, lower risk for read-only tools).

### Updated success criteria

- [ ] `cli/bin/9router-mcp.js` created with shebang + executable permission
- [ ] `cli/package.json` declares `"bin": { ..., "9router-mcp": "./bin/9router-mcp.js" }` AND lists `bin/` in `files`
- [ ] Binary launches and lists 3 tools via in-process McpServer
- [ ] Binary handles `SIGTERM`/`SIGINT` cleanly (close DB, exit 0)
- [ ] Concurrent run with Next.js dev server: no DB lock errors (WAL mode verified)
- [ ] Manual smoke: Claude Desktop spawns binary, lists tools, calls `router.list_providers`

### Effort revised

Was 3-4h. **Now 2-3h** (no HTTP proxy, no health-check loop, no port discovery).
