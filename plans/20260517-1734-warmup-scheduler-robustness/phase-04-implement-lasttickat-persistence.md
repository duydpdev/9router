---
phase: 4
title: lastTickAt persistence via makeKv + monotonic guard + tests
status: completed
priority: P2
effort: 0.5h
dependencies:
  - 1
  - 2
---

# Phase 4: lastTickAt persistence

## Overview

Persist scheduler's `lastTickAt` to `kv` (`scope=warmup`, `key=lastTickAt`) via the existing `makeKv` helper (red-team Finding 12). Strict input validation (throw on invalid, no silent swallow). Monotonic write — refuse a value older than the currently persisted one (Finding 11). Tests run on isolated DATA_DIR (Finding 3 infra from Phase 2).

## Requirements

Functional:
- `getWarmupLastTickAt()` returns ISO string or `null`.
- `setWarmupLastTickAt(value)`:
  - Coerces `Date` → ISO string. Accepts plain ISO string.
  - **Throws** `TypeError` on any other input (null, undefined, non-Date, non-string, non-ISO-format).
  - Reads current persisted value; if new value `<=` current → no-op (silent, no throw — monotonic guard prevents NTP backward writes).
- No defensive `null` swallowing. No "clear" semantics. To reset, callers `kv.remove`.

Non-functional:
- Uses `makeKv("warmup")` from `src/lib/db/helpers/kvStore.js`.
- Store-layer wrappers `getWarmupLastTickAt`/`setWarmupLastTickAt` in `src/lib/warmup/store.js`.

## Architecture

```js
// src/lib/warmup/store.js (additions)
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const warmupKv = makeKv("warmup");
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function getWarmupLastTickAt() {
  return warmupKv.get("lastTickAt", null);
}

export async function setWarmupLastTickAt(value) {
  let iso;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("setWarmupLastTickAt: invalid Date");
    iso = value.toISOString();
  } else if (typeof value === "string" && ISO_RE.test(value)) {
    iso = value;
  } else {
    throw new TypeError(`setWarmupLastTickAt: expected Date or ISO string, got ${typeof value}`);
  }
  const current = await warmupKv.get("lastTickAt", null);
  if (current && current >= iso) return; // monotonic — reject backward writes
  await warmupKv.set("lastTickAt", iso);
}
```

ISO string comparison is lexically equivalent to chronological order (ISO-8601 zulu format).

## Related Code Files

- Modify: `src/lib/warmup/store.js` — add `getWarmupLastTickAt` / `setWarmupLastTickAt`.
- Tests in `tests/warmup-lasttickat.test.mjs` (new file) — uses `setupIsolatedDb` from Phase 2.

## Implementation Steps

1. Write failing tests (`tests/warmup-lasttickat.test.mjs`):
   - Fresh DB → `getWarmupLastTickAt()` returns `null`.
   - `setWarmupLastTickAt("2026-05-17T10:00:00.000Z")` then `get` → returns that ISO.
   - `setWarmupLastTickAt(new Date("2026-05-17T11:00:00.000Z"))` then `get` → returns ISO of that Date.
   - `setWarmupLastTickAt(null)` throws.
   - `setWarmupLastTickAt("not an iso")` throws.
   - Set newer, then set older → second write ignored; `get` still returns newer.
   - Set newer, then set same → no-op.
2. Implement `getWarmupLastTickAt` and `setWarmupLastTickAt` per architecture sketch.
3. Run tests → all 7 pass.

## Success Criteria

- [ ] All 7 tests pass on isolated DATA_DIR.
- [ ] Invalid input throws (not silent).
- [ ] Backward writes are rejected (monotonic).
- [ ] Uses `makeKv` helper (no hand-rolled SQL).

## Risk Assessment

- Risk: race between two concurrent `setWarmupLastTickAt` calls reading the same `current`. Mitigation: in single-VPS single-process, only one caller (scheduler tick) ever sets this. The `g.running` guard serializes ticks. If a second caller is ever added, wrap the read-write in `db.transaction(...)`.
- Risk: future caller passing a non-millisecond ISO (e.g. `2026-05-17T10:00:00Z` without millis). Mitigation: regex requires `.000Z` form. Date.toISOString() always emits this form. If a tighter loosening is needed later, update the regex.
