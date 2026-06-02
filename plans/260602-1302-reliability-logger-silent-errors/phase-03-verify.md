---
phase: 3
title: "Verify"
status: pending
priority: P1
effort: "1-2h"
dependencies: [1, 2]
---

# Phase 3: Verify

## Overview
Prove the round shipped observability without regression: build green, logger
levels behave, no new test failures, the RTK marker intact.

## Requirements
- Functional: build + warmup pass; logger honors level; no new vitest failures.
- Non-functional: no log spam in normal prod operation.

## Architecture
Re-run the project's existing checks and assert the known-good baseline from the
first-60s perf round still holds (warmup 70/70; vitest 665 pass / 26 known fail).

## Related Code Files
- Create: `plans/260602-1302-reliability-logger-silent-errors/reports/verify-260602-reliability.md`

## Implementation Steps
1. `npm run build` — green, no new warnings.
2. `npm run test:warmup` — 70/70 (initializeApp + silent-error edits land here).
3. `npm test` (vitest) — assert pass count ≥ baseline 665 and failures = the
   same known 26 (no NEW failures). List any delta.
4. Logger behavior:
   - `NODE_ENV=production` (no `LOG_LEVEL`) → no `🔍 debug` lines from migrated files.
   - `LOG_LEVEL=DEBUG` → debug lines return.
   - Trigger a `logger.warn` path → confirms warn() now prints.
5. Grep `[RTK] saved` still emitted via raw console.log at chatCore.js:119 (unchanged).
6. Quick runtime smoke (no system-mutating start needed): import-level / unit check
   that migrated modules load without error.
7. Write verify report: counts (console.log migrated, catches triaged, catches
   left), test deltas, what shipped.

## Success Criteria
- [ ] Build green.
- [ ] warmup 70/70; vitest no new failures beyond known 26.
- [ ] Prod hides debug; `LOG_LEVEL=DEBUG` restores; warn() prints.
- [ ] `[RTK] saved` line intact.
- [ ] Verify report written with before/after counts.

## Risk Assessment
- Risk: a migrated level choice spams a passing test that asserts on stdout.
  Mitigation: Step 3 catches new failures; fix level if so.
- Risk: "no improvement" temptation — this round's value is observability +
  debuggability, not a perf number. Documented-quiet-prod is the pass.
