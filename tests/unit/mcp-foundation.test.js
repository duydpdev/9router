import { describe, it, expect } from "vitest";

// Phase 1 foundation: createMcpServer() must register exactly the 3 read-only
// control-plane tools, each with a Zod input schema + a handler. Stub handlers
// (pre-Phase-2) return an MCP error with code "not_implemented".

const TOOL_NAMES = [
  "router.get_quota_status",
  "router.get_usage_today",
  "router.list_providers",
];

async function loadTools() {
  const { createMcpServer } = await import("@/lib/mcp/server.js");
  const server = createMcpServer();
  // SDK 1.29.0 exposes registered tools on the private _registeredTools map.
  return server._registeredTools ?? {};
}

describe("mcp foundation", () => {
  it("registers exactly 3 read-only control-plane tools", async () => {
    const tools = await loadTools();
    expect(Object.keys(tools).sort()).toEqual(TOOL_NAMES);
  });

  it("each tool has a zod input schema + a handler", async () => {
    const tools = await loadTools();
    for (const t of Object.values(tools)) {
      expect(t.inputSchema).toBeDefined();
      expect(typeof t.inputSchema.parse).toBe("function"); // ZodObject
      expect(typeof t.handler).toBe("function");
    }
  });

  // Handler behavior (and DB isolation) is covered by mcp-tools.test.js.
  // Foundation stays registration-only so it never touches the real DATA_DIR.
});
