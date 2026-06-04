---
phase: 5
title: Fallback skip needsReauth in getProviderCredentials
status: completed
priority: P1
effort: 2-3h
dependencies:
  - 1
---

# Phase 5: Combo fallback skip needsReauth connections

## Overview

Teach `getProviderCredentials` (`src/sse/services/auth.js`) to treat a connection with `needsReauth=true` as unavailable, in the same lane as model-locked connections (already supported via `isModelLockActive`). This prevents combo round-robin from picking a connection that is guaranteed to fail and lets the next account in the fallback chain serve the request.

## Requirements

- Functional
  - When `getProviderCredentials` scans `isActive=true` connections, also filter out rows where `needsReauth === true`.
  - When ALL connections for a provider are `needsReauth`, return the same `allRateLimited`-style shape so callers emit a clear error (and Phase 6 UI can show "all accounts need reauth").
  - Treat `needsReauth` independently of `excludeConnectionIds` (the retry-fallback set built during the request) — the two filters compose.
- Non-functional
  - No DB schema change.
  - Filtering happens BEFORE `checkAndRefreshToken` is called, so we don't burn a refresh attempt on a known-dead connection.

## Architecture

```
auth.js::getProviderCredentials(provider, excludeSet, model)
   1. select active=1 connections for provider
   2. filter: NOT excludeSet
   3. filter: NOT isModelLockActive(c, model)
   4. NEW filter: NOT needsReauth                ← Phase 5
   5. score / round-robin / fill-first selection
   6. return merged credentials (with _connection)
```

Edge case: a connection that is `needsReauth=true` is still listed in the UI under "Connected (needs reauth)" — `isActive` stays true so the user can click Reconnect. Phase 6 owns the visual treatment.

## Related Code Files

- Modify: `src/sse/services/auth.js` — `getProviderCredentials`, around line 64–78
- Modify: `src/sse/services/auth.js` — the "all rate-limited" return path, add a sibling `allNeedReauth` flag
- Create: `tests/sse/services/auth-skip-needsreauth.test.js`

## TDD — failing tests first

`auth-skip-needsreauth.test.js`:
1. Two connections for provider X — one `needsReauth=true`, one healthy. `getProviderCredentials` returns the healthy one's `connectionId`.
2. Single connection, `needsReauth=true`. `getProviderCredentials` returns `{ allRateLimited: false, allNeedReauth: true, ... }` (or equivalent sentinel) without throwing.
3. Connection healthy but its model is locked → still selected when no other; matches existing behavior. (Pin existing behavior — no regression.)
4. Connection has `needsReauth=true` AND model-lock active → skipped (compound).
5. `excludeConnectionIds.has(needsReauthId)` → already skipped by exclude path; new filter doesn't double-fault.
6. After `clearNeedsReauth` runs on that row (mid-test), next call selects it normally.

Run all → red.

## Implementation Steps

1. **Write failing tests** (1–6). Confirm red.
2. Patch `auth.js`:
   ```js
   const candidates = (await getActiveConnections(provider))
     .filter(c => !excludeSet.has(c.id))
     .filter(c => !isModelLockActive(c, model))
     .filter(c => !c.needsReauth);             // NEW

   if (!candidates.length) {
     // distinguish "all locked" vs "all need reauth" for caller messaging
     const allRows = await getActiveConnections(provider);
     const filteredOutNeedReauth = allRows.every(c => c.needsReauth);
     if (filteredOutNeedReauth) {
       return { allNeedReauth: true, /* same shape pieces as allRateLimited */ };
     }
     // existing allRateLimited path
   }
   ```
3. Update upstream callers (the 7 SSE handlers) to recognize `allNeedReauth` and surface a distinct error message. Pattern:
   ```js
   if (credentials?.allNeedReauth) {
     return errorResponse(
       HTTP_STATUS.SERVICE_UNAVAILABLE,
       `[${provider}/${model}] All connections need reauth — reconnect via dashboard.`,
     );
   }
   ```
   Keep this near each `allRateLimited` branch — already present in all 7 handlers per scout report.
4. Run tests — green.
5. Manual smoke: mark one connection `needsReauth=true` via DB (or by re-running Phase 4 trigger), confirm combo fallback skips it; mark ALL → confirm SERVICE_UNAVAILABLE with the new wording.

## Success Criteria

- [ ] All 6 tests pass.
- [ ] Combo fallback proven to skip `needsReauth=true` connections in a live request.
- [ ] When all connections are `needsReauth`, response message clearly directs user to reconnect (not generic "rate limited").
- [ ] No regression for connections with only model-lock active.

## Risk Assessment

| Risk | Mitigation |
| ---- | ---------- |
| User has only one connection per provider and it dies → no fallback → request fails | This is correct behavior — they MUST reconnect. Notifier+deep-link makes that 1 click. |
| Two failure flags (`allRateLimited`, `allNeedReauth`) confuse downstream code | Keep them separate, document each, branch independently in handlers. |
| Connection toggles between `needsReauth=true` and `false` rapidly | Acceptable — every request re-reads the row. SQLite WAL is consistent. |

## Next Steps

Phase 6 surfaces the `needsReauth` state in the UI and wires the deep-link query handler.

## Red Team Adjustments — 2026-05-24

Finding **F12** accepted (HIGH).

### F12 — Non-existent `getActiveConnections` + `.every` empty-array bug + double-read race

Plan code (lines 63-77) calls `getActiveConnections(provider)` — that function does **not exist**. Actual API at `src/sse/services/auth.js:55`: `getProviderConnections({ provider, isActive: true })`. Also: re-querying inside the `if (!candidates.length)` branch is wasted I/O AND introduces a race with concurrent `markNeedsReauth` writes. And `.every()` on empty arrays returns `true` → falsely classifies "no connections at all" as `allNeedReauth`.

**Rewrite the snippet:**

```js
// inside getProviderCredentials, replacing original lines 64-78
const allConnections = await getProviderConnections({ provider, isActive: true });

const candidates = allConnections
  .filter(c => !excludeSet.has(c.id))
  .filter(c => !isModelLockActive(c, model))
  .filter(c => !c.needsReauth);                       // NEW

if (!candidates.length) {
  // Use the SAME list — no second DB read
  const eligibleByExclude = allConnections.filter(c => !excludeSet.has(c.id));
  const allEligibleNeedReauth =
    eligibleByExclude.length > 0 && eligibleByExclude.every(c => c.needsReauth);
  if (allEligibleNeedReauth) {
    return { allNeedReauth: true, /* mirror allRateLimited shape */ };
  }
  // existing allRateLimited / null path
}
```

**Precedence (document in Risk Assessment):** `needsReauth` > `model-locked` > `excluded`. When `excludeSet` is non-empty (mid-fallback retry), do NOT classify based on a subset — `eligibleByExclude.length > 0` guard prevents empty-array false-positive.

**Add tests:**
- #7 — empty `allConnections` → returns existing "no credentials" shape, NOT `allNeedReauth`.
- #8 — 3 connections, 2 in `excludeSet`, 1 healthy → returns the healthy one.
- #9 — 3 connections, 2 in `excludeSet`, 1 `needsReauth` → returns `allNeedReauth: true` only if the eligible-by-exclude set is fully needsReauth.

Phase 5 **does not** check non-existent `getActiveConnections`; verify with `grep -n "getActiveConnections" src/sse/` before coding (should yield zero results).
