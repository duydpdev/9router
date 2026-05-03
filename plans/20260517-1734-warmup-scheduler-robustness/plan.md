---
title: "Warmup Scheduler Robustness (Catch-up + Persistence)"
description: ""
status: pending
priority: P2
branch: "feature/dylan-improve"
tags: []
blockedBy: []
blocks: []
created: "2026-05-17T10:35:54.378Z"
createdBy: "ck:plan"
source: skill
---

# Warmup Scheduler Robustness (Catch-up + Persistence)

## Overview

Make warmup scheduler tolerant of process restart and downtime. Backward-window scan over hour boundaries between last tick and now, deduped via existing `hasWarmupRun`. Persist `lastTickAt` in `kv` (`scope=warmup`) so catch-up survives reboot. Cap catch-up at `MAX_CATCHUP_HOURS=6`. TDD: write failing tests first per logical unit, then make them pass.

**Source brainstorm:** `./brainstorm-summary.md`

**Constraints**
- Single-VPS Node deployment. No external scheduler / cluster lock needed.
- Public APIs unchanged. Only internal scheduler + new pure fn.
- Existing dedupe via `dedupeKey` must remain authoritative.

**Out of scope** (deferred to separate plans)
- Retry/backoff in runner (transient upstream errors retry policy beyond catch-up window)
- Jitter across providers
- Failure-streak alerting UI
- SonarQube nits, runtime stop fn

**Pulled INTO scope post red-team:**
- Refactor `warmupRunsRepo` so each run is a row in a dedicated table (not a JSON blob in `kv`). Catch-up amplifies the O(n²) write pattern + breaks 100-entry dedupe window.
- Status-aware dedupe (only `status='success'` blocks retry).

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Storage refactor: warmup_runs + warmup_dedupe tables](./phase-01-tests-for-findduewarmuprunsinrange.md) | Pending |
| 2 | [Tests for findDueWarmupRunsInRange (isolated DB)](./phase-02-tests-for-persisted-lasttickat.md) | Pending |
| 3 | [Implement findDueWarmupRunsInRange (UTC :00 only, shared ceilToHour)](./phase-03-implement-range-scan.md) | Pending |
| 4 | [Implement lastTickAt persistence (makeKv + monotonic + tests)](./phase-04-implement-lasttickat-persistence.md) | Pending |
| 5 | [Wire scheduler (persist-before, await init, gate manual, status-aware dedupe)](./phase-05-wire-scheduler-tick-with-cap.md) | Pending |
| 6 | [Regression sweep + manual smoke](./phase-06-regression-sweep.md) | Pending |

## Dependencies

<!-- Cross-plan dependencies -->

## Red Team Review

### Session — 2026-05-17

**Findings:** 40 raw → 15 deduped (4 reviewers: Security Adversary, Assumption Destroyer, Failure Mode Analyst, Scope & Complexity Critic).
**Severity breakdown:** 4 Critical, 6 High, 5 Medium
**Dispositions:** 14 Accepted, 1 Deferred (DST testing — Asia/Ho_Chi_Minh has no DST).

| # | Finding | Severity | Disposition | Applied To |
|---|---|---|---|---|
| 1 | 30-min iteration is wrong; `getLocalSlot` floors minute, UTC `:00` is sufficient | Critical | Accept | Phase 3 |
| 2 | MAX_RUN_HISTORY=100 evicts dedupe entries during multi-schedule catch-up | Critical | Accept | Phase 1 (new prereq) |
| 3 | Phase 2 tests would write to user's real `~/.9router/db/data.sqlite` | Critical | Accept | Phase 2 |
| 4 | Manual `/api/warmup/run` + scheduler catch-up race on `appendWarmupRun` | Critical | Accept | Phase 5 |
| 5 | Failed runs permanently poison dedupe (`hasWarmupRun` is status-agnostic) | High | Accept | Phase 1 |
| 6 | `lastTickAt` advances even when all items failed → missed slots lost | High | Accept | Phase 5 |
| 7 | Crash-loop persist timing: brainstorm says "persist immediately", sketch persists after | High | Accept | Phase 5 |
| 8 | Initial-tick race with SQLite migrations + stale `now` snapshot | High | Accept | Phase 5 |
| 9 | `appendWarmupRunToDb` O(n²) amplified by catch-up — must fix in this round | High | Accept | Phase 1 |
| 10 | `scheduledForUtc` semantics for catch-up entries (boundary vs actual) | High | Accept (doc) | Phase 5 |
| 11 | `setWarmupLastTickAt` over-defensive (silent swallow), not monotonic | Medium | Accept | Phase 4 |
| 12 | Should use existing `kvStore.js makeKv()` helper, not hand-rolled SQL | Medium | Accept | Phase 4 |
| 13 | `ceilToHour` duplicates `buildWarmupPreview` inline pattern | Medium | Accept | Phase 3 |
| 14 | Phase 1 `from===to` test contract ambiguous w/ Phase 3 hour-boundary algorithm | Medium | Accept | Phase 1, Phase 3 |
| 15 | DST transitions untested | Medium | Reject (defer) | Documented as unsupported |

