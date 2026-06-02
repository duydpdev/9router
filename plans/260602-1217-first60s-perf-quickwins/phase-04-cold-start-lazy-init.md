---
phase: 4
title: "Cold-start lazy-init"
status: completed
priority: P2
effort: "3-5h (conditional)"
dependencies: [1]
---

# Phase 4: Cold-start lazy-init

## Overview
**Cleanup-primary, deferral-conditional phase** (validation decision). The
dead `@/server-init` import fix ships **regardless** (it logs an error every
boot). The `initializeApp` reorder/deferral runs **only if** Phase 1 measures a
real blocking init cost — scout shows init is already fire-and-forget, so the
default expectation is "cleanup only, no reorder".

<!-- Updated: Validation Session 1 - scoped to cleanup-only unless P1 proves a blocking cost. No speculative boot-ordering churn. -->>

## Gating Precondition
Read `baseline.md` Phase-4 verdict + the per-step `initializeApp` timings.
- **Skip** if: server answers `/api/settings` quickly and `initializeApp` is
  already off the request path (scout shows `bootstrap.js:11` is fire-and-forget).
- **Proceed** if: a specific blocking call (e.g. `startMitm`, tunnel auto-resume,
  `restoreToolDNS`, `cleanupProviderConnections`) measurably delays first 200.

## Requirements
- Functional: first successful `/api/settings` + `/v1/models` 200 happens sooner,
  OR documented as already-fast.
- Non-functional: deferred subsystems (warmup, tunnel, mitm) still start, just
  after first paint; no feature silently disabled.

## Architecture
Two findings from scout to resolve/exploit:

1. **Boot entry dedup.** `src/instrumentation.js` imports missing
   `@/server-init` (resolves to catch), while `src/app/layout.js` →
   `bootstrap.js` runs `initializeApp`. Confirm in Phase 1 which path is live.
   If `instrumentation.register()` is dead-importing, either fix it to call the
   real init or remove the dead import (it currently swallows an error every boot).

2. **Defer-after-ready pattern** in `initializeApp` (`src/shared/services/initializeApp.js`):
   - Keep on critical path: `getSettings`, anything the first request needs.
   - Defer (schedule via `setImmediate`/`queueMicrotask` after returning, or
     behind first-request trigger): `startWarmupScheduler`, tunnel auto-resume
     (network probes — slow), `restoreToolDNS`, `startMitm` if not needed for
     `/v1` traffic.
   - Guard each deferred start with its existing once-per-process flag (`g.*`)
     so deferral doesn't double-fire.

## Related Code Files
- Read: `baseline.md` (gate)
- Modify (conditional): `src/shared/services/initializeApp.js`,
  `src/instrumentation.js` (dead-import fix/removal),
  possibly `src/shared/services/bootstrap.js`
- Read for context: `src/lib/warmup/scheduler.js`, `src/lib/tunnel/index.js`,
  `src/mitm/manager.js`

## Implementation Steps
1. Read Phase-1 verdict. If "skip" → document why (init already off hot path),
   BUT still resolve finding #1 (dead `server-init` import) as a tiny cleanup
   since it logs an error every boot. Mark phase done.
2. If "proceed": reorder `initializeApp` so the function returns after only
   critical work; wrap deferrable starts to run post-return without blocking.
3. Verify each deferred subsystem still starts (warmup tick fires, tunnel
   resumes, mitm available) within a few seconds — check logs.
4. Re-time process-spawn → first `/api/settings` 200 (same script as Phase 1).
5. Record before/after in `baseline.md`.

## Success Criteria
- [ ] Dead `@/server-init` import resolved (fixed or removed) — no per-boot error.
- [ ] Either: measured drop in time-to-first-200, all deferred subsystems still start.
- [ ] Or: documented "init already off critical path — no reorder needed".
- [ ] No subsystem permanently disabled (warmup/tunnel/mitm verified live post-boot).

## Risk Assessment
- Risk: deferring tunnel/mitm breaks users who proxy immediately on boot.
  Mitigation: defer only what first request doesn't need; keep `/v1` creds path intact.
- Risk: double-start from deferral racing the existing flag. Mitigation: reuse
  the `g.*` once-flags; set flag before scheduling deferred work.
- Risk: removing instrumentation import hides a build-time-injected init.
  Mitigation: Phase 1 confirms whether it resolves at build before touching it.
