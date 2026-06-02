---
phase: 6
title: "Regression sweep"
status: completed
priority: P2
effort: "2h"
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6: Regression sweep

## Overview

Run the full warmup + unit suites, confirm no regression in scheduler/catch-up/dedupe/notifier, verify the additive migration on an existing DB, and grep for the inverted status assumptions that the new `session_state` consumers depend on.

## Requirements

- Functional: all existing + new tests green; additive migration applies cleanly on a pre-existing DB; no consumer silently mis-handles `session_state`.
- Non-functional: no new lint/compile errors; warmup latency increase bounded to one usage GET (plus at most one re-poll on the `not-registered` path).

## Implementation Steps

1. `npm run test:warmup` → all `tests/warmup-*.test.mjs` pass (existing: schedule, scheduler, lasttickat, notifier, orphan-cascade, e2e-boot; new: session-columns, session-classifier, runner-session).
2. `npm test` (vitest) → unit suite green; reauth/key-budget/antigravity-cache tests unaffected.
3. Migration check on a NON-fresh DB (from Phase 1): `runMigrationOnce` adds `resets_at`/`utilization`/`session_state`; existing rows intact.
4. **Status/session_state grep — Finding 13.** The UI uses the INVERTED form, so a grep for `status === "success"` misses it. Grep across `src/app/**/warmup/**`, `src/shared/components/**`, `src/lib/warmup/**`, and usage/stats aggregators for ALL of: `=== "failure"`, `!== "failure"`, `failed`, `status ===`, `status !==`, and every `sessionState` consumer. Confirm: (a) `not-registered` never renders green; (b) no stats/aggregator buckets warmup runs by a binary status assumption that the new column breaks; (c) `src/shared/components/UsageStats.js` (`r.status === "success"`) does not ingest warmup rows, or handles them sanely.
5. Dedupe regression: a `success` warmup still locks its slot (`hasSuccessfulWarmupRunFromDb` true); confirm NO new status value was introduced (run `status` ∈ success/failure only) — grep `"unregistered"` returns nothing in `src/`.
6. Catch-up regression: a >5min outage with a session-provider schedule still produces a digest, and a `not-registered` item appears in the digest's labeled section (exercise digest mode, not per-event).
7. Confirmation-re-poll regression: first poll `not-registered` + second poll `active` → final `active`, no alert (Finding 7).
8. Gates: confirm G1/G2/G3 decisions from Phase 3 are recorded and the implementation matches them (Codex `resetAt` populated or Codex deferred; served-account handled; re-poll delay set).
9. Lint/build: project lint + a `next build`-level compile check on changed files.
10. Docs: note the new `warmup_runs` columns + `session_state` semantics in `./docs` (codebase-summary / system-architecture) and the new `WARMUP_NOTIFY_NOT_REGISTERED_*` env + not-registered alert behavior.

## Success Criteria

- [ ] `npm run test:warmup` green.
- [ ] `npm test` green.
- [ ] Additive migration verified on a pre-existing DB; no row loss.
- [ ] Grep confirms no consumer renders/buckets `not-registered` as green/success (Finding 13); no `"unregistered"` status anywhere.
- [ ] Catch-up digest includes the not-registered section.
- [ ] Confirmation re-poll suppresses transient false `not-registered`.
- [ ] G1/G2/G3 satisfied or explicitly deferred.
- [ ] No new lint/compile errors; docs updated.

## Risk Assessment

- Hidden binary-status consumer outside the grep scope. Mitigation: grep the inverted forms (Finding 13), not just `=== "success"`.
- Flaky timing if a test uses wall-clock. Classifier uses only a past/future check; audit new tests for stray reliance on real time in the re-poll path (inject the delay/clock where possible).

## Next Steps

`/ck:journal` to record decisions; ship via the normal git flow.
