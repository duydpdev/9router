---
phase: 5
title: "Verify"
status: completed
priority: P1
effort: "2h"
dependencies: [2, 3, 4]
---

# Phase 5: Verify

## Overview
Prove the plan delivered (or honestly didn't) and shipped no regression.
Re-measure against Phase-1 baseline and run the full test suite.

## Requirements
- Functional: before/after numbers recorded; build + tests green.
- Non-functional: no dashboard route or `/v1` path regressed.

## Architecture
Re-run the exact Phase-1 measurement procedures (same commands, same machine
note) and diff against `baseline.md`. Treat a "no improvement, skipped as
already-optimal" outcome as a valid pass — the win was the evidence, not churn.

## Related Code Files
- Modify: `plans/260602-1217-first60s-perf-quickwins/baseline.md` (append "after" section)
- Create: `plans/260602-1217-first60s-perf-quickwins/reports/verify-260602-first60s.md`

## Implementation Steps
1. `rm -rf .next && npm run build` — green, no new warnings from removed file.
2. Re-time cold start (3×, median) — compare to Phase-1.
3. `ANALYZE=true npm run build` (if Phase 3 ran) — compare shared chunk bytes.
4. `npm test` (vitest) + `npm run test:warmup` — all green. Pay attention to
   warmup tests since Phase 4 may have touched init/scheduler ordering.
5. Manual smoke: dashboard home, `/usage` (chart+topology), `/translator`
   (Monaco), connect-a-provider happy path, one `/v1/models` call.
6. Confirm `LOG_LEVEL` behavior: start with `NODE_ENV=production` → no DEBUG
   lines; start with `LOG_LEVEL=DEBUG` → verbose returns.
7. Write verify report: before/after table, what shipped, what was skipped-with-reason.

## Success Criteria
- [ ] `npm run build` green; `page.new.js` absent.
- [ ] vitest + warmup suites pass.
- [ ] Cold-start + bundle numbers recorded after vs before (or documented no-op).
- [ ] Prod logs quiet by default; `LOG_LEVEL=DEBUG` restores verbosity.
- [ ] Manual smoke clean on all listed routes + one `/v1` call.

## Risk Assessment
- Risk: warmup/tunnel ordering regression from Phase 4 only shows at runtime,
  not in unit tests. Mitigation: explicit runtime log check in Step 4/5.
- Risk: "no improvement" tempts re-litigating skipped phases. Per plan gating
  rule, documented-skip is a pass — do not churn working code chasing a number.
