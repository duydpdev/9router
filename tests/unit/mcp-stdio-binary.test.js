import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase 4: the published binary launches the McpServer in-process over stdio.
// Drive it the way Claude Desktop does — spawn the child via the SDK's stdio
// client transport, against an isolated DATA_DIR (dev-tree layout). The bundled
// layout is covered by a manual post-build check.

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const BIN = path.join(repoRoot, "cli", "bin", "9router-mcp.js");

let tempDir, client, transport;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mcp-bin-"));
});

afterAll(async () => {
  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("9router-mcp stdio binary", () => {
  it("launches, handshakes, and lists the 3 control-plane tools over stdio", async () => {
    transport = new StdioClientTransport({
      command: "node",
      args: [BIN],
      env: { ...process.env, DATA_DIR: tempDir },
    });
    client = new Client({ name: "stdio-bin-test", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "router.get_quota_status",
      "router.get_usage_today",
      "router.list_providers",
    ]);

    // One real round-trip against the isolated (freshly initialized) DB.
    const res = await client.callTool({ name: "router.list_providers", arguments: {} });
    expect(res.isError).toBeFalsy();
  }, 30_000);
});
