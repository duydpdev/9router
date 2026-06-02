---
phase: 4
title: "stdio Binary (cli/bin/9router-mcp.js, bundled in-process)"
status: completed
priority: P2
effort: "5-6h"
dependencies: [1, 2]
---

# Phase 4: stdio Binary (bundled in-process McpServer)

## Overview

Ship `cli/bin/9router-mcp.js` that Claude Desktop launches as a subprocess. It runs the `McpServer` **in-process** over stdio. To survive `npm i -g 9router` (where the app is a compiled Next.js standalone bundle, NOT raw `src/`), the binary follows the existing **updater/MITM precedent**: `build-cli.js` copies the MCP source closure as loose files into the bundle, and the bin resolves the runtime sqlite driver + DATA_DIR exactly like `cli.js` does. No HTTP, no running Next.js required.

## Why this design (supersedes the earlier "import root src/lib" idea)

The published `9router` package (`cli/`) ships `cli/app/` = a **compiled Next.js standalone webpack bundle** (`build-cli.js` step 3), with `better-sqlite3` stripped (it self-heals into `~/.9router/runtime/node_modules`, resolved via `NODE_PATH` by `cli.js`). Root `src/` is NOT in the published package. So a bin that does `import "../../src/lib/mcp/server.js"` works in the dev monorepo but throws `ERR_MODULE_NOT_FOUND` after global install.

Precedent for the fix already exists: `build-cli.js` steps 7/7b copy `src/mitm` and `src/lib/updater` into the bundle as loose headless-Node files. The MCP module does the same — but it has a dependency closure (db layer + one shared util), so the build copies that closure too.

## Import-style contract (set in Phase 1, enforced here)

`src/lib/mcp/*` files import db/shared deps with **RELATIVE paths only** — NOT the `@/` alias:
```js
import { getProviderConnections } from "../db/repos/connectionsRepo.js";
import { getEffectiveStatus } from "../../shared/utils/get-effective-status.js";
```
Rationale: the db layer is already relative-internally (`../driver.js`, `./helpers/jsonCol.js`); `get-effective-status.js` has no imports. Keeping mcp relative too means the copied loose tree resolves under plain `node` with **no `@/` runtime resolver hook**. (Tests still import the module via vitest's `@/` alias — that resolves at test time; the file's own internal imports stay relative.)

## Source closure the build must copy

Verified relative-import closure (re-confirm at phase start — files may gain imports):
- `src/lib/mcp/**` (new this plan)
- `src/lib/db/index.js`, `driver.js`, `paths.js`, `helpers/jsonCol.js`, `helpers/metaStore.js`, `adapters/**`
- `src/shared/utils/get-effective-status.js`
- node_modules: `uuid` (connectionsRepo) — verify it is already traced into `cli/app/node_modules` by the standalone build; sqlite drivers via the runtime/NODE_PATH path below

## Runtime resolution (mirror cli.js)

1. **sqlite driver** — prepend `~/.9router/runtime/node_modules` to `NODE_PATH` before importing the db layer, so `driver.js` resolves `better-sqlite3` (or falls back to bundled `sql.js` / `node:sqlite`), identical to how `cli.js` self-heals and the standalone server resolves it.
2. **DATA_DIR** — default to the same path `cli.js`/the app use (`~/.9router`, platform-adjusted). Reuse `src/lib/db/paths.js` so the binary opens the **same** DB the running app uses. Honor an explicit `DATA_DIR` env override.

## Architecture

```
Claude Desktop
    │ spawns "9router-mcp" subprocess
    ↓
cli/bin/9router-mcp.js  (loose bin in published package)
    │  ├─ set NODE_PATH += ~/.9router/runtime/node_modules   (sqlite, like cli.js)
    │  ├─ set DATA_DIR default ~/.9router                     (paths.js)
    │  ├─ import bundled  app/src/lib/mcp/server.js  (relative-imports its db closure)
    │  ├─ initDb()  →  createMcpServer()
    │  └─ connect StdioServerTransport
    ↓
Claude Desktop reads JSON-RPC over stdio
```

(In the dev monorepo the same bin resolves the loose tree at root `src/`; both layouts work because imports are relative within the copied tree.)

## Related Code Files

- Create: `cli/bin/9router-mcp.js`
- Modify: `cli/package.json` — add `"9router-mcp": "./bin/9router-mcp.js"` to `bin`; add `bin/` to `files`
- Modify: `cli/scripts/build-cli.js` — new copy step (mirror updater step 7b): copy the MCP source closure into `cli/app/src/...`
- Create: `tests/unit/mcp-stdio-binary.test.js`

Read for context:
- `cli/cli.js` — runtime sqlite/NODE_PATH self-heal + DATA_DIR resolution (replicate)
- `cli/scripts/build-cli.js` — steps 7/7b (updater/MITM copy precedent)
- `src/lib/db/paths.js`, `src/lib/db/driver.js` — DATA_DIR + adapter selection
- `src/lib/mcp/server.js` — `createMcpServer()` from Phases 1-2

## TDD — failing test first

