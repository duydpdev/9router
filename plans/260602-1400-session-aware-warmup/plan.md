---
title: "Session-Aware Warmup (5h Window Tracking)"
description: "Enrich warmup runs with Claude/Codex 5h-session reset time + utilization; detect and flag warmups that returned 200 but did not open an active session window. Revised post red-team."
status: completed
priority: P2
branch: "feat/implement-sercurity"
tags: [warmup, session, claude, codex]
blockedBy: []
blocks: []
created: "2026-06-02T07:00:37.269Z"
createdBy: "ck:plan"
source: skill
---

# Session-Aware Warmup (5h Window Tracking)

## Overview

Today a warmup run records `status='success'` on any HTTP 200. That proves the request returned — NOT that the targeted account's 5h session window actually opened. Claude's 5h window is rolling and starts at the first message's exact minute (09:47 → resets 14:47), shared across all surfaces; the authoritative reset is `five_hour.resets_at` from the OAuth usage endpoint that 9router already calls (`open-sse/services/usage.js`). Codex exposes an equivalent session window.

This plan polls that usage endpoint after a Claude/Codex warmup, captures `resets_at` + `utilization`, classifies the session as `active` / `not-registered` / `unknown` (`n/a` for non-session providers), persists it on the run row, surfaces it in the UI, and alerts when a 200 warmup did NOT register a window (prime cause: router fallback diverting the pinned account).

**Scope:** Claude + Codex. Other providers → `n/a`, unchanged.
**Approach:** single post-warmup usage poll (Approach A), design approved 2026-06-02.

## Design (post red-team — authoritative)

These decisions supersede any conflicting prose in earlier phase drafts:

1. **No new run `status`.** Run `status` stays `success`/`failure` exactly as today. The session signal lives entirely in the new `session_state` column. The earlier "`unregistered` status keeps the dedupe slot re-runnable" idea is **dropped** — the scheduler only fires a slot on its exact minute and never revisits it the same day, so an "open slot" bought nothing. Notify/UI/digest all branch on `session_state`, never on a new status value. Dedupe is written normally (a 200 warmup → `success` dedupe row).
2. **`session_state ∈ {active, not-registered, unknown, n/a}`.** The `opened` vs `already-active` split is **cut** — the plan's own analysis admitted both are "healthy session active" and nothing downstream acts on the difference; the ±2min tolerance heuristic that distinguished them was structurally unsound (rolling minute-anchor vs local wall-clock). One `active` state, no tolerance math, no clock-skew dependency.
3. **The usage poll must refresh the token + resolve the proxy + check the served account.** `getUsageForProvider` is an out-of-band call; the canonical usage route refreshes OAuth creds and resolves proxy first (`route.js:128-148`). The poll reuses that path via a shared helper. It also only classifies `not-registered` when the account that *served* the warmup equals the pinned account — otherwise a router fallback is a known divert, not a mystery.
4. **`not-registered` requires a confirmation re-poll.** The usage endpoint is not guaranteed to reflect the just-sent warmup instantly. A single bounded re-poll (after a short delay) before committing `not-registered` prevents transient-consistency false alarms and the alert churn they cause.
5. **`not_registered` notifications get their own rate-limit budget** (mirroring the recovery budget), so a burst of mis-warms cannot crowd out real failure pages.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Schema and store columns](./phase-01-schema-and-store-columns.md) | Done |
| 2 | [Session classifier](./phase-02-session-classifier.md) | Done |
| 3 | [Runner usage poll](./phase-03-runner-usage-poll.md) | Done |
| 4 | [Not-registered notifier](./phase-04-not-registered-notifier.md) | Done |
| 5 | [Run history UI](./phase-05-run-history-ui.md) | Done |
| 6 | [Regression sweep](./phase-06-regression-sweep.md) | Done |

## Empirical verification gates (resolve in Phase 3 before relying on output)

- **G1 — Codex window shape:** capture one live Codex `/usage` `primary_window`. If it carries `resets_in_seconds` (a duration) and no absolute `reset_at`, `formatCodexWindow` (`usage.js:637`) currently yields `resetAt: null` → every Codex warmup would falsely classify `not-registered`. Fix in the usage layer (derive `resetAt = now + resets_in_seconds`). If shape unconfirmable, fall back to Claude-only and defer Codex.
- **G2 — served-account exposure:** confirm `handleInternalWarmupChat`/the SSE pipeline can surface which connection actually served the request after fallback. Required for decision #3. If unavailable, `not-registered` is unreliable on fallback — surface to user.
- **G3 — usage-endpoint propagation lag:** measure on the prod VPS to size the decision-#4 re-poll delay.

## Key Dependencies

