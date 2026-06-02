---
phase: 3
title: "HTTP SSE Transport (CANCELLED v1 — v2 design notes)"
status: cancelled
priority: P2
effort: "0h (v1) / 3-4h (v2)"
dependencies: [1, 2]
---

# Phase 3: HTTP SSE Transport — CANCELLED for v1

> **STATUS: CANCELLED for v1.** No files are created in this phase. v1 ships stdio-only with the McpServer running in-process inside the CLI binary (see Phase 4). The rest of this file is retained as a **v2 design note** — read it only when adding a web/remote MCP consumer. It is NOT part of the v1 implementation.

## Why cancelled (v1)

1. **Namespace collision** — `src/app/api/mcp/[plugin]/{sse,message}/route.js` already exists (outgoing MCP-plugin bridge). Adding `src/app/api/mcp/route.js` next to a dynamic `[plugin]` segment risks Next.js App Router precedence ambiguity. A v2 HTTP transport must mount under `/api/mcp/control` instead.
2. **No consumer** — v1 client is Claude Desktop (stdio-only). Two transports double the surface for zero day-1 web users.
3. **GC + singleton bugs** — reliable SSE session GC + module-scope singleton hot-reload leak in Next.js is real work, wasted with no consumer.
4. **Deprecated API** — `SSEServerTransport` is deprecated in the current SDK; v2 must use Streamable HTTP, a different design.

## v2 path (when a web consumer emerges)

1. Adopt Streamable HTTP (current SDK default), not deprecated SSE.
2. Mount under `/api/mcp/control` (avoids `[plugin]` collision).
3. Use the `globalThis[Symbol.for("9router.mcpServer")]` singleton pattern (precedent: `src/lib/mcp/stdioSseBridge.js:14`).
4. Use `request.signal.addEventListener("abort", cleanup)` + a TTL sweep for session GC (the `cancel()` callback is unreliable in Next.js — see `src/app/api/translator/console-logs/stream/route.js`).
5. Pair with an MCP-auth plan (remote consumers = remote attack surface).

---

## Original v1 design (SUPERSEDED — retained for v2 reference only)

Mount the MCP server at `/api/mcp` using `SSEServerTransport` from the SDK. Browser/web clients and the stdio binary connect here. Single shared `McpServer` instance per Next.js process. Localhost-only bind (matches `/v1`). NO authentication v1.

## Requirements

### Functional
- `GET /api/mcp` opens an SSE stream (initial handshake response)
- `POST /api/mcp/messages?sessionId=<id>` accepts client-to-server JSON-RPC messages
- Session lifecycle: client connects → server allocates `sessionId` → client posts messages tagged with that id → server pushes responses over the SSE stream
- `initialize` handshake succeeds: client sees server capabilities + tool list
- `tools/list` returns 6 tools with schemas
- `tools/call` for any of the 6 tools returns expected payload (re-uses Phase 2 handlers)

### Non-functional
- Multiple concurrent sessions supported (Map keyed by sessionId)
- Session GC on stream close
- Bind localhost only — Next.js default behavior in dev; production must document `HOSTNAME=127.0.0.1` requirement (or accept the risk of LAN exposure)

## Architecture

```
Client                    Next.js /api/mcp
  │                              │
  ├── GET /api/mcp ──────────────▶│ open SSE stream, allocate sessionId
  │◀── event: endpoint ──────────│  body: /api/mcp/messages?sessionId=xxx
  │                              │
  ├── POST /api/mcp/messages ────▶│ parse JSON-RPC, route to McpServer
  │     ?sessionId=xxx           │
  │◀── event: message ───────────│  response pushed back over SSE stream
  │     (JSON-RPC response)      │
```

Implementation: SDK's `SSEServerTransport` handles most of this. The route handler just wires Next.js `Request`/`Response` (Edge or Node runtime — Node runtime needed for `node:http` semantics SDK expects).

## Related Code Files

- Create: `src/app/api/mcp/route.js` — `GET` handler (SSE stream open + session create)
- Create: `src/app/api/mcp/messages/route.js` — `POST` handler (client → server messages)
- Create: `src/lib/mcp/transport-registry.js` — process-wide Map<sessionId, transport>
- Modify: `src/lib/mcp/server.js` — export shared singleton via `getOrCreateMcpServer()`
- Create: `tests/unit/mcp-http-transport.test.js`

Read for context:
- `src/app/api/v1/chat/completions/route.js` — for Next.js streaming response pattern reference

## TDD — failing test first

```js
// tests/unit/mcp-http-transport.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// Pure in-process pattern: link client + server via linked InMemoryTransport
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("mcp http transport (linked in-memory)", () => {
  it("client lists 6 tools after handshake", async () => {
    const { createMcpServer } = await import("@/lib/mcp/server.js");
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);
  });

  it("client can call router.list_providers via transport", async () => {
    // similar setup; expect tools/call to round-trip through transport
  });
});
```

Note: real HTTP SSE end-to-end test is deferred to Phase 5 (E2E). This phase covers the transport-routing wiring via the SDK's linked InMemoryTransport — exercises the same code paths.

## Implementation Steps

