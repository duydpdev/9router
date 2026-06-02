---
phase: 5
title: "Run history UI"
status: completed
priority: P2
effort: "3h"
dependencies: [3]
---

# Phase 5: Run history UI

## Overview

Surface the new per-run session data: exact 5h reset time, utilization (label explicitly "X% used" — stored value is % consumed, not remaining), a session badge, and a "resets in Xh Ym" countdown. The status dot and badge derive from `session_state` (NOT `status`) so a `not-registered` run is visibly amber, not green. Non-session/old rows → `—`.

## Requirements

- Functional: each run row + detail modal show `sessionState` badge, `resetsAt` (formatted in `run.timezone`), `utilization` %, and a countdown. `not-registered` is visually distinct (amber).
- Non-functional: presentation only; no new fetching; graceful nulls.

## Architecture

`src/app/(dashboard)/dashboard/warmup/components/RunHistoryPanel.js` (currently 157 lines):

- **Status dot — Finding 13.** Today: `const failed = run.status === "failure"` → `failed ? red : green` (`RunHistoryPanel.js:51,59`). A `not-registered` run has `status === "success"` → would render GREEN (misleading "all clear"). Fix: derive the dot from BOTH — `failure` → red, else `sessionState === 'not-registered'` → amber, else green. Drive the badge off `sessionState`.
- **Badge from `sessionState`:**
  - `active` → "session active" (green)
  - `not-registered` → "not registered" (amber)
  - `unknown` → "unknown" (muted)
  - `n/a` / null → no badge / `—`
- **Reset time:** format `run.resetsAt` in `run.timezone` (`Intl.DateTimeFormat` with `timeZone: run.timezone`, matching how `localDate`/`localTime` were derived). `—` when null.
- **Countdown:** `formatCountdown(resetsAt, now)` → single format "resets in 4h12m"; when reset is past/null, fall back to the existing `—` rendering (no separate "reset passed" string — Finding/Scope simplification). `now` captured on render; no per-second ticking.
- **Detail modal** (`selectedRun`): add a section with reset time, utilization (label explicitly "X% used" — stored value is % consumed, not remaining), session state, countdown.
- **Helpers inline.** Keep `formatCountdown`/`sessionBadgeMeta` in the component — at 157 lines the 200-line modularization trigger is not tripped. Only extract to `run-history-helpers.js` if the file actually crosses ~200 lines after the additions.

## Related Code Files

- Modify: `src/app/(dashboard)/dashboard/warmup/components/RunHistoryPanel.js`.
- Read: `src/app/(dashboard)/dashboard/warmup/WarmupPageClient.js` (run flow), `src/lib/warmup/store.js` `getWarmupRunsPage` (fields `resetsAt`/`utilization`/`sessionState`), `src/app/api/warmup/runs/route.js` (ensure it forwards the new fields).

## Implementation Steps

1. Confirm `getWarmupRunsPage` rows include the new camelCase fields (Phase 1 `rowToRun`) and `src/app/api/warmup/runs/route.js` forwards them unreshaped.
2. Add `sessionBadgeMeta(sessionState)` → `{ label, className }`.
3. Add `formatCountdown(resetsAt, now)` (single format).
4. Replace the binary `failed` dot with the 3-state derivation (status + sessionState).
5. Render badge + reset time + utilization in the row (respect `grid-cols-[auto_1fr_auto]`; keep compact).
6. Extend the detail modal with the session section.
7. Manual check: `active` row → green + reset + countdown; `not-registered` → amber "not registered"; old/`n/a` row → `—`; a `failure` row still red.

## Success Criteria

- [ ] Dot + badge derive from `session_state`; `not-registered` is amber, never green (Finding 13).
- [ ] Row shows reset time (run tz), utilization (label explicitly "X% used" — stored value is % consumed, not remaining), badge, countdown.
- [ ] Null/`n/a`/old rows render `—` without errors.
- [ ] Helpers inline unless file > 200 lines.
- [ ] No layout regression in list or modal.

## Risk Assessment

- Timezone formatting mismatch → format with stored `run.timezone`.
- Forgetting the API route forwards new fields → UI silently shows `—`. Mitigation: step 1 verifies the route.

## Security Considerations

None — display-only of non-sensitive fields.

## Next Steps

Phase 6 regression sweep.