Launch the bin as a child process with an isolated `DATA_DIR`, drive MCP over stdin/stdout, assert it lists 3 tools and calls one. No HTTP, no mock server.

```js
// tests/unit/mcp-stdio-binary.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
beforeAll(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mcp-bin-")); });
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("9router-mcp stdio binary", () => {
  it("starts, lists 3 tools over stdio, exits cleanly on stdin close", async () => {
    const child = spawn("node", ["cli/bin/9router-mcp.js"], {
      env: { ...process.env, DATA_DIR: tempDir },   // isolated DB; init-on-first-open
      stdio: ["pipe", "pipe", "inherit"],
    });
    // write `initialize` then `tools/list` JSON-RPC framed for stdio; parse stdout
    // assert 3 tool names; then end stdin → expect exit code 0
  }, 20_000);
});
```

The test runs against the dev-tree layout (root `src/`). A separate manual check covers the bundled layout after `npm run build` in `cli/`.

## Implementation Steps

1. **Test-first:** write `tests/unit/mcp-stdio-binary.test.js`. Run → red (bin missing).
2. Confirm the MCP module uses relative imports (Phase 1 contract); fix any `@/` in `src/lib/mcp/*`.
3. Create `cli/bin/9router-mcp.js`:
   - Shebang `#!/usr/bin/env node`.
   - Prepend `~/.9router/runtime/node_modules` to `process.env.NODE_PATH`; `require("module").Module._initPaths()` if needed (match cli.js technique).
   - Default `DATA_DIR` to `~/.9router` (platform-adjusted) if unset, via `src/lib/db/paths.js`.
   - Resolve the MCP module path for BOTH layouts: bundled `<bin>/../app/src/lib/mcp/server.js`, else dev `<bin>/../../src/lib/mcp/server.js`. Dynamic-`import` whichever exists.
   - `await initDb(); const server = createMcpServer(); await server.connect(new StdioServerTransport());` (verify SDK stdio import path against installed `dist/`).
   - `SIGTERM`/`SIGINT`/stdin-close → close DB, `process.exit(0)`.
4. Update `cli/package.json`: add `9router-mcp` to `bin`, add `"bin"` to `files`.
5. Update `cli/scripts/build-cli.js`: after step 7b, add a step copying the MCP source closure (see "Source closure") into `cli/app/src/...`, preserving the relative tree. `chmod +x` the bin in the bundle.
6. Run tests → green (dev layout).
7. Manual bundled-layout check: `cd cli && npm run build`; run the bundled bin against a seeded `~/.9router`; confirm 3 tools list + `router.list_providers` returns rows.

## Success Criteria

- [ ] `cli/bin/9router-mcp.js` created with shebang + executable permission
- [ ] `cli/package.json` declares `9router-mcp` bin AND lists `bin/` in `files`
- [ ] `cli/scripts/build-cli.js` copies the MCP source closure into the bundle (mirrors updater step)
- [ ] `src/lib/mcp/*` uses relative imports for db/shared deps (no `@/`)
- [ ] Dev-layout test: bin launches, lists 3 tools, calls one, exits 0 on stdin close
- [ ] Bundled-layout manual check after `cli` build: bin works against `~/.9router`
- [ ] Concurrent run with the running app: no DB lock errors (WAL; `PRAGMA journal_mode = WAL` in `src/lib/db/schema.js`)
- [ ] Clean shutdown on `SIGTERM`/`SIGINT`/stdin-close

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Bundle missing the MCP source closure → `ERR_MODULE_NOT_FOUND` after global install | Build step copies the full relative closure; bundled-layout manual check is a required success criterion |
| `@/` alias leaks into `src/lib/mcp/*` and breaks under plain node | Phase 1 import-style contract + Step 2 grep; CI test runs the bin under node |
| `uuid` (connectionsRepo dep) not traced into bundle node_modules | Verify present after `cli` build; if absent, add to `ensureModuleInBundle()` like sql.js |
| sqlite driver not resolvable from bin | Replicate cli.js NODE_PATH self-heal; fall back to bundled `sql.js` / `node:sqlite` |
| Second SQLite handle conflicts with running app | WAL: concurrent reads + serialized writes; v1 tools are read-only → safe |
| Two-layout path resolution (dev vs bundle) | Bin probes both candidate module paths; manual check covers the bundle |
| SDK stdio transport import path differs by version | Verify `@modelcontextprotocol/sdk/server/stdio.js` against installed `dist/` |

## Security Considerations

- Binary runs as the user; opens local SQLite only — no remote calls, no privilege escalation.
- v1 tools are read-only → binary cannot mutate router state.

## Decision history

Earlier drafts said "import root `src/lib` in-process" (red-team's Phase-3-cancellation pivot). Pre-cook review found that breaks the **published** artifact: `cli/app/` is a compiled standalone bundle, root `src/` isn't shipped, sqlite is runtime-resolved. User chose the **bundle-the-module (updater pattern)** approach: copy the MCP source closure into the bundle + replicate cli.js runtime resolution + relative-only imports. Full audit trail: `plan.md` → `## Red Team Review` + the pre-cook review note.
