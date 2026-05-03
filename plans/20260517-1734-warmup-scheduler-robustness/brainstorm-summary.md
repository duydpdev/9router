# Warmup Scheduler Robustness — Brainstorm Summary

**Date:** 2026-05-17
**Scope:** Correctness/robustness only. Other warmup improvements deferred.
**Decision:** Approach A + B (backward-window scan + persist `lastTickAt`)

---

## Problem statement

Warmup scheduler missed scheduled slots in production while manual run via `/dashboard/warmup` worked. Two compounding defects:

1. **Minute-mismatch bug (fixed in prior commit):** `getLocalSlot()` returned `localTime` with real current minute (e.g. `09:23`). Schedule times normalized to `HH:00` only. Tick interval 60s drifted off `:00`, so `HH:00` schedules almost never matched. Fix: force minute to `00` in `getLocalSlot`. Regression test added.

2. **No catch-up after downtime (this round):** Even with fix #1, if server is asleep / restarted / process slow at the moment of `HH:00`, that slot is silently lost. Scheduler only inspects `now`, never the gap since previous tick. Single-VPS deployment that reboots on deploy or experiences NTP skew loses warmup runs without any user-visible signal.

## Requirements

- Expected output:
  - `findDueWarmupRunsInRange(schedules, from, to)` pure function returning items for every hour boundary in `[from, to]`.
  - `scheduler.tickWarmupScheduler` calls it with `[g.lastTickAt, now]` window.
  - `g.lastTickAt` persisted to local DB so it survives process restart.
- Acceptance criteria:
  - After process restart at `HH+1:30` for a `HH:00` schedule, missed slot fires within next tick.
  - Catch-up capped at `MAX_CATCHUP_HOURS = 6` so multi-day outage doesn't burst hundreds of requests on recovery.
  - Existing `hasWarmupRun(dedupeKey)` continues to deduplicate; no double-fire even if window overlaps an already-handled slot.
  - All existing tests pass + new tests cover: (a) 3-hour catch-up, (b) cap enforcement, (c) idempotency when run twice over same window.
- Scope boundary: only `src/lib/warmup/schedule.js`, `src/lib/warmup/scheduler.js`, `src/lib/warmup/store.js`, `src/lib/localDb.js`, tests. UI, runner, retry, jitter, alerting, code-quality cleanup NOT in this round.
- Constraints: single long-running Node VPS; no external scheduler. `Asia/Ho_Chi_Minh` is default timezone but per-schedule override supported.
- Touchpoints (from scout):
  - `src/lib/warmup/scheduler.js` — tick loop and global state
  - `src/lib/warmup/schedule.js` — pure scheduling logic
  - `src/lib/warmup/store.js` — DB-backed store, dedupe
  - `src/lib/localDb.js` — JSON-file persistence (add `warmupLastTickAt` field)
  - `tests/warmup-schedule.test.mjs` — extend coverage

## Approaches evaluated

### A — Backward-window scan (in-memory only)
Walk `HH:00` boundaries between `g.lastTickAt` and `now`. Reuse existing `findDueWarmupRuns` per boundary. `hasWarmupRun` provides dedupe.

- Pros: ~30 LOC, pure-fn, reuses dedupe path, test-friendly.
- Cons: `g.lastTickAt` lost on restart → only current hour caught after fresh process start.

### B — Persist `lastTickAt`
Persist scheduler's `lastTickAt` to local DB on each successful tick.

- Pros: catch-up survives restart, which is the most common downtime cause on a single VPS deploy.
- Cons: one disk write per minute. Negligible at JSON file scale, but write-amplification noted.

### C — setTimeout per schedule (precise cron)
Compute next-fire timestamp per schedule, `setTimeout` until it.

- Pros: zero drift, no polling overhead.
- Cons: doesn't survive sleep on macOS; schedule edits invalidate all timers; KISS violation for current scale.

## Decision

