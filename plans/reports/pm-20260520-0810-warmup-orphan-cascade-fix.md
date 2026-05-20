# PM Report — Warmup orphan providerConnectionId cascade fix

**Date:** 2026-05-20
**Branch:** `feature/dylan-improve`
**Status:** completed (no formal plan; standalone bugfix invoked via `/ck-debug` → `/ck-fix`)
**Commit:** `1d3d92ca`

## Symptom

User reported: provider list shows 1 Claude account but warmup fires for 2 accounts. Old account already removed.

## Root Cause

`deleteProviderConnection` (`src/lib/db/repos/connectionsRepo.js:164`) removed the row from `providerConnections` only. The deleted connection ID stayed inside `kv['warmup','schedules'].providerConnectionIds[]`. Scheduler tick iterated this array blindly (`src/lib/warmup/schedule.js:71`) → fan-out for the orphan → runner threw `"Provider connection not found"` → failure row written + visible in run history.

Bulk variant `deleteProviderConnectionsByProvider` had the same gap.

## Fix

| Layer | Change |
|-------|--------|
| `connectionsRepo.js` | `pruneWarmupSchedulesInTx(db, Set<id>)` helper; called inside the existing `db.transaction` from both single + bulk delete paths. Cascade is atomic. |
| `schedule.js` | New pure helper `pruneOrphanProviderIds(schedules, knownIds)`. |
| `scheduler.js` | `tickWarmupScheduler` queries `providerConnections`, builds `knownIds` Set, runs `pruneOrphanProviderIds` before `findDueWarmupRunsInRange`. Defensive belt to the cascade's suspenders. |
| `tests/warmup-orphan-cascade.test.mjs` | 4 regression tests: single cascade, no-op on unrelated delete, bulk-by-provider cascade, prune-helper unit tests (Set + array `knownIds`). |

## Verification

| Check | Result |
|-------|--------|
| `npm run test:warmup` | 59/59 pass (4 new) |
| `npm run build` | clean |
| `npx eslint` | clean on all 4 modified files |
| `node --check` | clean |
| Blast-radius: 54 prior warmup tests | still pass (no regression to clamp / lastTickAt / runner / notifier / schedule normalization) |
| Public contracts | unchanged: `deleteProviderConnectionsByProvider` still returns deleted count |

## Behavior Diff

| Scenario | Before | After |
|----------|--------|-------|
| Delete connection still in schedule | Orphan ID persists in `providerConnectionIds[]` → next tick writes failure row | ID stripped during the delete transaction |
| Pre-existing orphan in DB (no delete event since fix) | Failure row per tick | Defensive filter in tick drops it silently — no failure row, no notify |
| Bulk delete (all connections for a provider) | All deleted IDs persist in schedules | All stripped in single transaction |
| `saveWarmupSchedules` (UI save path) | unchanged | unchanged |
| `notifyWarmupFailure` for orphans | red-team #14 `isConfigStateError` path already suppressed notify (no spam) | now also no failure row at all |

## Files Touched

- `src/lib/db/repos/connectionsRepo.js` (cascade + bulk cascade)
- `src/lib/warmup/schedule.js` (`pruneOrphanProviderIds` helper)
- `src/lib/warmup/scheduler.js` (apply helper in tick)
- `tests/warmup-orphan-cascade.test.mjs` (new — 4 tests)

## Plan File Status

No formal plan exists for this fix. Reports directory `plans/reports/` created for standalone bugfixes outside any plan scope.

## Follow-up / Open

- UI dashboard schedule-edit form may still show the orphan UUID in the selected-connections list until the user re-saves the schedule (the `<select>` value isn't auto-pruned client-side). Acceptable: cascade prevents new orphans, defensive filter prevents fan-out, user can clear UI display by saving the schedule once. Tracked here as a low-priority polish item, not a regression.
- No docs update warranted — fix is internal data-integrity, no API contract change.

## Unresolved Questions

None.
