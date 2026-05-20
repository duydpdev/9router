---
phase: 1
title: "Foundation (schema + helpers)"
status: pending
priority: P1
effort: "3-4h"
dependencies: []
---

# Phase 1: Foundation — schema fields, reauthState helpers, test scaffolding

## Overview

Add `needsReauth`, `reauthAt`, `reauthReason`, `reauthNotifiedAt` to the provider-connection `data` JSON whitelist. Create `src/lib/oauth/reauth-state.js` exposing `markNeedsReauth`, `clearNeedsReauth`, `isNeedingReauth`. No callers wired yet — this phase only lays the foundation and the test harness.

## Requirements

- Functional
  - `OPTIONAL_FIELDS` in `connectionsRepo.js` must accept the 4 new fields.
  - `markNeedsReauth(connectionId, { reason, reauthAt? })` writes the fields atomically via existing `updateProviderConnection`.
  - `clearNeedsReauth(connectionId)` resets all 4 fields to `null`.
  - `isNeedingReauth(connection)` returns boolean from the raw connection row.
  - All helpers are pure-IO wrappers — no notifier, no side effects beyond DB.
- Non-functional
  - No DB migration needed (fields live inside existing JSON blob — backward-compatible).
  - Existing rows without these fields treat as `needsReauth=false`.
  - Helpers must be safely callable from concurrent request paths (rely on SQLite WAL + the existing single-row upsert).

## Architecture

```
src/lib/oauth/reauth-state.js  (NEW)
├── markNeedsReauth(connectionId, { reason, reauthAt? })
│       └── updateProviderConnection(connectionId, {
│              needsReauth: true,
│              reauthReason: reason,
│              reauthAt: reauthAt ?? new Date().toISOString(),
│           })
├── clearNeedsReauth(connectionId)
│       └── updateProviderConnection(connectionId, {
│              needsReauth: false,
│              reauthReason: null,
│              reauthAt: null,
│              reauthNotifiedAt: null,
│           })
├── markReauthNotified(connectionId, { reauthAt })
│       ├── compare-and-set: only write if current reauthAt matches caller's
│       │   reauthAt AND reauthNotifiedAt is null. Returns true on first writer.
│       └── used by Phase 3 notifier to dedup
└── isNeedingReauth(connection): boolean
```

`reauthReason` enum (string):
- `"invalid_grant"` — refresh-token rejected (standard OAuth 4xx)
- `"refresh_family_revoked"` — Codex / Google family-rotation (`refresh_token_reused`)
- `"refresh_http_error"` — network error during refresh persistent across retries
- `"refresh_unknown"` — fallback

## Related Code Files

- Modify: `src/lib/db/repos/connectionsRepo.js` — extend `OPTIONAL_FIELDS` whitelist (lines 5–11)
- Create: `src/lib/oauth/reauth-state.js`
- Create: `tests/oauth/reauth-state.test.js`
- Create (if missing): `tests/oauth/__fixtures__/connection.js` — minimal connection factory
- Touch: confirm `package.json` test runner; if test infra missing for this dir, add minimal `node --test` entry

## TDD — failing tests first

Write all of the following in `tests/oauth/reauth-state.test.js` BEFORE editing any production file:

1. `markNeedsReauth writes needsReauth=true, reauthReason, reauthAt` — assert DB row after call.
2. `markNeedsReauth defaults reauthAt to now() ISO when caller omits it`.
3. `markNeedsReauth on an unknown connectionId returns falsy without throwing`.
4. `clearNeedsReauth resets all 4 fields to null`.
5. `markReauthNotified returns true on first call and false on second call for the same (connectionId, reauthAt)`.
6. `markReauthNotified returns true again after a fresh markNeedsReauth that bumps reauthAt`.
7. `isNeedingReauth(conn)` returns false when field is undefined (legacy rows).
8. `isNeedingReauth(conn)` returns true when `needsReauth=true`.
9. `connectionsRepo round-trip` — write a connection with `needsReauth=true`, read it back, assert preserved.

Tests must use an isolated in-memory SQLite (existing test pattern if any; otherwise temp file via `DATA_DIR=$(mktemp -d)`).

## Implementation Steps

1. **Write failing tests** (Steps 1–9 above). Run; confirm red.
2. Extend `OPTIONAL_FIELDS` in `src/lib/db/repos/connectionsRepo.js`:
   ```js
   const OPTIONAL_FIELDS = [
     // existing ...
     "needsReauth", "reauthReason", "reauthAt", "reauthNotifiedAt",
   ];
   ```
3. Create `src/lib/oauth/reauth-state.js`:
   ```js
   import {
     updateProviderConnection,
     getProviderConnectionById,
   } from "../db/repos/connectionsRepo.js";

   export async function markNeedsReauth(connectionId, { reason, reauthAt } = {}) {
     if (!connectionId) return false;
     const at = reauthAt ?? new Date().toISOString();
     return !!(await updateProviderConnection(connectionId, {
       needsReauth: true,
       reauthReason: reason ?? "refresh_unknown",
       reauthAt: at,
       lastErrorType: "token_refresh_failed",
       lastErrorAt: at,
     }));
   }

   export async function clearNeedsReauth(connectionId) {
     if (!connectionId) return false;
     return !!(await updateProviderConnection(connectionId, {
       needsReauth: false,
       reauthReason: null,
       reauthAt: null,
       reauthNotifiedAt: null,
     }));
   }

   export async function markReauthNotified(connectionId, { reauthAt }) {
     if (!connectionId || !reauthAt) return false;
     const row = await getProviderConnectionById(connectionId);
     if (!row) return false;
     if (row.reauthAt !== reauthAt) return false;
     if (row.reauthNotifiedAt) return false;
     await updateProviderConnection(connectionId, {
       reauthNotifiedAt: new Date().toISOString(),
     });
     return true;
   }

   export function isNeedingReauth(connection) {
     return !!(connection && connection.needsReauth);
   }
   ```
