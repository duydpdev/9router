---
phase: 5
title: >-
  Wire scheduler (persist-before-run, await init, gate manual, status-aware
  dedupe)
status: completed
priority: P1
effort: 1.5h
dependencies:
  - 3
  - 4
---

# Phase 5: Wire scheduler tick with catch-up

## Overview

Integrate `findDueWarmupRunsInRange` + persisted `lastTickAt` into `tickWarmupScheduler`. Apply all accepted red-team fixes:
- Persist `setWarmupLastTickAt(now)` BEFORE `runWarmupItems` (Finding 7) — idempotent via status-aware dedupe (Finding 5).
- `await` initial tick from `startWarmupScheduler` (Finding 8) so module migrations finish before interval timer competes.
- Take `now` inside `try` block, not via default arg (Finding 8 stale-now risk).
- Cap catch-up at `MAX_CATCHUP_HOURS=6`.
- Gate `/api/warmup/run` manual route behind `g.running` (Finding 4) — return 409 if scheduler busy.
- `scheduledForUtc` documented as slot boundary; `actualRanAt` added by runner (Finding 10).

## Requirements

Functional:
- `tickWarmupScheduler()` (no `now` arg; takes wall-clock inside `try`):
  1. Re-entrancy: `if (g.running) return { skipped: true, reason: "already-running" }`.
  2. Set `g.running = true`.
  3. Inside `try`: `const now = new Date();`
  4. Resolve window: `persisted = await getWarmupLastTickAt(); if (!persisted) from = now; else from = max(persisted, now - 6h)`. If clamped, log once per outage (compare against previous tick's persisted via `g.lastClampedFrom`).
  5. **Persist `setWarmupLastTickAt(now)` BEFORE `runWarmupItems`.** Crash-loop safe: status-aware dedupe blocks repeats of successful runs; failures within window retry next tick.
  6. `const due = findDueWarmupRunsInRange(schedules, from, now);`
  7. `if (due.length) await runWarmupItems(due);`
  8. Update `g.lastResult` for `/api/warmup/status`.
- `startWarmupScheduler()`:
  - `if (g.interval) return;`
  - **`await tickWarmupScheduler();`** (initial tick — block until done so subsequent module loads see consistent state).
  - Then `g.interval = setInterval(() => tickWarmupScheduler().catch(...), CHECK_INTERVAL_MS); g.interval.unref();`
- `/api/warmup/run` (manual):
  - `if (getWarmupSchedulerStatus().running) return NextResponse.json({ error: "scheduler tick in progress, try again shortly" }, { status: 409 });`
  - Otherwise behave as today.
- `MAX_CATCHUP_HOURS` exported constant = 6.

Non-functional:
- `scheduledForUtc` = slot boundary; document at the top of `schedule.js` as the slot identifier semantics (red-team Finding 10).
- `runWarmupItems` callers include `actualRanAt` via runner (Phase 1 already wires this).

## Architecture

```js
// src/lib/warmup/scheduler.js (full rewrite)
import { findDueWarmupRunsInRange } from "@/lib/warmup/schedule";
import {
  getWarmupSchedules,
  getWarmupLastTickAt,
  setWarmupLastTickAt,
} from "@/lib/warmup/store";
import { runWarmupItems } from "@/lib/warmup/runner";

export const MAX_CATCHUP_HOURS = 6;
const CHECK_INTERVAL_MS = 60 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const g = (global.__warmupScheduler ??= {
  interval: null,
  running: false,
  lastTickAt: null,
  lastResult: null,
  lastClampedFrom: null,
});

const RETENTION_SWEEP_MS = 10 * 60 * 1000;

export async function startWarmupScheduler() {
  if (g.interval) return;
  try {
    await tickWarmupScheduler(); // initial — block; ensures migrations finish before interval competes
  } catch (error) {
    console.log("[WarmupScheduler] initial tick failed:", error.message);
  }
  g.interval = setInterval(() => {
    tickWarmupScheduler().catch((error) => console.log("[WarmupScheduler] tick failed:", error.message));
  }, CHECK_INTERVAL_MS);
  if (g.interval.unref) g.interval.unref();

  // V1 retention: sweep warmup_runs to last 1000 rows every 10 min
  if (!g.retentionInterval) {
    g.retentionInterval = setInterval(() => {
      sweepWarmupRunsRetention().catch((e) => console.log("[WarmupScheduler] retention sweep failed:", e.message));
    }, RETENTION_SWEEP_MS);
    if (g.retentionInterval.unref) g.retentionInterval.unref();
  }
}

export async function tickWarmupScheduler() {
  if (g.running) return { skipped: true, reason: "already-running" };
  g.running = true;
  try {
    const now = new Date();
    const cap = new Date(now.getTime() - MAX_CATCHUP_HOURS * 3600 * 1000);
    const persistedRaw = await getWarmupLastTickAt();
    const persisted = ISO_RE.test(persistedRaw || "") ? new Date(persistedRaw) : null;

    let from;
    if (!persisted) {
      from = now;
    } else if (persisted < cap) {
      if (g.lastClampedFrom !== persistedRaw) {
        console.log(`[WarmupScheduler] catch-up clamped from ${persistedRaw} to ${cap.toISOString()}`);
        g.lastClampedFrom = persistedRaw;
      }
      from = cap;
    } else {
      from = persisted;
    }

    // Persist BEFORE running — idempotent via status-aware dedupe
    await setWarmupLastTickAt(now);

    const schedules = await getWarmupSchedules();
    const due = findDueWarmupRunsInRange(schedules, from, now);
    let results = [];
    if (due.length) results = await runWarmupItems(due);

    g.lastTickAt = now.toISOString();
    g.lastResult = { triggered: due.length > 0, dueCount: due.length, resultsCount: results.length };
    return { triggered: due.length > 0, results };
  } finally {
    g.running = false;
  }
}

export function getWarmupSchedulerStatus() {
  return {
    running: g.running,
    started: !!g.interval,
    lastTickAt: g.lastTickAt,
    lastResult: g.lastResult,
    intervalMs: CHECK_INTERVAL_MS,
  };
}
```

`src/app/api/warmup/run/route.js` addition:

```js
import { getWarmupSchedulerStatus } from "@/lib/warmup/scheduler";

export async function POST(request) {
  if (getWarmupSchedulerStatus().running) {
    return NextResponse.json({ error: "scheduler tick in progress" }, { status: 409 });
  }
  // ... existing logic
}
```

`src/lib/warmup/runner.js` change (already prepared by Phase 1):

```js
return appendWarmupRun({
  // ...
  actualRanAt: new Date().toISOString(),
  status: "success" | "failure",
});
```

`src/lib/warmup/schedule.js` doc comment (top of file):

```js
// scheduledForUtc semantics:
//   For real-time ticks: equals the cursor instant passed in.
//   For catch-up via findDueWarmupRunsInRange: equals the slot boundary (HH:00 UTC).
//   It is a SLOT IDENTIFIER, not a wall-clock execution timestamp. The runner
//   records the actual execution wall-clock as `actualRanAt`.
```

## Related Code Files

- Modify: `src/lib/warmup/scheduler.js` — full rewrite per sketch.
- Modify: `src/app/api/warmup/run/route.js` — add 409 gate.
- Modify: `src/lib/warmup/runner.js` — set `actualRanAt`.
- Modify: `src/lib/warmup/schedule.js` — doc comment.
- Modify: tests — add scheduler integration tests.

## Implementation Steps

1. Write failing scheduler tests in `tests/warmup-scheduler.test.mjs` (uses isolated DB):
   - **Catch-up 3h:** seed `lastTickAt = now - 3h`, schedule with `HH:00` for the 3 hours covered → 3 due slots (per provider).
   - **Clamp at 6h:** seed `lastTickAt = now - 9h` → from clamped to `now - 6h`; 6 slots eligible; clamp log emitted once.
   - **Cold start:** no persisted → from = now → 0 slots (unless `now` is exactly `:00`).
   - **Persist BEFORE run:** stub `runWarmupItems` to throw; verify `lastTickAt` IS advanced (since persist-before).
   - **Status-aware dedupe:** insert a `failure` dedupe row for the same slot, second tick re-fires same slot.
   - **g.running guard prevents overlap:** trigger two `tickWarmupScheduler()` concurrently; second returns `skipped`.
   - **/api/warmup/run gate:** mock `g.running = true`, POST manual → 409.
2. Rewrite `scheduler.js` per sketch.
3. Add gate to manual route.
4. Set `actualRanAt` in runner.
5. Add doc comment in `schedule.js`.
6. Run all tests → green.

## Success Criteria

- [ ] All 7 scheduler tests pass.
- [ ] Manual run returns 409 when tick is in flight.
- [ ] `MAX_CATCHUP_HOURS` exported.
- [ ] Clamp log fires at most once per outage (not per tick).
- [ ] Persist-before-run + status-aware dedupe verified by tests.

## Risk Assessment

- Risk: blocking `await tickWarmupScheduler()` in `startWarmupScheduler` delays app boot. Mitigation: tick runs `await getWarmupSchedules()` + window scan + `runWarmupItems`. Cold-start `from===now` means `runWarmupItems` is empty most of the time. After a long outage, boot blocks up to N seconds per provider × 6h catch-up. **Validation Session 1 (V4): blocking accepted. No fallback timeout.** Operator already accepts "downtime catch-up" semantics.

<!-- Updated: Validation Session 1 — V2 confirmed MAX_CATCHUP_HOURS=6, V4 confirmed blocking-await -->
- Risk: `g.lastClampedFrom` is in-memory; restart resets it → log fires again on next-tick. Acceptable — one duplicate log line per restart is fine.
- Risk: ISO_RE regex too strict (rejects valid persisted strings if format changes). Mitigation: keep regex aligned with Phase 4's setter; both gates accept `Date.toISOString()` output only.