**A + B.** Backward-window scan plus persistence of `lastTickAt`. Cap window at `MAX_CATCHUP_HOURS = 6`. Catch-up runs use the missed slot's own `localTime` (e.g. `09:00`), already correct via existing `findDueWarmupRuns` output. Persistence uses existing `localDb` JSON store; reuse a singleton field rather than new collection.

Rationale:
- KISS: leverages existing pure-fn and dedupe machinery.
- YAGNI: skips per-schedule timer state and external scheduler — single-VPS doesn't need them.
- DRY: no duplicate dedupe logic; same `dedupeKey` path serves both real-time and catch-up runs.

## Implementation considerations

- **Cap implementation:** if `now - lastTickAt > 6h`, clamp `from = now - 6h`. Log at info-level that catch-up was clamped, surfacing operator-visible signal.
- **Cold start:** if no persisted `lastTickAt`, treat as `now - 1h` to catch the current hour exactly once. Persist immediately so a crash loop doesn't re-fire the same hour.
- **Race / re-entrancy:** `g.running` guard already exists; tick won't overlap itself. Persist `lastTickAt` only after `runWarmupItems` resolves so a mid-tick crash retries the window next time (idempotent via `hasWarmupRun`).
- **Timezone correctness:** schedule already stores its own `timezone`. `findDueWarmupRunsInRange` iterates UTC hour boundaries; `getLocalSlot` projects each into the schedule's TZ per existing logic. No DST regression because TZ-conversion happens inside `getLocalSlot`.
- **Dedupe window:** `hasWarmupRun` reads run history capped at 100. Hour-level dedupe within a 6h window inspects at most `6 × providerCount × scheduleCount` keys — well inside 100 for realistic configs. Note for future: O(n²) write pattern in `appendWarmupRunToDb` remains.

## Risks

| Risk | Mitigation |
|------|------------|
| Run history overflow under heavy catch-up (e.g. 6h × 10 providers = 60 entries / catch-up) | Cap to 100 acceptable, but flag `appendWarmupRunToDb` rewrite as follow-up |
| `lastTickAt` corruption / missing key after schema change | Default to `now - 1h` on read failure |
| User edits schedule mid-catch-up | Re-read schedules each tick already; new schedules apply forward; no stale state |
| Burst on long outage recovery exceeds upstream rate limit | `MAX_CATCHUP_HOURS = 6` cap; sequential `runWarmupItems` ensures serialization |

## Success metrics

- After `kill -9 && restart` at `:30` of a scheduled hour, that hour's run appears in run history within next tick.
- Zero double-fires for any `dedupeKey` across catch-up windows (verified by test + observed in run log).
- After 7-day outage, recovery fires at most 6 slots per schedule×provider, not 168.

## Validation

1. Unit: `findDueWarmupRunsInRange` covers ranges spanning 0, 1, 6, >6 hours. Day boundary. TZ midnight.
2. Unit: scheduler tick idempotency when called twice with same window.
3. Integration: simulate restart by clearing `g`, run tick → catch-up fires expected slots.
4. Pre-existing: `tests/warmup-schedule.test.mjs` 9 tests still pass.

## Next steps

Hand off to `/ck:plan` with this summary path. Plan should phase as:
1. Refactor `getLocalSlot` callers + add `findDueWarmupRunsInRange` (pure, tested).
2. Persist `lastTickAt` in `localDb` + scheduler integration.
3. Cap + clamp logic + tests.
4. Run regression suite + manual test via `/dashboard/warmup`.

## Deferred follow-ups (separate rounds)

- **#2 retry/backoff** in `runner.js`.
- **#4 jitter** for fan-out across providers.
- **#7 failure alerting** with consecutive-fail counter in UI.
- **#10/#5/#11 code-quality** cleanup: SonarQube nits, O(n²) write, runtime stop function.

## Open questions

None. All three open questions resolved during brainstorm.
