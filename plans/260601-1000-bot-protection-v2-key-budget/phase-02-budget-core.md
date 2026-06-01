---
phase: 2
title: "Budget Core"
status: completed
priority: P1
effort: "5h"
dependencies: [1]
---

# Phase 2: Budget Core

## Overview

Three pieces: (a) extract `keyHash` to a shared module, (b) a reader returning today's token+request totals for one API key from the **pre-aggregated `usageDaily` row** (O(1), no scan), (c) a pure budget evaluator. Heavily unit-tested. No notifier, no wiring yet.

## Requirements

- Functional: `getTodayUsageForKey(apiKey)` → `{ tokens, requests }` for the current local day. `evaluateBudget(usage, budget)` → `{ tier, pct }`, tier ∈ `null | "warn" | "over"`.
- Non-functional: reader is one PK lookup on `usageDaily(dateKey)` — NOT a `usageHistory` scan, NOT `SUM(tokens)` (that column is JSON TEXT → sums to 0; red-team Findings 1,2,4).

## Architecture

**Shared keyHash** (`src/lib/security/keyHash.js`) — move the body of `botGuard.js:17-19` here; `botGuard.js` and the budget modules both import it (red-team Finding 8). Keeps the masked-id derivation single-source (16-char sha256 slice).

**Reader** (`usageRepo.js`, `getTodayUsageForKey`):

```js
// usageDaily holds one JSON row per local day (dateKey = getLocalDateKey).
// byApiKey keys are `${apiKey}|${model}|${provider}`; sum entries matching this key.
export async function getTodayUsageForKey(apiKey) {
  const db = await getAdapter();
  const dateKey = getLocalDateKey();                 // local-day, matches write-side aggregation
  const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
  if (!row) return { tokens: 0, requests: 0 };
  const day = parseJson(row.data, {});
  let tokens = 0, requests = 0;
  for (const [k, v] of Object.entries(day.byApiKey || {})) {
    if (k.startsWith(apiKey + "|")) {                // entries are `${apiKey}|model|provider`
      tokens += (v.promptTokens || 0) + (v.completionTokens || 0);
      requests += v.requests || 0;
    }
  }
  return { tokens, requests };
}
```

No timestamp predicate (the day row is already local-day-scoped, sidestepping the UTC-ISO vs local-string bug, Finding 2). No new index (PK lookup on `dateKey`, Finding 4).

**Evaluator** (`src/lib/security/keyBudget.js`, pure):

```js
export function evaluateBudget({ tokens, requests }, { tokenPerDay, requestPerDay, warnAtPercent }) {
  const tokPct = tokenPerDay > 0 ? (tokens / tokenPerDay) * 100 : 0;
  const reqPct = requestPerDay > 0 ? (requests / requestPerDay) * 100 : 0;
  const pct = Math.max(tokPct, reqPct);              // token OR request — whichever crosses first
  if (pct >= 100) return { tier: "over", pct };
  if (pct >= warnAtPercent) return { tier: "warn", pct };
  return { tier: null, pct };
}
```

## Related Code Files

- Create: `src/lib/security/keyHash.js` (extracted)
- Modify: `src/lib/security/botGuard.js` (import `keyHash` from shared module; drop private copy)
- Modify: `src/lib/db/repos/usageRepo.js` (add `getTodayUsageForKey`)
- Create: `src/lib/security/keyBudget.js` (`evaluateBudget` + tier constants; `checkKeyBudget`/dedup added Phase 3)
- Create: `tests/unit/security-key-budget-eval.test.js`
- Create: `tests/unit/usage-today-for-key.test.js`

## Implementation Steps (TDD)

1. **Test first** — `security-key-budget-eval.test.js`: tier null below warn; "warn" at exactly `warnAtPercent`; "over" at ≥100%; token-only over (requests=0) trips; request-only over (tokens=0) trips; `tokenPerDay=0` → axis ignored (no div-by-zero). Run → red.
2. Implement `evaluateBudget`. Run → green.
3. Extract `keyHash.js`; update `botGuard.js` import; re-run existing security tests to confirm no regression.
4. **Test first** — `usage-today-for-key.test.js`: seed a `usageDaily` row whose `byApiKey` has multiple `${key}|model|provider` entries for keyA + entries for keyB; assert reader sums keyA's `promptTokens+completionTokens` and `requests` only, ignores keyB; missing row → `{0,0}`. Run → red.
5. Implement `getTodayUsageForKey`. Run → green.

## Success Criteria

- [ ] `evaluateBudget` tier logic correct incl. token-OR-request + zero-axis guard (test green)
- [ ] `getTodayUsageForKey` sums today-only, key-scoped, across multi-entry `byApiKey` (test green)
- [ ] `keyHash` shared; `botGuard` uses it; existing security tests still green
- [ ] No `SUM(tokens)`, no `usageHistory` scan, no new index

## Risk Assessment

- Risk: `byApiKey` key prefix collision (one key a prefix of another). Mitigation: match on `apiKey + "|"` delimiter, not bare `startsWith(apiKey)`.
- Risk: aggregation lag — `usageDaily` updated inside `saveRequestUsage` txn, so reader sees fully-committed totals (better-sqlite3 sync txn, `usageRepo.js:255`). No partial-row race in single process.
