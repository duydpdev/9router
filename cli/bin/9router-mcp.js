#!/usr/bin/env node
// 9router-mcp — stdio MCP control-plane server for Claude Desktop.
//
// Claude Desktop spawns this as a subprocess and speaks JSON-RPC over stdio.
// It runs the McpServer IN-PROCESS, opening 9Router's own SQLite handle — no
// HTTP, no running Next.js required. It works in two layouts:
//   - dev monorepo:  resolves the MCP module from <repo>/src
//   - published pkg: resolves from the standalone bundle at <pkg>/app/src
// (build-cli.js copies the MCP source closure into the bundle.)

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Module } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// 1. sqlite runtime self-heal (mirror cli.js): the published bundle strips the
//    native sqlite driver into ~/.9router/runtime/node_modules. Prepend it to
//    NODE_PATH so driver.js can resolve better-sqlite3 (falls back to bundled
//    sql.js / node:sqlite). Harmless in the dev tree (root node_modules wins).
const runtimeModules = path.join(os.homedir(), ".9router", "runtime", "node_modules");
process.env.NODE_PATH = process.env.NODE_PATH
  ? `${runtimeModules}${path.delimiter}${process.env.NODE_PATH}`
  : runtimeModules;
Module._initPaths();

// 2. Locate the MCP source root for whichever layout we are in. DATA_DIR is
//    resolved by src/lib/dataDir.js (honors $DATA_DIR, else ~/.9router).
// Dev monorepo first: in a published global install <bin>/../../src does not
// exist, so it falls through to the bundle. In the dev tree it points at the
// live <repo>/src — avoiding a STALE cli/app/src left over from a prior build.
const candidates = [
  path.join(here, "..", "..", "src"), // dev monorepo: <repo>/src
  path.join(here, "..", "app", "src"), // published bundle: cli/app/src
];
const srcRoot = candidates.find((c) =>
  fs.existsSync(path.join(c, "lib", "mcp", "server.js")),
);
if (!srcRoot) {
  console.error("9router-mcp: could not locate the MCP module (lib/mcp/server.js).");
  process.exit(1);
}

const importSrc = (rel) => import(pathToFileURL(path.join(srcRoot, rel)).href);

async function main() {
  // Resolve everything from srcRoot so the SDK + its deps load from the bundled
  // node_modules under app/ (the bin lives outside app/ and can't resolve them).
  const { initDb } = await importSrc("lib/db/index.js");
  const { runStdioServer } = await importSrc("lib/mcp/stdio-runner.js");

  await initDb();
  const server = await runStdioServer();

  // Idempotent: SIGTERM and stdin-close can both fire when Claude Desktop tears
  // down. Await the server close before exiting so it actually completes.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close?.();
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // stdin close (Claude Desktop closes the pipe) → exit cleanly.
  process.stdin.on("close", shutdown);
}

main().catch((err) => {
  console.error("9router-mcp: fatal:", err?.stack || err);
  process.exit(1);
});
