---
phase: 1
title: "Server logger migration + warn() fix"
status: pending
priority: P1
effort: "3-4h"
dependencies: []
---

# Phase 1: Server logger migration + warn() fix

## Overview
Repair the no-op `logger.warn()`, then route the server-side `console.log`
hotspots (~70 calls) through the env-gated logger so production honors
`LOG_LEVEL` and operational logs are consistent.

## Requirements
- Functional: server hotspot files log via `logger.{debug,info,warn,error}`;
  `logger.warn()` actually prints.
- Non-functional: no behavior change beyond log routing; prod (INFO) hides debug.

## Architecture

### Prerequisite — fix `logger.warn()`
`src/sse/utils/logger.js:43` has its `console.warn` commented out → `warn()` is a
no-op at every level. Uncomment it (mirror `debug`/`error` formatting). Without
this, any migrated warning silently vanishes.

### Logger import
Server modules import named fns from `@/sse/utils/logger` (or relative path for
`open-sse/*`). Use a short tag per module (e.g. `"InitApp"`, `"Tunnel"`,
`"OAuth"`) matching the existing bracketed prefixes already in the log strings.

### Mapping rule (by intent, not mechanical)
- verbose / per-tick / dev traces → `logger.debug(tag, msg, data?)`
- operational milestones (tunnel up, init complete, model list refreshed) → `logger.info`
- recoverable problems → `logger.warn`
- failures / caught errors → `logger.error`
- Strip the inline `[Tag]` prefix from the message when moving to `logger(tag,…)`
  (the logger adds it) — avoid double-bracketing.

### Target files (server-side, >5 console.log) — 6 files, ~62 calls
- `src/shared/services/initializeApp.js` (19)
- `src/lib/tunnel/tailscale/manager.js` (11)
- `src/lib/tunnel/cloudflare/manager.js` (11)
- `src/lib/tunnel/tailscale/tailscale.js` (7)
- `src/app/api/providers/[id]/models/route.js` (9)
- `src/app/api/v1/models/route.js` (7)
- (optional, if cheap) `src/mitm/manager.js` server-side logs

<!-- Updated: Validation Session 1 - oauth/utils/ui.js EXCLUDED. Its console.log
uses chalk/ora = intentional user-facing CLI output (spinners/colored text during
OAuth), NOT stdout noise. Routing through the logger would break CLI UX. -->

### CLI-visibility rule (Validation Session 1)
9router runs as a CLI (`npx 9router`) — users watch its terminal. Map
operational **milestones** (`[InitApp]` init/tunnel-resume, `[Tunnel]`/
`[Tailscale]` restart success/failure) to **`logger.info`** so they stay visible
at the prod INFO default. Reserve `logger.debug` for per-tick / watchdog /
network-monitor / verbose traces (hidden in prod, restored by `LOG_LEVEL=DEBUG`).

### Do NOT touch
- Client dashboard pages (`providers/[id]/page.js`, `proxy-pools/page.js`,
  `EndpointPageClient.js`, `ConnectionsCard.js`) — browser audience, follow-up.
- `src/sse/utils/logger.js` log bodies (it's the impl).
- Raw `[RTK] saved …` line at `open-sse/handlers/chatCore.js:119`.

## Related Code Files
- Modify: `src/sse/utils/logger.js` (uncomment warn)
- Modify: the 7 server hotspot files listed above
- Read for context: existing log-string prefixes to pick consistent tags

## Implementation Steps
1. Uncomment `console.warn` in `logger.js:43`; confirm format matches siblings.
2. For each target file: add the logger import, convert each `console.log`/
   `console.error` to the intent-matched logger fn, strip duplicate `[Tag]`.
3. Leave any `console.log` that is a deliberate user-facing CLI banner (if any)
   — note it in the file's commit message rather than forcing it through logger.
4. `npm run build` — green.
5. Spot-check: run with `NODE_ENV=production` (no `LOG_LEVEL`) → no debug lines;
   `LOG_LEVEL=DEBUG` → debug returns.

## Success Criteria
- [ ] `logger.warn()` prints (verified by direct call).
- [ ] 6 target files emit via logger; their server `console.log` count ~0.
- [ ] Operational milestones → `info` (visible at prod INFO); per-tick/watchdog → `debug`.
- [ ] `oauth/utils/ui.js` left untouched (intentional chalk/ora CLI output).
- [ ] No double `[Tag][Tag]` prefixes.
- [ ] Build green; `[RTK] saved` line untouched.

## Risk Assessment
- Risk: wrong level choice floods prod (e.g. per-tick at info). Mitigation: per-tick/
  watchdog → debug. Review each tunnel/watchdog loop call specifically.
- Risk: client/server boundary — a "server" file actually imported client-side.
  Mitigation: targets are all server-only (services/lib/api/mitm); verify no
  `"use client"` consumer imports them for browser bundle.
- Risk: double-bracket tags. Mitigation: strip inline prefix when adding tag arg.
