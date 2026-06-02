---
phase: 1
title: "Schema and store columns"
status: completed
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Schema and store columns

## Overview

Add three nullable columns to `warmup_runs` and thread them through the store/repo read+write path. Additive only. No hand-written migration: `syncSchemaFromTables` auto-adds columns declared in `TABLES`. **No change to run `status`** — it stays `success`/`failure` (see plan Design #1).

## Requirements

- Functional: `warmup_runs` gains `resets_at TEXT`, `utilization REAL`, `session_state TEXT`. `insertWarmupRun` persists them; `rowToRun` maps them back (camelCase `resetsAt`, `utilization`, `sessionState`); `appendWarmupRun` builds them onto `nextRun`, defaulting `null`/`null`/`"n/a"`.
- Non-functional: backward compatible — old rows read back `null`; dedupe semantics unchanged; no new run status value.

## Architecture

`session_state` enum: `active` | `not-registered` | `unknown` | `n/a`. (`n/a` = non-session provider; `null` = pre-migration row.)

Column home: `src/lib/db/schema.js` `TABLES.warmup_runs.columns`. Boot-time `syncSchemaFromTables` (`migrate.js`) diffs `PRAGMA table_info` and `ALTER TABLE ... ADD COLUMN` for missing declared columns — declaring them IS the migration.

**Finding 10 — positional-INSERT hazard.** `insertWarmupRun` (`warmupRepo.js:27-43`) is a single positional 12-column `INSERT ... VALUES(?,?,…×12)` with a parallel bindings array. Adding 3 columns means editing the column list, the placeholder count, AND the bindings array in lockstep — a misaligned binding silently writes the wrong column. Separately, `appendWarmupRun` (`store.js:90-104`) constructs `nextRun` **field-by-field with no `...run` spread** — any field not explicitly added is silently dropped before reaching the repo. Both are silent-data-loss traps, not compile errors.

## Related Code Files

- Modify: `src/lib/db/schema.js` — add 3 columns to `warmup_runs.columns`.
- Modify: `src/lib/db/repos/warmupRepo.js` — `insertWarmupRun` (column list + placeholders + bindings), `rowToRun` (3 mappings). Leave `warmup_dedupe` untouched.
- Modify: `src/lib/warmup/store.js` — `appendWarmupRun` `nextRun` gains 3 fields.
- Create: `tests/warmup-session-columns.test.mjs`.

## Implementation Steps

1. **(TEST FIRST)** `tests/warmup-session-columns.test.mjs` with `setupIsolatedDb()`:
   - Insert via `appendWarmupRun` with **distinct sentinel values** (`resetsAt:"2026-06-02T14:47:00.000Z"`, `utilization:42`, `sessionState:"active"`) → read via `getWarmupRunsPageFromDb` → assert each field round-trips to the RIGHT field (catches a binding swap, since values differ).
   - Insert WITHOUT the new fields → assert `sessionState==="n/a"`, `resetsAt===null`, `utilization===null`.
   - Migration-on-existing-DB: seed an isolated DB whose `warmup_runs` lacks the columns, run `runMigrationOnce`, assert `PRAGMA table_info` now lists all three and pre-existing rows survive.
   - Assert `hasSuccessfulWarmupRunFromDb` still keys only on `status='success'` (dedupe unaffected).
   - Run → fails.
2. `schema.js`: add `resets_at: "TEXT"`, `utilization: "REAL"`, `session_state: "TEXT"`.
3. `insertWarmupRun`: append the 3 columns at the END of both the column list and the bindings array, in identical order; bind `run.resetsAt ?? null`, `run.utilization ?? null`, `run.sessionState ?? "n/a"`. Count placeholders to match.
4. `rowToRun`: add `resetsAt: r.resets_at`, `utilization: r.utilization`, `sessionState: r.session_state`.
5. `appendWarmupRun`: add the 3 fields to `nextRun` (defaults as above).
6. Run → passes.

## Success Criteria

- [ ] All 4 edit sites done (schema, insert, rowToRun, appendWarmupRun) — checklist verified.
- [ ] Sentinel round-trip passes (distinct values prove no binding swap).
- [ ] Additive migration verified on a pre-existing DB; no row loss.
- [ ] Missing-field defaults `null`/`null`/`"n/a"`.
- [ ] `hasSuccessfulWarmupRunFromDb` + `warmup_dedupe` unchanged.

## Risk Assessment

- SQLite `ADD COLUMN` cannot add `NOT NULL` without default → all 3 nullable, safe.
- Positional binding drift (Finding 10) → sentinel test + END-append discipline.
- `appendWarmupRun` silent-drop (Finding 10) → explicit field add + round-trip test.
- Retention sweep (`SELECT *`) unaffected by new columns.

## Security Considerations

`utilization`/`resets_at` are non-sensitive usage metadata; no tokens stored.

## Next Steps

Phase 2 classifier produces these fields; Phase 3 runner populates them.
