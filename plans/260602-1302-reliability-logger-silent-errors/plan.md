---
title: "Reliability: server logger migration + silent-error triage"
description: "Stop regressions via observability: migrate server-side console.log hotspots to the env-gated logger, fix the no-op warn(), and triage silent empty-catch blocks. Additive (logging only), low risk. God-files/CI/test-fixes OUT of scope."
status: pending
priority: P2
branch: "feat/implement-sercurity"
tags: [reliability, logging, observability, refactor, debt]
blockedBy: []
blocks: []
created: "2026-06-02T06:20:45.412Z"
createdBy: "ck:plan"
source: skill
---

# Reliability: server logger migration + silent-error triage

## Overview

Lens: **reliability / stop regressions**. Two additive, low-risk workstreams
make the server debuggable: route server `console.log` hotspots through the
env-gated logger (so prod honors `LOG_LEVEL`), repair the no-op `logger.warn()`,
and triage the 167 empty `catch {}` blocks so real failures stop being silent.

**No logic rewrites.** Every change is logging or a 1-line classification
comment. God-file refactor, CI test gate, and the 26 pre-existing test failures
are explicitly OUT of scope (see brainstorm doc).

Source design: [brainstorm-260602-1302-reliability-logger-silent-errors.md](../reports/brainstorm-260602-1302-reliability-logger-silent-errors.md)

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Server logger migration + warn() fix](./phase-01-server-logger-migration-warn-fix.md) | Pending |
| 2 | [Silent-error triage](./phase-02-silent-error-triage.md) | Pending |
| 3 | [Verify](./phase-03-verify.md) | Pending |

## Key Decisions

- **Server hotspots only.** Client dashboard-page `console.log` (browser
  devtools audience) is the wrong target for the SSE stdout logger → separate
  follow-up, not this round.
- **`logger.warn()` fix is a prerequisite** (Phase 1): its `console.warn` is
  commented out (`logger.js:43`) → any migrated warning would vanish. Resolves
  the deferral from the first-60s perf plan.
- **Triage, don't blanket-fill.** Classify each empty catch as intentional
  best-effort (→ `logger.debug` or `/* intentional */` comment) vs hides-real-
  failure (→ `logger.error` + handling).
- **Preserve raw `[RTK] saved …` line** (`open-sse/handlers/chatCore.js:119`) —
  warmup e2e parses it; never route through logger.
- **No `logger.error` in hot loops** (spam) → use `debug`.

## Success Criteria (plan-level)

- [ ] `logger.warn()` emits (no longer no-op); verified.
- [ ] Server hotspot files (~70 `console.log`) routed through logger; prod hides
      debug, shows info/warn/error; `LOG_LEVEL=DEBUG` restores verbosity.
- [ ] Empty-catch blocks in hotspot files each log (debug/error) or carry an
      explicit intentional comment.
- [ ] Build green; warmup 70/70 pass; no new vitest failures beyond the known 26.
- [ ] `[RTK] saved` line unchanged.

## Dependencies

- No blocking cross-plan deps. Touches `src/sse/utils/logger.js` (also touched by
  the **completed** first-60s perf plan — no conflict; this adds the warn() fix
  that plan deferred). Out-of-scope from in-flight bot-protection / cache / MCP plans.

## Validation Log

### Verification Results (Session 1)
- Tier: Standard (3 phases). Fact Checker + Contract Verifier.
- **Verified | Failed: 0 | Unverified: 0** (1 scope correction below).
- Evidence:
  - `logger.js:43` `console.warn` commented out → `warn()` no-op (confirmed).
  - 6 server targets carry no `"use client"` (confirmed server-side).
  - console.log counts per file confirmed via grep.
  - `[RTK] saved` raw line at `chatCore.js:119` (unchanged target — preserve).
  - Empty-catch hotspot counts confirmed (media-providers 14, initializeApp 7,
    chatCore 6, mitm 4+4, DB adapters/repos).
  - **Scope correction:** `src/lib/oauth/utils/ui.js` imports `chalk` + `ora` —
    its `console.log` is intentional user-facing CLI output, NOT logger-eligible.

### Decisions (Session 1)
1. **Exclude `oauth/utils/ui.js`** from logger migration (chalk/ora CLI UX).
   Phase-1 targets: 7 → 6 files (~62 calls). → phase-01.
2. **Operational milestones → `logger.info`** (visible at prod INFO default) so
   CLI users keep startup/tunnel status; per-tick/watchdog → `debug`. → phase-01.

### Whole-Plan Consistency Sweep (Session 1)
- Swept plan.md + 3 phase files for the ui.js exclusion + milestone-level rule.
- Phase-03 verify steps remain consistent (prod hides debug, info shown, warn prints).
- No stale "7 files" / "ui.js" references remain in phase-01 targets/criteria.
- **Result: zero unresolved contradictions.** Plan eligible for implementation.
