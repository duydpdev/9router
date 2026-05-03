---
phase: 3
title: "Implement findDueWarmupRunsInRange (UTC :00 only, shared ceilToHour)"
status: pending
priority: P2
effort: "0.5h"
dependencies: [2]
---

# Phase 3: Implement findDueWarmupRunsInRange

## Overview

Make Phase 2 tests pass. Add pure `findDueWarmupRunsInRange(schedules, from, to)` that walks UTC `HH:00` boundaries between `from` and `to`. **No 30-min iteration** — `getLocalSlot` floors minutes already, so UTC `:00` covers half-hour TZs naturally (red-team Finding 1). Extract `ceilToHour` helper shared with `buildWarmupPreview` (Finding 13).

## Requirements

Functional:
- Exported `findDueWarmupRunsInRange(schedules, from, to)`.
- `from > to` → `[]`.
- Otherwise iterate from `ceilToHour(from)` while `cursor <= to`, stepping +1h.
- For each cursor, call `findDueWarmupRuns(schedules, cursor)` and concatenate.
- Sort result by `scheduledForUtc` ascending.
- `findDueWarmupRuns` continues to set `scheduledForUtc = cursor.toISOString()` — i.e. the slot boundary. Documented as the slot identifier, NOT execution wall-clock (red-team Finding 10). Phase 1 runner.js change adds `actualRanAt` separately.

Non-functional:
- Pure (no clock, no I/O).
- `ceilToHour` exported helper, replaces inline duplicate in `buildWarmupPreview` (`schedule.js:82-84`).
- `MAX_CATCHUP_HOURS` defined in `scheduler.js`, NOT here — pure fn agnostic of cap.

## Architecture

```js
// src/lib/warmup/schedule.js (additions)

export function ceilToHour(input) {
  const d = new Date(input);
  if (d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) return d;
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

export function findDueWarmupRunsInRange(schedules, from, to) {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (fromDate > toDate) return [];
  const results = [];
  for (let cursor = ceilToHour(fromDate); cursor <= toDate; cursor = new Date(cursor.getTime() + 3600 * 1000)) {
    results.push(...findDueWarmupRuns(schedules, cursor));
  }
  results.sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc));
  return results;
}
```

Refactor `buildWarmupPreview` to use `ceilToHour`:

```js
// Replace lines 82-84
const cursor = ceilToHour(now);
```

## Related Code Files

- Modify: `src/lib/warmup/schedule.js` — add `ceilToHour`, `findDueWarmupRunsInRange`; refactor `buildWarmupPreview`.

## Implementation Steps

1. Add `ceilToHour(input)` helper.
2. Replace inline ceil-to-hour in `buildWarmupPreview` with the new helper.
3. Add `findDueWarmupRunsInRange(schedules, from, to)`.
4. Run `node --test tests/warmup-schedule.test.mjs`. All 6 new Phase 2 tests pass; pre-existing tests still pass; preview-related tests (if any) unchanged.

## Success Criteria

- [ ] `findDueWarmupRunsInRange` and `ceilToHour` exported.
- [ ] All Phase 2 tests pass (including Kolkata + non-`:00` `from===to` empty case).
- [ ] `buildWarmupPreview` still produces correct output (verified via existing test).
- [ ] No 30-min iteration in code or tests.

## Risk Assessment

- Risk: edge case where `from = to = exact :00 instant` returning a slot that the caller also evaluated at real-time tick. Mitigation: dedupe is the responsibility of `hasWarmupRun` (Phase 1 status-aware) — pure fn intentionally returns the slot.
- Risk: refactoring `buildWarmupPreview` changes preview output by 1ms due to `new Date(d)` cloning semantics. Mitigation: write a snapshot test before refactor to lock current preview.
