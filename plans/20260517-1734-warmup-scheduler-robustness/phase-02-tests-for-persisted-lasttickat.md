---
phase: 2
title: Tests for findDueWarmupRunsInRange + isolated test DB infra
status: completed
priority: P2
effort: 1h
dependencies:
  - 1
---

# Phase 2: Tests for findDueWarmupRunsInRange + isolated test DB

## Overview

Establish test infra that isolates DB writes from user's real `~/.9router/db/data.sqlite` (red-team Finding 3). Then write failing tests for `findDueWarmupRunsInRange` covering hourly iteration, day boundaries, half-hour TZ (Kolkata), and the `from===to` contract clarification.

## Requirements

Test isolation:
- `tests/helpers/isolatedDb.mjs` exports `setupIsolatedDb()`:
  - Calls `fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-"))`.
  - Sets `process.env.DATA_DIR = <temp>` BEFORE any import that resolves DB paths.
  - Returns `{ dir, cleanup }`.
- Tests calling DB code import their target modules dynamically AFTER `setupIsolatedDb()` so `paths.js` reads the overridden env.
- Tests `before()` calls setup; `after()` removes temp dir.

`findDueWarmupRunsInRange` tests:
- Pure-fn, no DB. (Test isolation is only needed for Phase 4's `lastTickAt` tests, but the helper is built here for reuse.)
- 3-hour window with schedule `times: ["05:00","06:00","07:00"]`, `days: [tue]` → 3 × providerCount entries.
- `from > to` → `[]`.
- `from === to` and `from` is exactly `:00` → equivalent to `findDueWarmupRuns(schedules, from)`.
- `from === to` and `from` is non-`:00` (e.g. `12:23:45`) → `[]` (boundary algorithm yields no `:00` in `[12:23:45, 12:23:45]`).
- Day-boundary span (`21:00 → 04:00 UTC` next day) yields differing `localDate` across entries for `Asia/Ho_Chi_Minh`.
- **Kolkata test**: schedule `timezone: "Asia/Kolkata"`, `times: ["09:00"]`, scan UTC range covering `03:30 UTC` (which projects to local `09:00 IST`). Boundary at `04:00 UTC` projects to `09:30 IST` → `localTime` floored to `"09:00"` by `getLocalSlot` → matches. Confirm UTC `:00` iteration is sufficient for half-hour TZs (no 30-min step needed).

## Architecture

```js
// tests/helpers/isolatedDb.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function setupIsolatedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-"));
  process.env.DATA_DIR = dir;
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}
```

Test file pattern:

```js
import { test, before, after } from "node:test";
import { setupIsolatedDb } from "./helpers/isolatedDb.mjs";

let cleanup;
before(() => { ({ cleanup } = setupIsolatedDb()); });
after(() => cleanup && cleanup());

test("findDueWarmupRunsInRange matches Kolkata 09:00 schedule via UTC :00 iteration", async () => {
  const mod = await import("../src/lib/warmup/schedule.js");
  // ...
});
```

## Related Code Files

- Create: `tests/helpers/isolated-db.mjs`
- Modify: `tests/warmup-schedule.test.mjs` — add 6 new tests, all failing until Phase 3.

## Implementation Steps

1. Create `tests/helpers/isolated-db.mjs` with `setupIsolatedDb()`.
2. Add tests for `findDueWarmupRunsInRange`:
   - hourly multi-slot window
   - `from > to` empty
   - `from === to` at `:00` equivalence
   - `from === to` non-`:00` empty
   - day-boundary span (Asia/Ho_Chi_Minh)
   - Kolkata half-hour TZ coverage
3. Run `node --test tests/warmup-schedule.test.mjs` — new tests fail (export missing).

## Success Criteria

- [ ] Test helper exists and `process.env.DATA_DIR` is overridden before module import.
- [ ] 6 new tests added; all fail with clear error referencing missing export.
- [ ] Pre-existing 9 tests still listed.

## Risk Assessment

- Risk: another test in the suite imports DB modules before `setupIsolatedDb()` runs. Mitigation: dynamic `await import(...)` inside test bodies after `before()`.
- Risk: Kolkata test assertion depends on exact `getLocalSlot` minute-flooring behavior. Mitigation: assert on derived `localTime: "09:00"` AND on `scheduledForUtc === "...T04:00:00.000Z"` to lock in iteration contract.