1. **Test-first:** write `tests/unit/mcp-http-transport.test.js` using InMemoryTransport. Run → red.
2. Modify `src/lib/mcp/server.js` to export `getOrCreateMcpServer()` returning a process-wide singleton (cache in module scope).
3. Create `src/lib/mcp/transport-registry.js`:
   ```js
   const transports = new Map();
   export const addTransport = (sessionId, t) => { transports.set(sessionId, t); };
   export const getTransport = (sessionId) => transports.get(sessionId);
   export const removeTransport = (sessionId) => { transports.delete(sessionId); };
   ```
4. Create `src/app/api/mcp/route.js`:
   - `export async function GET(req)` — instantiate `SSEServerTransport(/api/mcp/messages, res)`, register in transport-registry, call `server.connect(transport)`, return SSE response. Cleanup on stream close.
5. Create `src/app/api/mcp/messages/route.js`:
   - `export async function POST(req)` — read `?sessionId`, look up transport, call `transport.handlePostMessage(req)`. Return 202 on success, 404 if session not found.
6. Verify in-process test passes (uses linked InMemoryTransport, not HTTP, but exercises tool dispatch through server).
7. Manual HTTP smoke test: `curl -N http://localhost:20128/api/mcp` → expect SSE event with endpoint URL.
8. Document localhost-bind requirement in module header comment.

## Success Criteria

- [ ] `GET /api/mcp` opens SSE stream, returns initial `endpoint` event with session id
- [ ] `POST /api/mcp/messages?sessionId=<id>` round-trips JSON-RPC messages
- [ ] Transport registry holds active sessions, evicts on stream close
- [ ] In-process linked transport test passes (lists 6 tools, calls one)
- [ ] Multiple concurrent sessions supported (manual: 2 curl streams + posts)
- [ ] Manual `curl -N http://localhost:20128/api/mcp` returns valid SSE handshake
- [ ] No regressions in existing tests

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Next.js streaming response API mismatch with SDK SSE expectations | Use Node runtime for the route (`export const runtime = "nodejs"`), reference v1 chat completions streaming impl |
| Session leak if stream close not detected | Subscribe to `req.signal.addEventListener("abort", cleanup)`; also TTL sweep every 5min as fallback |
| Concurrent session map race | Map is single-thread JS — safe. Document. |
| LAN-exposed MCP if user binds `HOSTNAME=0.0.0.0` | Document in Phase 5 docs as security warning. v1 trusts user config matches `/v1` decision. |
| SDK version's transport API differs | Pin SDK version in Phase 1; if API changes during plan, lock per first install |

## Security Considerations

- Document: MCP transport inherits 9Router bind address. If user runs with `HOSTNAME=0.0.0.0`, ANY device on LAN can:
  - Call `router.mark_connection_needs_reauth` (deny service)
  - Call `router.switch_combo` (hijack routing)
  - Read connections list (token shapes, NOT secrets — but enumerates accounts)
- v1 documents this as a known limitation. Phase 5 docs include a "Security Posture" section. MCP auth deferred to a follow-up plan if remote use cases emerge.

## Red Team Adjustments — 2026-05-24

Findings **#4, #6, #11, #13** ACCEPTED. **PHASE STATUS: CANCELLED for v1.**

### Why cancelled

1. **Namespace collision (finding #4):** `src/app/api/mcp/[plugin]/{sse,message}/route.js` already exists for outgoing MCP-plugin bridge. Adding `src/app/api/mcp/route.js` next to dynamic `[plugin]` segment risks route precedence ambiguity in Next.js 16 App Router. Either coexisting requires renaming to `/api/mcp/server` or `/api/mcp/control`, OR dropping HTTP transport for v1.
2. **No consumer (finding #13):** stated v1 client is Claude Desktop (stdio-only). Both transports doubles surface for zero day-1 web users. Stdio binary in Phase 4 even depends on this HTTP transport being up (coupling without value).
3. **Singleton + GC bugs (findings #6, #11):** Solving SSE session GC reliably in Next.js + module-scope singleton hot-reload leak = real work that's wasted if no consumer.
4. **SDK API drift (finding #5):** `SSEServerTransport` is DEPRECATED in current SDK. The plan would need to pivot to Streamable HTTP anyway — that's a different design.

### v1 path (revised)

stdio binary in Phase 4 spawns the McpServer DIRECTLY in-process (no HTTP proxy). Binary imports `src/lib/mcp/server.js` and connects via `StdioServerTransport`. Read-only ops only (Phase 2 cut tools to 3 read-only) — no concurrent-write concerns. Binary opens its own SQLite handle (via `connectionsRepo`/`usageRepo` shared modules) instead of IPC-ing to running Next.js.

This **eliminates Phase 3 entirely** for v1. Saves 3-4h. No coupling between stdio binary and Next.js runtime.

### Trade-off

Without HTTP transport, no in-browser MCP client. v2 candidate:
1. Adopt Streamable HTTP (current SDK default), not deprecated SSE
2. Use `/api/mcp/control` namespace (avoids collision with `[plugin]`)
3. Add the `globalThis[Symbol.for("9router.mcpServer")]` singleton pattern (precedent in `stdioSseBridge.js:14`)
4. Pair with MCP-auth plan since remote consumers = remote attack surface

### Phase status

**Cancelled.** Effort moves to Phase 0 (toolchain bootstrap) and Phase 4 (stdio in-process). No HTTP route files created. Plan's main architecture diagram is updated in plan.md Red Team Review section.
