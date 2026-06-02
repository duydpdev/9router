// stdio runner for the MCP control-plane server.
//
// Kept SEPARATE from server.js (which the in-process e2e test imports for a
// linked transport) so the stdio transport import lives only here. This module
// is bundled UNDER cli/app/src/, so its bare SDK import resolves from
// cli/app/node_modules in the published package — the bin itself sits outside
// app/ and could not resolve it. Relative import to server.js per the contract.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

// Build the server and connect it over stdio. Returns the live server so the
// caller can wire shutdown handlers.
export async function runStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
