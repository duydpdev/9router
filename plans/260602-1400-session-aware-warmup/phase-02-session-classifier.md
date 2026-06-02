---
phase: 2
title: "Session classifier"
status: completed
priority: P1
effort: "2h"
dependencies: [1]
---

# Phase 2: Session classifier

## Overview

Pure function mapping a **normalized quota object** + a poll outcome → `{ sessionState, resetsAt, utilization }`. No I/O, no wall-clock inside. Post red-team this is much smaller: no `opened`/`already-active` split, no tolerance heuristic, no epoch normalization.

## Requirements

- Functional: `classifyWarmupSession({ provider, quota, usageOk, authoritative })` → `{ sessionState, resetsAt, utilization }`.
- Non-functional: deterministic, side-effect free, tolerant of partial/missing quota.

## Architecture

New module: `src/lib/warmup/session-state.js`.

```
const SESSION_PROVIDERS = new Set(["claude", "codex"]);

export function classifyWarmupSession({ provider, quota, usageOk, authoritative }) {
  if (!SESSION_PROVIDERS.has(provider)) return { sessionState: "n/a", resetsAt: null, utilization: null };
  if (!usageOk) return { sessionState: "unknown", resetsAt: null, utilization: null };

  const resetsAt = normalizeResetAt(quota?.resetAt);   // ISO string | null
  const utilization = normalizeUtil(quota?.used);      // 0-100 | null

  // Valid future reset → an active 5h window exists (whether this warmup opened
  // it or it was already open — both are healthy; we do not distinguish).
  if (resetsAt && Date.parse(resetsAt) > Date.now()) {
    return { sessionState: "active", resetsAt, utilization };
  }

  // No usable future reset. Only call it not-registered when the poll was an
  // AUTHORITATIVE response that genuinely lacks the session window. A non-
  // authoritative/ambiguous response (e.g. Claude legacy fallback returning
  // quotas without a session key) is `unknown`, not a false alarm. (Finding 11)
  return { sessionState: authoritative ? "not-registered" : "unknown", resetsAt: null, utilization };
}
```

Notes:
- `Date.now()` here is acceptable (no longer feeding a tolerance window — only a past/future check). If a test seam is wanted, pass `now` in; otherwise keep it simple.
- `normalizeResetAt(v)`: accept **ISO string or null only** and validate with one `Date.parse` finite check. The canonical fetcher already normalizes epochs via `parseResetTime` (`usage.js:524`) — do NOT reimplement epoch handling (Finding 14, DRY).
- `normalizeUtil(v)`: finite number clamped to `[0,100]`; negative or non-finite → `null`. `quota.used` is the % used on the **normalized** object (claude `createQuotaObject` sets `used = utilization` `usage.js:517`; codex `formatCodexWindow` sets `used` `usage.js:632`). Param is named `quota` (the normalized object), NOT the raw provider window (Finding 2/Assume). Document this in a comment.
- `authoritative` is supplied by Phase 3 (true only when the response is the OAuth/primary usage shape, not a legacy/ambiguous fallback).

## Related Code Files

- Create: `src/lib/warmup/session-state.js`.
- Create: `tests/warmup-session-classifier.test.mjs`.

## Implementation Steps

1. **(TEST FIRST)** `tests/warmup-session-classifier.test.mjs`:
   - non-session provider (`gemini`) → `n/a`.
   - `usageOk:false` → `unknown`.
   - valid future `resetAt` → `active` (utilization passed through).
   - **`used === 0` with valid future reset → `active`, NOT `not-registered`** (Finding 12 — the 0%-fresh-window case; `0` is a number and must survive).
   - `resetAt` null + `authoritative:true` → `not-registered`.
   - `resetAt` null + `authoritative:false` → `unknown` (Finding 11).
   - `resetAt` in the past → `not-registered` when authoritative, else `unknown`.
   - codex behaves identically to claude.
   - `normalizeUtil` clamping: `-5 → null`, `120 → 100`, `"42" → 42`, `NaN → null`.
   - `normalizeResetAt`: ISO passes; non-ISO/garbage → `null`; (NO epoch test — epoch handling removed).
   - Run → fails.
2. Implement `session-state.js` per architecture.
3. Add a usage-layer regression assert (can live here or Phase 6): `hasUtilization({utilization:0}) === true` (`usage.js:513`) so a future truthy-refactor that hides 0% windows fails loudly (Finding 12).
4. Run → passes.

## Success Criteria

- [ ] Pure function; only `active`/`not-registered`/`unknown`/`n/a` returned.
- [ ] 0%-window → `active` (guarded by test).
- [ ] Non-authoritative empty poll → `unknown`, never `not-registered`.
- [ ] No epoch code, no tolerance constants.
- [ ] File well under 200 lines.

## Risk Assessment

- `authoritative` mis-set by Phase 3 → either false `not-registered` (too eager) or missed detection (too lax). Mitigation: Phase 3 derives it from the concrete usage response shape; tested there.
- Removing the `opened`/`active` distinction loses no actionable signal (per plan Design #2 + red-team Finding 8).

## Next Steps

Phase 3 extracts the quota per provider, sets `authoritative`, and calls this.
