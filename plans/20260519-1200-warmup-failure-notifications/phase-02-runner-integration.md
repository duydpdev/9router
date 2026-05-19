---
phase: 2
title: "Runner integration"
status: completed
priority: P1
effort: "1.5h"
dependencies: [1]
---

# Phase 2: Runner integration

## Overview

Wire `notifier.js` into `src/lib/warmup/runner.js`. Add a `{ notify }` option to `runWarmupDueItem(item, options)` and `runWarmupItems(items, options)`. Default is `{ notify: false }` — a safe default that prevents accidental notifications from new call sites or manual paths. The scheduler explicitly opts in (Phase 3) with `{ notify: "scheduler" }` for normal ticks and `{ notify: "digest" }` for catch-up batches (red-team #2). Fire-and-forget invocation: notifier exceptions never propagate into runner.

**Notifier is dynamic-imported inside `runner.js`** (`await import("@/lib/warmup/notifier")`) — NOT a top-level static import — so the notifier module does not eagerly evaluate when `runner.js` is loaded by other paths (e.g. the unauthenticated manual API route). This matches the original "remains lazy" success criterion. (red-team #12)

## Requirements

**Functional:**
- `runWarmupDueItem(item, { notify = false } = {})` — preserve existing behavior. `notify` is a tri-state: `false` | `"scheduler"` | `"digest"`.
  - `notify === false` (manual API + default): no recovery state mutation, no notification
  - `notify === "scheduler"`:
    - on success → call `recordSuccess(connectionId)`; if `shouldEmitRecovery` → `notifyWarmupRecovery({...})` fire-and-forget
    - on failure → call `recordFailure(connectionId, item.dedupeKey)` then `notifyWarmupFailure({...})` fire-and-forget
    - **Skip notify entirely if the thrown error message starts with `"Provider connection is inactive"` or `"Provider connection not found"`** — config state, not provider failure. Recovery state is also NOT mutated for these. (red-team #14)
  - `notify === "digest"`: collected by `runWarmupItems`, sent as ONE summary call to `notifyWarmupDigest({ batch })` after all items run. (red-team #2)
- `runWarmupItems(items, options)` — pass options to each `runWarmupDueItem` call. In `digest` mode, accumulate per-item results then emit a single digest at the end instead of per-item notifications.
- Notifier calls are non-blocking via `void` (no `await`) so warmup throughput is unaffected
- Notifier exceptions caught at call site (defensive — notifier already wraps internally)
- `item.skipped` path (dedupe hit) does NOT touch recovery state and does NOT notify
- Notifier is imported via `await import("@/lib/warmup/notifier")` lazily inside the function body, NOT at module top-level (red-team #12)

**Non-functional:**
- Maintain current export signatures so existing tests / callers stay green
- No changes to `appendWarmupRun` semantics
- No new imports outside `@/lib/warmup/notifier`

## Architecture

Existing runner (`feature/dylan-improve` HEAD):
```
runWarmupDueItem(item)
  ├── if hasWarmupRun(dedupeKey) → return {skipped:true}
  └── try sendWarmupRequest(connection, prompt)
        ├── success → appendWarmupRun({status:"success"}) → return row
        └── failure → appendWarmupRun({status:"failure", error}) → return row
```

After Phase 2 (notify is tri-state `false | "scheduler" | "digest"`):
```
runWarmupDueItem(item, { notify = false })
  ├── if hasWarmupRun(dedupeKey) → return {skipped:true}   // no notify
  └── try sendWarmupRequest(connection, prompt)
        ├── success
        │   ├── row = appendWarmupRun({status:"success"})
        │   ├── if notify === "scheduler":
        │   │     const { shouldEmitRecovery, distinctFails } = recordSuccess(connectionId)
        │   │     if shouldEmitRecovery: void notifyWarmupRecovery({ schedule, connection, run, distinctFails })
        │   └── return row
        └── failure
            ├── row = appendWarmupRun({status:"failure", error})
            ├── if notify === "scheduler" AND !isConfigStateError(error.message):
            │     const { distinctFails } = recordFailure(connectionId, item.dedupeKey)   // red-team #6
            │     void notifyWarmupFailure({ schedule, connection, run, distinctFails })
            └── return row

runWarmupItems(items, { notify })
  ├── per item → runWarmupDueItem(item, { notify: notify === "digest" ? false : notify })
  ├── accumulate digestBatch when notify === "digest" and result.status === "failure"
  └── if notify === "digest" AND digestBatch.length > 0:
        void notifyWarmupDigest({ batch: digestBatch })   // ONE summary per catch-up tick (red-team #2)
```

`schedule` / `connection` / `run` shape passed to notifier:

```js
schedule:   { id: item.schedule.id, name: item.schedule.name, timezone: item.schedule.timezone }
connection: { id: connection.id,    name: connection.name || connection.displayName || connection.email || connection.provider, provider: connection.provider }
run:        { localDate: item.localDate, localTime: item.localTime, scheduledForUtc: item.scheduledForUtc, error: errorMessageIfFailure }
```

## Related Code Files

**Modify:**
- `src/lib/warmup/runner.js`

**Create:** none

## Implementation Steps

### Step 1: Edit `src/lib/warmup/runner.js`

**DO NOT add top-level imports for the notifier.** Use a lazy local helper instead, so the notifier module is not evaluated by paths that only need the runner (e.g. the unauthenticated `/api/warmup/run` route which static-imports `runWarmupItems`). (red-team #12)

```js
async function loadNotifier() {
  return import("@/lib/warmup/notifier");
}

// red-team #14: distinguish config-state failures from provider failures
function isConfigStateError(message) {
  if (typeof message !== "string") return false;
  return message.startsWith("Provider connection not found") ||
         message.startsWith("Provider connection is inactive");
}
```

Change `runWarmupDueItem` signature and add hooks inside the existing try/catch:

```js
export async function runWarmupDueItem(item, { notify = false } = {}) {
  if (await hasWarmupRun(item.dedupeKey)) {
    return { skipped: true, /* unchanged fields */ };
  }

  let connection;
  try {
    connection = await getProviderConnectionById(item.providerConnectionId);
    if (!connection) throw new Error("Provider connection not found");
    if (connection.isActive === false) throw new Error("Provider connection is inactive");

    await sendWarmupRequest(connection, item.schedule.prompt);

    const row = await appendWarmupRun({ /* unchanged success payload */ });

    if (notify === "scheduler") {
      // success path → only mutate recovery state for REAL provider successes
      const { recordSuccess, notifyWarmupRecovery } = await loadNotifier();
      const { shouldEmitRecovery, distinctFails } = recordSuccess(item.providerConnectionId);
      if (shouldEmitRecovery) {
        // fire-and-forget — notifier swallows its own errors
        void notifyWarmupRecovery({
          schedule: { id: item.schedule.id, name: item.schedule.name, timezone: item.schedule.timezone },
          connection: {
            id: connection.id,
            name: connection.name || connection.displayName || connection.email || connection.provider,
            provider: connection.provider,
          },
          run: { localDate: item.localDate, localTime: item.localTime, scheduledForUtc: item.scheduledForUtc, dedupeKey: item.dedupeKey },
          distinctFails,
        });
      }
    }

    return row;
  } catch (error) {
    const row = await appendWarmupRun({
      /* unchanged failure payload, status:"failure", error:error.message||"Warmup failed" */
    });

    if (notify === "scheduler" && !isConfigStateError(error.message)) {
      // red-team #14: only mutate recovery state for real provider failures
      const { recordFailure, notifyWarmupFailure } = await loadNotifier();
      const { distinctFails } = recordFailure(item.providerConnectionId, item.dedupeKey);  // red-team #6
      void notifyWarmupFailure({
        schedule: { id: item.schedule.id, name: item.schedule.name, timezone: item.schedule.timezone },
        connection: {
          id: connection?.id || item.providerConnectionId,
          name: connection?.name || connection?.displayName || connection?.email || connection?.provider || `<missing:${item.providerConnectionId}>`,
          provider: connection?.provider || "(unknown)",
        },
        run: {
          localDate: item.localDate,
          localTime: item.localTime,
          scheduledForUtc: item.scheduledForUtc,
          dedupeKey: item.dedupeKey,
          error: error.message || "Warmup failed",
        },
        distinctFails,
      });
    }

    return row;
  }
}

export async function runWarmupItems(items, options = {}) {
  const { notify = false } = options;
  const results = [];
  const digestBatch = [];

  for (const item of items) {
    // In digest mode, each item runs with notify=false to suppress per-item notifications,
    // and the runner accumulates failure batch entries for a single end-of-batch digest send.
    const perItemNotify = notify === "digest" ? false : notify;
    const result = await runWarmupDueItem(item, { notify: perItemNotify });
    results.push(result);

    if (notify === "digest" && result?.status === "failure") {
      digestBatch.push({
        scheduleId: item.schedule.id,
        scheduleName: item.schedule.name,
        connectionId: item.providerConnectionId,
        localDate: item.localDate,
        localTime: item.localTime,
        error: result.error || "Warmup failed",
      });
    }
  }

  if (notify === "digest" && digestBatch.length) {
    const { notifyWarmupDigest } = await loadNotifier();
    void notifyWarmupDigest({ batch: digestBatch });
  }
  return results;
}
```

### Step 2: Syntax check

```bash
node --check src/lib/warmup/runner.js
```

### Step 3: Run existing warmup tests

```bash
npm run test:warmup
```

Equivalent: `node --import ./tests/helpers/at-loader.mjs --test tests/warmup-*.test.mjs` (red-team #9).

Expected: all pass. If `tests/warmup-scheduler.test.mjs` calls `runWarmupItems` directly and relies on the old signature, the test must continue to pass because `options` defaults to `{}` (and `notify` defaults to `false`).

### Step 4: Commit

```bash
git add src/lib/warmup/runner.js
git commit -m "feat(warmup): wire notifier into runner via opt-in notify flag"
```

## Todo

- [x] Add `loadNotifier()` lazy local helper + `isConfigStateError()` helper to `runner.js` — NO top-level notifier import
- [x] Update `runWarmupDueItem` signature to accept `{ notify = false }` tri-state (`false` | `"scheduler"` | `"digest"`)
- [x] Add notify branches: success → recordSuccess + maybe notifyWarmupRecovery; failure → skip if config-state error, else recordFailure(id, dedupeKey) + notifyWarmupFailure
- [x] Update `runWarmupItems` to accumulate digest batch when `notify === "digest"` and emit one `notifyWarmupDigest({ batch })` at end
- [x] Confirm `connection` is reachable in catch block (use safe optional chaining for the failure-before-connection-loaded edge case)
- [x] `node --check` runner.js
- [x] `eslint` runner.js
- [x] Verify `grep` shows zero top-level notifier imports
- [x] Run `npm run test:warmup`
- [x] Commit

## Success Criteria

- [x] `node --check src/lib/warmup/runner.js` clean
- [x] `npx eslint src/lib/warmup/runner.js` clean (red-team #M10)
- [x] `npm run test:warmup` — all existing warmup tests + new notifier tests PASS
- [x] Notifier is loaded **lazily** via `await import("@/lib/warmup/notifier")` inside the function body — verified by `grep -n "from \"@/lib/warmup/notifier\"" src/lib/warmup/runner.js` returning 0 hits at top-level (only the dynamic `import("...")` call appears). (red-team #12)
- [x] Skipped (deduped) items do NOT touch recovery state
- [x] `runWarmupItems(items)` (no second arg) behaves identically to pre-change behavior — guaranteed by `{ notify = false }` default
- [x] `notify === "scheduler"` triggers per-item notifications; `notify === "digest"` collects failures and emits ONE end-of-batch digest call (red-team #2)
- [x] `Provider connection is inactive` / `Provider connection not found` errors do NOT touch `recoveryState` and do NOT emit notifications (red-team #14)
- [x] `recordFailure` always called with `(connectionId, item.dedupeKey)` — never bare single-arg form (red-team #6)

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Existing tests call `runWarmupItems(items)` and break | Default `{ notify: false }` keeps old behavior |
| Connection lookup throws before reaching catch → `connection` is undefined | Use optional chaining + fallback string `<missing:{connectionId}>` (not `(unknown)` — actionable for the operator) (red-team review of Finding 8) |
| Notifier import pulls heavy deps into manual API hot path | LAZY dynamic `await import(...)` inside function bodies; manual API never touches notifier because `notify === false`. (red-team #12) |
| Recovery state mutated for manual runs by accident | `notify` default false; manual API path will pass `{ notify: false }` explicitly in Phase 3 |
| Recovery state mutated by transient/config errors | `isConfigStateError()` short-circuits notify path for `Provider connection not found/inactive` (red-team #14) |
| Recovery counter inflated by retries of same dedupeKey | `recordFailure(connectionId, dedupeKey)` uses a Set keyed by dedupeKey; retries are no-ops (red-team #6) |
| Manual API also static-imports runner → would eager-load notifier if runner static-imported it | Runner uses `await import(...)` so notifier evaluation is deferred until first scheduler notify call; manual API never triggers it because `notify: false` (red-team #12) |
| `void` fire-and-forget abandons in-flight fetch on SIGTERM | Acknowledged out of scope for this plan (red-team #M4). Notifier itself wraps `Promise.allSettled` with 5s timeout, so worst case is one truncated send per shutdown |
