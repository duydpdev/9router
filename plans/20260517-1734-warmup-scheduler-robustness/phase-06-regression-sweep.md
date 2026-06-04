---
phase: 6
title: Regression sweep + manual smoke
status: completed
priority: P2
effort: 1h
dependencies:
  - 5
---

# Phase 6: Regression sweep + manual smoke

## Overview

Final verification across the warmup blast radius. Confirm all red-team fixes hold and existing surfaces remain functional.

## Requirements

- Full warmup test suite green.
- `npm run build` (Next.js compile/typecheck) passes.
- Manual smoke via `/dashboard/warmup`:
  - "Run now" still triggers a manual fire and appears in run history.
  - Preview list renders for next 7 days; Kolkata schedule (if added) preview includes hourly slots.
- DB upgrade smoke: existing user DB with legacy `kv:warmup/runs` JSON drains into `warmup_runs` / `warmup_dedupe` on first boot; second boot is a no-op.
- 409 behavior: while `g.running` is true (simulated), `POST /api/warmup/run` returns 409.

## Architecture

No code change in this phase. Verification only.

## Related Code Files

- Read for context: `src/app/api/warmup/*.js`, `src/app/(dashboard)/dashboard/warmup/WarmupPageClient.js`, `src/lib/warmup/*`, `src/lib/db/repos/warmupRepo.js`.

## Implementation Steps

1. **Test suite:** `node --test tests/warmup-schedule.test.mjs tests/warmup-lasttickat.test.mjs tests/warmup-scheduler.test.mjs`. Expect all green.
2. **Build:** `npm run build`. No new compile/lint errors.
3. **Legacy migration smoke:**
   - Copy a pre-upgrade `~/.9router/db/data.sqlite` to a test location with `DATA_DIR=...` set.
   - Pre-seed: `INSERT INTO kv VALUES('warmup','runs', '[{...}]')` with 3 legacy entries.
   - Boot app once. Verify `SELECT COUNT(*) FROM warmup_runs` = 3, `SELECT * FROM kv WHERE scope='warmup' AND key='runs'` empty, `SELECT value FROM _meta WHERE key='warmupRunsMigrated'` = '1'.
   - Boot again. Verify counts unchanged.
4. **Catch-up smoke:**
   - Stop server. Use `sqlite3` CLI to set:
     ```
     INSERT OR REPLACE INTO kv(scope, key, value) VALUES('warmup','lastTickAt','"<ISO now - 3h>"');
     ```
   - Start server. Within one tick (60s), `warmup_runs` should contain 3 new rows (one per hour) per provider×schedule combination. Verify `actualRanAt > scheduledForUtc` for each.
5. **Manual run smoke:**
   - Open `/dashboard/warmup`. Click "Run now". Entry appears in run history within seconds.
   - Programmatic: `curl -X POST http://localhost:3000/api/warmup/run` while scheduler tick is intentionally held (e.g. via long-running schedule provider) → 409.
6. **Status-aware dedupe smoke:**
   - Inject a failure: temporarily disable a provider connection mid-catch-up.
   - Verify a `failure` row appears in `warmup_runs`. Re-enable the provider. On the next tick, verify a new row appears for the same slot (status `success`) because failures don't permanently dedupe.
7. **Preview smoke:** Add an `Asia/Kolkata` schedule with `times: ["09:00"]`. Verify `/api/warmup/preview` returns the expected slots for the next 7 days.

## Success Criteria

- [ ] All test files green (3 files, ~20 tests total).
- [ ] `npm run build` succeeds.
- [ ] Legacy migration drains correctly; idempotent on re-boot.
- [ ] Catch-up after simulated downtime fires the missed slots once.
- [ ] Manual run returns 409 during tick.
- [ ] Status-aware dedupe verified: failed slot retries on next tick.
- [ ] Kolkata preview renders correctly.
- [ ] No new lint/typecheck errors.

## Risk Assessment

- Risk: 409 smoke is hard to reproduce without injecting a long sleep in `runWarmupItems`. Mitigation: write a debug-only middleware OR use a unit-test mock — accept that manual smoke may skip 409 and rely on the Phase 5 unit test.
- Risk: legacy migration fails on a malformed historical JSON entry (e.g. missing `dedupeKey`). Mitigation: Phase 1 spec uses `INSERT OR IGNORE`, dropping malformed rows silently. Acceptable for one-shot migration.
- Risk: catch-up smoke timing — interval is 60s; user must wait. Mitigation: temporarily lower `CHECK_INTERVAL_MS` for the smoke or trigger `tickWarmupScheduler()` via a debug endpoint.