- Usage fetcher: `open-sse/services/usage.js` → `getUsageForProvider(connection, proxyOptions)` (proxy-aware, canonical). Claude → `quotas["session (5h)"]`, Codex → `quotas["session"]`; both expose the **normalized** quota object `{used, remaining, resetAt}` (NOT the raw provider window).
- Auth/proxy: `src/app/api/usage/[connectionId]/route.js:128-163` (proxy resolve → refresh → retry) — extract into a shared `fetchUsageForConnection` helper.
- Additive schema sync: `src/lib/db/migrate.js` → `syncSchemaFromTables` auto-adds nullable columns declared in `TABLES`. No hand-written migration file.
- TDD: each phase writes failing tests first (node:test `tests/warmup-*.test.mjs` + `tests/helpers/isolated-db.mjs`), then implementation.

## Out of Scope (this round)

- Auto-retry / hard-pin warmup that disables router fallback (flag+notify only here).
- Before+after dual poll (Approach B). Decision #4's single confirmation re-poll is NOT Approach B — it re-checks only when the first poll says `not-registered`.
- Reworking the duplicate `src/lib/usage/fetcher.js` (use the `open-sse` canonical one).

## Dependencies

Builds on completed plans `20260517-1734-warmup-scheduler-robustness` and `20260519-1200-warmup-failure-notifications` (both `status: completed`). No active-plan blockers.

## Red Team Review

### Session — 2026-06-02
**Findings:** 15 (15 accepted, 0 rejected)
**Severity breakdown:** 3 Critical, 6 High, 6 Medium
**Reviewers:** Security Adversary, Failure Mode Analyst, Assumption Destroyer, Scope & Complexity Critic

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Codex window lacks absolute resetAt → all Codex warmups false `not-registered` | Critical | Accept | P3 (G1), usage layer |
| 2 | probeSession stale token + no proxy resolution | Critical | Accept | P3 |
| 3 | probeSession polls pinned acct; fallback serves another → false `not-registered` | Critical | Accept | P3 (G2) |
| 4 | "`unregistered` keeps slot re-runnable" false → drop new status, drive off session_state | High | Accept | plan, P1, P3 |
| 5 | not-registered notify doesn't fit success/recovery branch; recordSuccess clears counter | High | Accept | P3 |
| 6 | Digest collects only status==='failure' → not-registered dropped in catch-up | High | Accept | P3, P4 |
| 7 | Usage eventual-consistency → false not-registered + alert churn | High | Accept | P2, P3 |
| 8 | opened/already-active non-actionable + ±2min tolerance unsound → collapse to `active` | High | Accept | P1, P2, P5 |
| 9 | not_registered shares failure rate-limit budget → crowds out outage pages | High | Accept | P4 |
| 10 | Positional INSERT fragility + appendWarmupRun drops unknown keys | Medium | Accept | P1 |
| 11 | usageOk legacy-fallback quotas-without-session-key → false not-registered | Medium | Accept | P2, P3 |
| 12 | 0% fresh window relies on typeof==='number'; untested | Medium | Accept | P2 |
| 13 | UI dot reads status not session_state → not-registered shows green | Medium | Accept | P5, P6 |
| 14 | normalizeResetAt epoch handling dead code (parseResetTime already normalizes) | Medium | Accept | P2 |
| 15 | Notifier: kindMeta map + sanitize name fields + decide single digest shape | Medium | Accept | P4 |

### Whole-Plan Consistency Sweep
Applied edits remove the `unregistered` status and `opened`/`already-active` states everywhere (plan + phases 1-5), retarget notify/UI/digest onto `session_state`, and add G1-G3 gates. Phase 6 grep targets updated to the inverted `=== "failure"` / `failed` forms and to `session_state` consumers. No residual references to the dropped status/states remain in the phase files after this rewrite.

## Validation Log

### Session — 2026-06-02
Verification pass skipped per guard (Red Team Review above already carries `file:line` evidence; no `[UNVERIFIED]` tags remain). 4 decision questions asked; all confirmed the recommended option.

| # | Decision point | Resolution | Applied To |
|---|----------------|------------|------------|
| 1 | G1 — Codex window has no absolute reset | Derive `resetAt = now + resets_in_seconds` in `formatCodexWindow` (usage layer), tested vs a live response | P3 (G1), `usage.js` |
| 2 | G2 — served-account unobtainable | Downgrade session-provider warmups to `unknown` (never `not-registered`); surface limitation | P3 step 2 |
| 3 | Confirmation re-poll delay | Keep re-poll; **default 5s**, named injectable constant (tests don't sleep) | P3 step 7 |
| 4 | Utilization display semantics | Show **"X% used"** (stored value = % consumed); no inversion | P5 |

### Whole-Plan Consistency Sweep
Propagated decisions: P3 re-poll pinned to 5s + injectable; P3 G2 fallback made explicit (unknown, not not-registered); P5 utilization labeled "% used". No contradictions introduced — `session_state` enum, no-new-status, and the G1-G3 gates remain consistent across plan.md and all phase files. Plan is internally consistent and ready for implementation (subject to resolving G1-G3 with live data inside Phase 3).