4. Run tests again — confirm green. If any helper drifted from the spec, fix the test or the code (not both).
5. Verify `npm run build` (Next.js compile) still passes — no runtime regressions.

## Success Criteria

- [ ] All 9 unit tests pass.
- [ ] `connectionsRepo` round-trip persists new fields.
- [ ] No production caller wired yet (intentional — Phase 4 wires `markNeedsReauth`, Phase 7 wires `clearNeedsReauth`).
- [ ] `npm run build` passes.
- [ ] `markReauthNotified` is provably single-writer for the same `(connectionId, reauthAt)` tuple under sequential calls.

## Risk Assessment

| Risk | Mitigation |
| ---- | ---------- |
| `markReauthNotified` race between two failing requests on the same connection | SQLite is single-writer per process; race window is the read → write gap. Acceptable for "1 webhook per incident" — worst case is 2 webhooks, mitigated by `reauthNotifiedAt` second write being idempotent. Real-world reauth events are rare (minutes/hours), not microseconds. |
| Legacy rows missing the 4 fields | `OPTIONAL_FIELDS` is just a whitelist; `rowToConn` returns undefined → coerced to falsy. Test #7 covers this. |
| `data` JSON blob bloat | ~80 bytes per row — negligible. |

## Next Steps

Phase 2 fixes the missing proactive-refresh calls in tts/stt and adds mid-stream retry-once across all handlers. Phases 3-4 wire the notifier to call `markNeedsReauth`. Phase 7 wires the OAuth callback to call `clearNeedsReauth`.

## Red Team Adjustments — 2026-05-24

Findings **F6, F13, F15** accepted. Apply BEFORE writing helpers.

### F6 — Atomic CAS in `markReauthNotified` (HIGH)

Original (lines 122–132) does `getProviderConnectionById` then `updateProviderConnection` — non-atomic. Two concurrent failed requests both see `reauthNotifiedAt === null` → both fire webhook. `refreshPromiseCache` partially mitigates `getAccessToken` calls but not `forceRefresh` (Phase 2 bypasses cache by setting `expiresAt: 0`).

Add a transaction-bounded helper to `src/lib/db/repos/connectionsRepo.js`:
```js
export function compareAndUpdateProviderConnection(connectionId, predicate, updates) {
  return db.transaction(() => {
    const row = getProviderConnectionById(connectionId);
    if (!row || !predicate(row)) return false;
    return !!updateProviderConnection(connectionId, updates);
  })();
}
```

Rewrite `markReauthNotified`:
```js
export async function markReauthNotified(connectionId, { reauthAt }) {
  if (!connectionId || !reauthAt) return false;
  return compareAndUpdateProviderConnection(
    connectionId,
    row => row.reauthAt === reauthAt && !row.reauthNotifiedAt,
    { reauthNotifiedAt: new Date().toISOString() },
  );
}
```

Add test #10 — `markReauthNotified parallel calls: only one returns true`. `Promise.all([...].map(() => markReauthNotified(...)))` ⇒ exactly one truthy.

### F13 — `lastErrorType` writes violate "pure helper" rule + sticky UI badge (HIGH)

`markNeedsReauth` writes `lastErrorType: "token_refresh_failed"` + `lastErrorAt` as silent side effects. (a) `lastErrorType` NOT in `OPTIONAL_FIELDS` (`connectionsRepo.js:5-11`); (b) `clearNeedsReauth` never resets it → UI badge sticky after reconnect (`page.js:58` reads it); (c) collides with `markAccountUnavailable` at `auth.js:219-226`.

Three corrections:
1. Step 2 — add `lastErrorType` to `OPTIONAL_FIELDS` alongside the 4 reauth fields.
2. `clearNeedsReauth` must also reset `lastErrorType: null, lastErrorAt: null, errorCode: null, lastError: null` (mirror Phase 7's exchange path).
3. Keep `markNeedsReauth` writing `lastErrorType` ONLY when the current value is not `"token_refresh_failed"` — preserve specific upstream-error text from `markAccountUnavailable` when present.

### F15 — `cleanupProviderConnections` field-list drift (MEDIUM)

`cleanupProviderConnections` (`connectionsRepo.js:233-262`) keeps its own hardcoded `fieldsToCheck` mirror. Step 2 only patches `OPTIONAL_FIELDS` at line 5 → two-list drift.

Refactor `cleanupProviderConnections` to import `OPTIONAL_FIELDS` and iterate it (one-line change, DRY). Fallback: explicitly extend `fieldsToCheck` to include `needsReauth, reauthReason, reauthAt, reauthNotifiedAt, lastErrorType`.

Add Phase 1 test — cleanup mid-flight preserves reauth fields when `needsReauth=true` (not-yet-cleared row).
