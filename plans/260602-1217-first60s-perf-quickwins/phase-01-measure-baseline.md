---
phase: 1
title: "Measure baseline"
status: completed
priority: P1
effort: "3-4h"
dependencies: []
---

# Phase 1: Measure baseline

## Overview
Produce hard numbers for the two first-run surfaces — server cold-start time and
dashboard JS payload — so Phases 3/4 are evidence-driven, not guessed. No
product code changes in this phase.

## Requirements
- Functional: a `baseline.md` report under this plan dir with reproducible numbers.
- Non-functional: measurements must be repeatable (command + machine noted).

## Architecture
Two independent measurement tracks:

**Track A — cold start (server ready latency)**
- Boot entry points to map first (scout found ambiguity):
  - `src/instrumentation.js` `register()` → awaits `import("@/server-init")`
    — **but `src/server-init.*` does not exist** (resolves to catch). Confirm
    whether webpack injects it at build, or this is dead.
  - `src/app/layout.js` imports `@/shared/services/bootstrap` →
    `bootstrap.js:11` calls `initializeApp().catch()` (fire-and-forget).
  - `src/shared/services/initializeApp.js` (352 lines): sequential `await`
    chain — `cleanupProviderConnections` → `getSettings` → tunnel auto-resume
    → `startWarmupScheduler` → `startMitm` → `restoreToolDNS`.
- Measure: time from process spawn to first successful `GET /api/settings` 200,
  and to first `/v1/models` 200, on a cold `npm run build && npm run start`.

**Track B — bundle payload**
- `next build` already runs (webpack). Capture the per-route + shared chunk
  size table Next prints. If insufficient detail, add
  `@next/bundle-analyzer` **dev-only** (gated behind `ANALYZE=true`, not a prod dep).
- Identify what lives in the **shared/initial** chunk vs per-route chunks.
  Confirm `recharts` (`usage/components/UsageChart.js`) and `@xyflow/react`
  (`usage/components/ProviderTopology.js`) are isolated to `/usage` route and
  NOT leaking into shared.

## Related Code Files
- Create: `plans/260602-1217-first60s-perf-quickwins/baseline.md`
- Read (no modify): `src/instrumentation.js`, `src/app/layout.js`,
  `src/shared/services/bootstrap.js`, `src/shared/services/initializeApp.js`,
  `next.config.mjs`
- Modify (dev-only, optional, revert after): `next.config.mjs` to wire
  `@next/bundle-analyzer` behind `ANALYZE` env

## Implementation Steps
1. Resolve boot entry ambiguity: confirm if `@/server-init` resolves at build
   (grep `.next` output or add a temp log in `register()`); record which init
   path actually runs.
2. Cold-start timing: `rm -rf .next && npm run build`, then `npm run start`
   while timing process-spawn → first `/api/settings` 200 (use a poll script).
   Run 3×, record median + machine specs.
3. Instrument `initializeApp` with `performance.now()` deltas around each
   `await` step (temp logging) to find the longest blocking call. Remove temp
   logs after capture.
4. Bundle: run `next build`, copy the route/chunk size table into `baseline.md`.
5. If table lacks shared-vs-route breakdown, add bundle-analyzer behind
   `ANALYZE=true`, run `ANALYZE=true npm run build`, screenshot/record shared
   chunk contents, then leave the analyzer wiring inert (off by default).
6. Write `baseline.md`: numbers + the **gating verdict** for Phases 3 & 4
   (proceed / skip-as-already-optimal), per plan.md gating rule.

## Success Criteria
- [ ] `baseline.md` records cold-start median (3 runs) + slowest init step.
- [ ] `baseline.md` records shared chunk size + per-route sizes for `/usage`, `/translator`, providers pages.
- [ ] Boot entry-point ambiguity resolved (which path runs; is `server-init` dead?).
- [ ] Explicit go/skip verdict written for Phase 3 and Phase 4.

## Risk Assessment
- Risk: measurement on dev machine ≠ user machine (npx on cold npm cache).
  Mitigation: note this is relative-improvement measurement, not absolute SLA.
- Risk: bundle-analyzer accidentally shipped as prod dep. Mitigation: devDep +
  `ANALYZE` gate; verify `package.json` `dependencies` untouched.
