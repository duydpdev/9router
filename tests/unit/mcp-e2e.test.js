import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Phase 5 e2e: link createMcpServer() to an SDK Client over an in-memory
// transport pair (the stdio path is covered by mcp-stdio-binary.test.js).
// Handshake → list 3 tools → call each with valid input → expect non-error.

let client, cleanup;

beforeAll(async () => {
  const { setupIsolatedDb } = await import("../helpers/isolated-db.mjs");
  ({ cleanup } = setupIsolatedDb()); // SYNC: sets DATA_DIR
  const db = await import("@/lib/db/index.js");
  await db.initDb(); // init AFTER DATA_DIR is set
  const repo = await import("@/lib/db/repos/connectionsRepo.js");
  await repo.createProviderConnection({ provider: "claude", authType: "oauth", email: "seed@x.com" });

  const { createMcpServer } = await import("@/lib/mcp/server.js");
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(() => cleanup?.());

describe("mcp e2e (in-process linked transport)", () => {
  it("handshakes, lists 3 tools, and calls each successfully", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "router.get_quota_status",
      "router.get_usage_today",
      "router.list_providers",
    ]);
    for (const t of tools.tools) {
      const res = await client.callTool({ name: t.name, arguments: {} });
      expect(res.isError, `${t.name} returned an error`).toBeFalsy();
    }
  });

  it("returns the seeded connection via router.list_providers", async () => {
    const res = await client.callTool({ name: "router.list_providers", arguments: {} });
    const body = JSON.parse(res.content[0].text);
    expect(body.some((c) => c.provider === "claude" && c.email === "seed@x.com")).toBe(true);
  });
});
