---
title: "First-60s perf + quick wins (adoption)"
description: "Make npx 9router's first 60s faster + pay down two trivial debts. Measurement-gated: heavy phases only fire if phase 1 proves the win exists."
status: completed
priority: P2
branch: "feat/implement-sercurity"
tags: [performance, refactor, adoption, bundle, cold-start]
blockedBy: []
blocks: []
created: "2026-06-02T05:17:43.644Z"
createdBy: "ck:plan"
source: skill
---

# First-60s perf + quick wins (adoption)

## Overview

Lens: **grow adoption**. 9Router trends → high first-run volume → a fast,
clean first 60 seconds converts more of those runs. This plan targets the
first-run path (cold start + dashboard first paint) plus two unconditional
debt items.

**Honest framing (read before cooking):** scout already disproved the easy
assumptions — Monaco is *already* lazy (`translator/page.js:8`), `recharts` /
`@xyflow/react` are *already* route-split by Next App Router, and
`initializeApp` is fire-and-forget from `bootstrap.js`. So the bundle/cold-start
wins may be **small**. That is exactly why **Phase 1 measures first** and
**Phases 3 & 4 are conditional** — they only execute if Phase 1 produces a
quantified target. Do not optimize on faith.

Unconditional wins (Phase 2) ship regardless: delete confirmed dead 59KB file,
env-gate the logger (385 raw `console.log` currently always print at DEBUG).

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Measure baseline](./phase-01-measure-baseline.md) | ✅ Done — see [baseline.md](./baseline.md) |
| 2 | [Quick wins (dead code + logger)](./phase-02-quick-wins-dead-code-logger.md) | ✅ Done |
| 3 | [Bundle diet](./phase-03-bundle-diet.md) | ✅ Done — PROCEED (login −~40%) |
| 4 | [Cold-start lazy-init](./phase-04-cold-start-lazy-init.md) | ✅ Done — reorder skipped, dead-import fixed |
| 5 | [Verify](./phase-05-verify.md) | ✅ Done — see [reports/verify-260602-first60s.md](./reports/verify-260602-first60s.md) |

## Key Decisions

- **Measure-first.** No optimization phase proceeds without a Phase-1 number.
- **Gating rule:** if Phase 1 shows shared/initial JS chunk < ~300KB gz and
  server-ready < ~1.5s, Phase 3/4 reduce to "document, no change" — report and
  skip rather than churn working code (YAGNI).
- **Phase 2 is independent** of measurement — both items are confirmed.
- **No god-file splitting in this plan.** Stable + tested big files left alone.

## Success Criteria (plan-level)

- [ ] Quantified baseline doc exists (boot ms, shared chunk bytes, per-route bytes).
- [ ] Dead `page.new.js` deleted; build still green.
- [ ] Logger honors `LOG_LEVEL` env; prod default no longer DEBUG.
- [ ] Phase 3/4 either delivered a measured improvement OR documented "already optimal, skipped".
- [ ] Re-measure shows no regression; numbers recorded in verify report.

## Dependencies

- No cross-plan blockers. Touches files outside recent in-flight plans
  (bot-protection / cache / MCP). Logger change is repo-wide but additive.

## Validation Log

### Verification Results (Session 1)
- Tier: Full (5 phases). Claims checked: 12.
- **Verified: 12 | Failed: 0 | Unverified: 0**
- Evidence:
  - `page.new.js` dead — zero src imports, zero test imports → safe delete.
  - `logger.js:10` `LEVEL = LOG_LEVELS.DEBUG` hardcoded (confirmed).
  - Monaco already lazy: `translator/page.js:8` `dynamic(..., {ssr:false})`.
  - `recharts`→`usage/components/UsageChart.js`, `@xyflow/react`→`usage/components/ProviderTopology.js` (exist, route-scoped).
  - `bootstrap.js:11` `initializeApp().catch()` fire-and-forget (confirmed).
  - `instrumentation.js:11` imports missing `@/server-init` → per-boot caught error (no such file).
  - `startWarmupScheduler` exported (`src/lib/warmup/scheduler.js:36`).
  - `@next/bundle-analyzer` NOT in package.json (plan adds devDep — correct).
  - `[RTK] saved …` emitted via raw `console.log` (`open-sse/handlers/chatCore.js:119`), NOT logger → logger change is safe for RTK e2e.

### Decisions (Session 1)
1. **Prod log level = INFO** (not WARN). Keeps 32 hot-path `logger.info` lines
   (auth/tokenRefresh/chat/embeddings) visible for self-host debugging. DEBUG
   hidden in prod; `LOG_LEVEL` overrides. → phase-02.
2. **Phase 4 = cleanup-only unless P1 proves cost.** Dead `@/server-init`
   import fix ships always; `initializeApp` reorder only on measured blocking
   delay. No speculative boot-ordering churn. → phase-04.
3. **Add `@next/bundle-analyzer` as devDependency**, ANALYZE-gated, off by
   default. → phase-01 / phase-03.
4. **Cut skeleton/instant-shell** sub-item (YAGNI); revisit only if P1 shows
   first-paint is the bottleneck. → phase-03.

### Whole-Plan Consistency Sweep (Session 1)
- Swept plan.md + all 5 phase files for the WARN→INFO change, skeleton-shell
  cut, and Phase-4 reframing.
- `phase-05` log check "no DEBUG lines in prod" — consistent with INFO default (INFO hides only DEBUG). No edit needed.
- No stale `WARN`-default references remain. No contradictory skeleton-shell references remain.
- **Result: zero unresolved contradictions.** Plan eligible for implementation.
