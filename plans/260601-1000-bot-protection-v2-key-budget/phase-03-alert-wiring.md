---
phase: 3
title: "Alert & Wiring"
status: completed
priority: P1
effort: "7h"
dependencies: [2]
---

# Phase 3: Alert & Wiring

## Overview

Wire the budget monitor at the **post-completion usage-write event** (not the `/v1` hot path), build the alert sender, and add restart-safe dedup + re-alert. Fire-and-forget, never affects requests.

## Requirements

- Functional: after a request's usage is recorded, if the requesting key crossed `warn` then `over` tier, send an alert via configured channels. Re-alert every `reAlertHours` while still over (not fire-once). Request flow unaffected.
- Non-functional: zero added latency on the `/v1` response path (check runs off the `statsEmitter` event, after the response). Never throws into the request or the emitter. Bounded memory. Masked key only.

## Architecture

**Trigger (red-team Finding 3)** — in `saveRequestUsage` (`usageRepo.js`), after the existing `statsEmitter.emit("update")`, add `statsEmitter.emit("usage", { apiKey: entry.apiKey, status: entry.status })`. A monitor module subscribes; `usageRepo` does NOT import security code (clean layering). Monitor registered once via `initKeyBudgetMonitor()` at server startup (same bootstrap that other singletons use).

```js
// keyBudget.js — registered at boot
export function initKeyBudgetMonitor() {
  statsEmitter.on("usage", ({ apiKey }) => {
    if (!apiKey) return;                  // keyless/CLI-token path: see decision below
    queueMicrotask(() => { void checkKeyBudget(apiKey).catch(() => {}); });
  });
}
```

**checkKeyBudget(apiKey)** — reads cached bot settings (`getCachedBotSettings`, reuse), bails if `keyBudget.enabled` false; `getTodayUsageForKey(apiKey)`; `evaluateBudget`; on non-null tier → dedup-gated `notifyKeyBudget`. Whole body in try/catch.

**Dedup + re-alert (red-team Findings 5,10,12)** — in-memory `Map`, value per `keyHash` = `{ dateKey, tier, lastSentMs }`. **Claim synchronously** (set the map entry) BEFORE awaiting the notifier, so concurrent events for the same key don't double-send. Send when: tier escalated (warn→over), OR new dateKey, OR (`tier==="over"` AND `now - lastSentMs >= reAlertHours`). Bound the Map exactly like `rateLimiter.js`: `MAX_KEYS` insertion-order eviction (`rateLimiter.js:9,22-23`) + a `sweep()` dropping entries whose `dateKey !== today`, called on a timer (mirror `rateLimiter.sweep`). Restart resets the Map → at most one re-alert after restart (acceptable; a crash-loop is bounded by the per-key `reAlertHours` gate since `lastSentMs` resets but the next check still respects tier escalation).

**Alert sender** (`src/lib/notifier/key-budget-alert.js`, mirror `reauth-alert.js` structure):
- Gate on `getNotifierConfig().enabled` (⚠️ requires `WARMUP_NOTIFY_ENABLED`; surfaced in Phase 1 UI).
- **Dedicated hourly flood cap** (red-team Finding 10): a `tryReserveBudgetSlot()` independent window (mirror `tryReserveFailureSlot`, `notifier.js:217-223`) — budget alerts do NOT share the warmup rate-limit budget and cannot flood.
- Payload: `keyName` + masked `keyHash` + `tier` + today `{tokens, requests}` vs budget. **Never the raw key** (red-team Finding 7): build payloads from an explicit allowlist of fields; do NOT spread a `fields`/`meta` object wholesale (the `reauth` generic payload spreads `fields` — `reauth-alert.js:104` — do NOT copy that shape). `keyName` resolved from the apiKeys repo by id, never echoing the raw key.

## Related Code Files

- Modify: `src/lib/db/repos/usageRepo.js` (add `statsEmitter.emit("usage", {...})` after line 283)
- Modify: `src/lib/security/keyBudget.js` (`checkKeyBudget`, `initKeyBudgetMonitor`, dedup Map + evict/sweep, usage read)
- Create: `src/lib/notifier/key-budget-alert.js` (`notifyKeyBudget` + builders + `tryReserveBudgetSlot`)
- Modify: server bootstrap (call `initKeyBudgetMonitor()` once — locate the existing startup init path during cook)
- Create: `tests/unit/security-key-budget-alert.test.js`

## Implementation Steps (TDD)

1. **Test first** — `security-key-budget-alert.test.js`: (a) dedup: two `over` events same key/day → notifier once; warn→over → twice; new day → resets; `over` again after `reAlertHours` → re-sends, before → not. (b) **concurrency**: N parallel `checkKeyBudget` for one over-key → exactly one send (sync claim). (c) disabled config → no send. (d) `checkKeyBudget` never throws even if reader rejects; **synchronous** throw in the subscriber is swallowed. (e) serialized payload string does NOT contain the raw key. (f) flood cap: >cap budget alerts in an hour → excess suppressed. Inject notifier + clock. Run → red.
2. Implement alert sender + builders + `tryReserveBudgetSlot`. Run → green.
3. Implement `checkKeyBudget` + dedup/evict/sweep + `initKeyBudgetMonitor`. Run → green.
4. Add the `statsEmitter.emit("usage", …)` line; wire `initKeyBudgetMonitor()` at boot. Add `__test__` reset hook for the dedup Map.

## Decision — CLI-token path (red-team Finding 12)

The CLI-token `/v1` path has no `apiKey` (`botGuard.js:127`). The monitor subscribes to usage events and keys by `apiKey`; CLI-token traffic is recorded as `local-no-key` and is **out of budget scope** (it is first-party operator traffic, not a leaked third-party key). Documented; not covered. Revisit only if CLI tokens are ever issued to untrusted parties.

## Success Criteria

- [ ] Alert sent once per (key, day, tier); re-alert after `reAlertHours` while over; raw key never in serialized payload (tests green)
- [ ] Concurrent events for one over-key → exactly one send (sync-claim test green)
- [ ] `/v1` response path unchanged — monitor runs off `statsEmitter`, post-response (no botGuard edit)
- [ ] `checkKeyBudget` swallows async AND sync errors (test green)
- [ ] Dedup Map bounded (`MAX_KEYS` + sweep); `__test__` size assertion
- [ ] Flood cap suppresses excess alerts (test green)
- [ ] `cd tests && npm test -- unit/security-*.test.js` all green

## Risk Assessment

- Risk: event-handler unhandled rejection. Mitigation: `queueMicrotask` + `.catch(()=>{})` + internal try/catch; sync-throw test.
- Risk: alert flood across many leaked keys. Mitigation: dedicated hourly cap (Finding 10) + per-key dedup.
- Risk: multi-instance dup alerts. Mitigation: documented single-instance constraint (plan.md); not solved.
- Risk: `keyName` lookup leaking raw key. Mitigation: lookup by id, allowlist payload fields, payload-string test.

## Security Note

Masked `keyHash` (shared module) + key name only. Upholds v1 invariant: never log/transmit raw keys. Enforced by an explicit string-contains test, not just field-absence.