### Decision deltas (incorporated into phase rewrites)

- **Storage refactor (Phase 1):** new `warmup_runs` table with per-row `INSERT`, new `warmup_dedupe(dedupe_key PRIMARY KEY, status, created_at)` table. `appendWarmupRun` becomes O(1). `hasWarmupRun(key)` checks dedupe table where `status='success'`.
- **Iteration step (Phase 3):** UTC `:00` only. Half-hour TZs covered because `getLocalSlot` floors minute. Add Kolkata test.
- **Persistence helper (Phase 4):** Use `makeKv("warmup")` from `src/lib/db/helpers/kvStore.js`. Throw on invalid input. Reject backward writes (monotonic guard).
- **Scheduler (Phase 5):**
  - `await` initial tick from `startWarmupScheduler` (block startup briefly).
  - Take `now` inside `try` block, not via default arg.
  - Persist `setWarmupLastTickAt(now)` BEFORE `runWarmupItems`. Idempotent via dedupe; crash-loop safe.
  - Gate `/api/warmup/run` manual route behind `g.running`: return 409 if scheduler tick in flight.
  - Status-aware dedupe: only successful runs block. Failed runs retry on next tick (within window).
- **Test isolation (Phase 2):** set `process.env.DATA_DIR = fs.mkdtempSync(...)` in test `before()` BEFORE any module import that resolves DB path.
- **Drop `MAX_CATCHUP_HOURS` advance-on-throw branch:** `runWarmupItems` never throws (runner catches all). Replace with: persist BEFORE work + status-aware dedupe ⇒ no need to gate `lastTickAt` on success.
- **Drop `ceilToHour` duplication:** extract from `buildWarmupPreview`; reuse in `findDueWarmupRunsInRange`.

### Whole-Plan Consistency Sweep

Plan structure: 6 phases retained. Old phase content rewritten in place to incorporate decisions. Phase 1 repurposed as "Storage refactor (new prereq)". Old Phase 1 (tests for findDueWarmupRunsInRange) merged into new Phase 3. Old Phase 2 (tests for persisted lastTickAt) merged into new Phase 4. Phases re-numbered logically.

## Validation Log

### Session — 2026-05-17

Critical-questions interview after red-team adjudication. Verification pass skipped per guard (Red Team Review section already present with file:line evidence).

| # | Question | Decision | Applied To |
|---|----------|----------|------------|
| V1 | `warmup_runs` retention policy | Keep last 1000 rows; periodic sweep every 10min via separate interval timer | Phase 1 |
| V2 | `MAX_CATCHUP_HOURS = 6` post storage refactor | Keep 6h (storage no longer the constraint; cap balances correctness vs burst) | Phase 5 |
| V3 | Failure rows in run history UI | Show all rows incl. failures so operator sees retry history | Phase 1, Phase 6 |
| V4 | `startWarmupScheduler` await initial tick — boot blocking | Block boot; ensures migrations finish before interval. Cold-start window is `now=now` → zero work on fresh install. Long-outage catch-up may add seconds. | Phase 5 |

### Whole-Plan Consistency Sweep

- Phase 1 retention: explicit "1000 rows, sweep every 10min" replaces the earlier "default keep last 1000, configurable" note.
- Phase 5 retains `MAX_CATCHUP_HOURS = 6`. No change.
- Phase 1 + Phase 6 confirm UI displays all `warmup_runs` entries including `failure` status. No collapse-by-dedupeKey filter in history page.
- Phase 5 await-initial-tick decision confirmed; no fallback timeout added.
- No stale `MAX_RUN_HISTORY`, `trimWarmupRuns`, or 30-min iteration references in any phase file. brainstorm-summary.md kept as historical record.
