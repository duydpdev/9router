---
phase: 3
title: "Bundle diet"
status: completed
priority: P2
effort: "3-5h (conditional)"
dependencies: [1]
---

# Phase 3: Bundle diet

## Overview
**Conditional phase.** Reduce the dashboard's shared/initial JS payload so first
paint is faster. Only execute the change steps if Phase 1's `baseline.md`
verdict says "proceed" — otherwise document "already optimal" and skip.

## Gating Precondition
Read `baseline.md` Phase-3 verdict first.
- **Skip** if: shared/initial chunk is small (< ~300KB gz) AND heavy libs
  (`recharts`, `@xyflow/react`, Monaco) are already confined to their routes.
  Scout strongly suggests this is the likely outcome — Monaco already lazy,
  charts/flow already route-split by App Router. Be ready to skip honestly.
- **Proceed** only on a concrete leak found in Phase 1.

## Requirements
- Functional: measured reduction in shared/initial chunk OR no-op with rationale.
- Non-functional: no route loses functionality; lazy chunks still render.

## Architecture
Candidate moves (apply ONLY those Phase 1 justifies):

1. **Heavy lib leaking into shared chunk** → wrap the consuming component in
   `next/dynamic` with `{ ssr: false }` + a lightweight skeleton fallback.
   - `recharts` consumer: `usage/components/UsageChart.js`
   - `@xyflow/react` consumer: `usage/components/ProviderTopology.js`
   - Pattern already proven in repo: `translator/page.js:8` (Monaco).
   - Only 1 file repo-wide uses `next/dynamic` today → real headroom IF a leak exists.

<!-- Updated: Validation Session 1 - skeleton-shell sub-item CUT (YAGNI). Only revisit if Phase-1 measures first-paint as the bottleneck. -->
Skeleton/instant-shell work is **out of scope** for this plan (validation
decision). Revisit in a follow-up only if Phase-1 proves first-paint — not
bundle size — is the bottleneck.

## Related Code Files
- Read: `baseline.md` (gate)
- Modify (conditional): `src/app/(dashboard)/dashboard/usage/components/UsageChart.js`,
  `.../usage/components/ProviderTopology.js`, and/or the pages importing them
- Reference pattern: `src/app/(dashboard)/dashboard/translator/page.js:8`

## Implementation Steps
1. Read Phase-1 verdict. If "skip" → write one paragraph in this file's
   completion note explaining why, mark phase done, STOP.
2. If "proceed": for each leaking heavy component, convert its import to
   `next/dynamic({ ssr:false })` with a skeleton fallback.
3. `ANALYZE=true npm run build` — confirm the targeted lib left the shared chunk.
4. Manual smoke: load `/usage`, confirm chart + topology still render after
   lazy load; load dashboard home, confirm no chart code in initial payload.
5. Record before/after shared-chunk bytes in `baseline.md`.

## Success Criteria
- [ ] Either: shared/initial chunk reduced by a recorded amount, lazy routes still render.
- [ ] Or: documented "no actionable leak — skipped" with the baseline numbers backing it.
- [ ] No route regressed (manual smoke on `/usage`, `/translator`, dashboard home).

## Risk Assessment
- Risk: over-eager lazy-loading adds layout shift / spinner flash on fast loads.
  Mitigation: skeleton fallbacks sized to content; only lazy genuinely-heavy libs.
- Risk: `ssr:false` on a component that needs SSR data. Mitigation: charts/flow
  are client-only viz — safe; verify no SSR dependency before converting.
