---
phase: 2
title: "Header Parsing + Bypass Conditions"
status: completed
priority: P2
effort: "2-3h"
dependencies: [1]
---

# Phase 2: Header Parsing + Bypass Conditions

## Overview

Pure parsing/policy module: read `x-router-cache` and `x-router-cache-stream` headers, inspect request body for bypass conditions, return `CacheDirective { enabled, ttl, streamEnabled, bypassReason? }`. Handlers consume this in Phase 3+ — no handler wiring yet.

## Requirements

### Functional
- `parseCacheDirective(req, body) → CacheDirective` returns:
  - `enabled: boolean` — true only if header opt-in AND no bypass
  - `ttl: number` — seconds, validated 1..86400 (1 day max)
  - `streamEnabled: boolean` — only honored if `body.stream === true`
  - `bypassReason: string | null` — set when forced bypass triggered (for logging)
- Header formats:
  - `x-router-cache: ttl=300` → enabled, ttl=300
  - `x-router-cache: ttl=300, no-store` → no-store wins, disabled
  - `x-router-cache: no-store` → disabled
  - missing or empty → disabled
  - invalid (`ttl=foo`) → disabled + warn
- Body bypass conditions (force `enabled=false`, set `bypassReason`):
  - `body.tools` array present and non-empty → `bypassReason = "tools_present"`
  - `body.temperature` defined and > 0 → `bypassReason = "non_zero_temperature"`
  - `body.stream === true` AND `streamEnabled === false` → `bypassReason = "stream_default_bypass"`
- Bypass beats opt-in. NEVER cache if any bypass condition matches, even if header says otherwise.

### Non-functional
- Pure function, no state
- O(1) on header parse, O(|tools|) on body inspect

## Architecture

```
src/sse/services/cache-directive.js
  ├── parseCacheDirective(req, body) → CacheDirective
  ├── parseCacheHeader(headerValue) → { ttl, noStore, valid }
  └── computeBypass(body, requestedStream) → string | null
```

`CacheDirective` shape:
```ts
{
  enabled: boolean,
  ttl: number,           // 0 if not enabled
  streamEnabled: boolean,
  bypassReason: string | null,
}
```

## Related Code Files

- Create: `src/sse/services/cache-directive.js`
- Create: `tests/unit/prompt-cache-directive.test.js`

## TDD — failing tests first

```js
// tests/unit/prompt-cache-directive.test.js
import { describe, it, expect } from "vitest";

let parseCacheDirective;
beforeEach(async () => {
  ({ parseCacheDirective } = await import("@/sse/services/cache-directive.js"));
});

const mkReq = (headers = {}) => ({ headers: new Map(Object.entries(headers)) });

describe("parseCacheDirective", () => {
  describe("header parsing", () => {
    it("no header → disabled", () => {
      const d = parseCacheDirective(mkReq(), { model: "x", messages: [] });
      expect(d.enabled).toBe(false);
    });

    it("ttl=300 → enabled, ttl=300", () => {
      const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=300" }), { model: "x", messages: [] });
      expect(d).toMatchObject({ enabled: true, ttl: 300 });
    });

    it("no-store → disabled even with ttl=300", () => {
      const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=300, no-store" }), { model: "x", messages: [] });
      expect(d.enabled).toBe(false);
      expect(d.bypassReason).toBe("explicit_no_store");
    });

    it("ttl=foo → disabled", () => {
      const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=foo" }), { model: "x", messages: [] });
      expect(d.enabled).toBe(false);
    });

    it("ttl clamped to 86400", () => {
      const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=999999" }), { model: "x", messages: [] });
      expect(d.ttl).toBeLessThanOrEqual(86400);
    });
  });

  describe("body bypass", () => {
    it("tools present → bypass even with header", () => {
      const d = parseCacheDirective(
        mkReq({ "x-router-cache": "ttl=300" }),
        { model: "x", messages: [], tools: [{ name: "search" }] },
      );
      expect(d.enabled).toBe(false);
      expect(d.bypassReason).toBe("tools_present");
    });

    it("temperature > 0 → bypass", () => {
      const d = parseCacheDirective(
        mkReq({ "x-router-cache": "ttl=300" }),
        { model: "x", messages: [], temperature: 0.7 },
      );
      expect(d.enabled).toBe(false);
      expect(d.bypassReason).toBe("non_zero_temperature");
    });

    it("temperature=0 → enabled", () => {
      const d = parseCacheDirective(
        mkReq({ "x-router-cache": "ttl=300" }),
        { model: "x", messages: [], temperature: 0 },
      );
      expect(d.enabled).toBe(true);
    });

    it("stream=true default → bypass", () => {
      const d = parseCacheDirective(
        mkReq({ "x-router-cache": "ttl=300" }),
        { model: "x", messages: [], stream: true },
      );
      expect(d.enabled).toBe(false);
      expect(d.bypassReason).toBe("stream_default_bypass");
    });

    it("stream=true + x-router-cache-stream:true → enabled", () => {
      const d = parseCacheDirective(
        mkReq({ "x-router-cache": "ttl=300", "x-router-cache-stream": "true" }),
        { model: "x", messages: [], stream: true },
      );
      expect(d.enabled).toBe(true);
      expect(d.streamEnabled).toBe(true);
    });
  });
});
```

## Implementation Steps

1. **Test-first:** write `tests/unit/prompt-cache-directive.test.js`. Run → red.
2. Implement `src/sse/services/cache-directive.js`:
   - `parseCacheHeader(value)` — split on comma, parse each token
   - `computeBypass(body, streamEnabled)` — check tools, temperature, stream
   - `parseCacheDirective(req, body)` — combine. Header check first; if `enabled`, run bypass; if bypass triggers, flip `enabled = false`, set reason
3. Handle `req.headers` shape — Next.js Web Request uses `headers.get(name)`. Use `req.headers.get?.(name) ?? req.headers?.[name]` for flexibility (tests use Map, prod uses Headers).
4. Run tests. Green.
5. Log warning on invalid header format (use existing logger, not `console.log`).

## Success Criteria

- [ ] All directive test cases pass (~12 assertions)
- [ ] Pure function, no I/O, no async
- [ ] Handles missing headers, malformed, conflicting (`no-store` + `ttl`)
- [ ] Body bypass beats header opt-in (correctness invariant)
- [ ] Header parser handles both Headers object and Map (test + prod compat)
- [ ] `npm run build` clean

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Future header fields evolve (e.g. `vary`, `tag`) | Parser tolerates unknown keys (skip with warn); only `ttl` and `no-store` recognized in v1 |
| `body.tools` shape differs across providers (OpenAI vs Claude) | Check `tools` AND `body.tool_choice` AND Claude-style `body.tools` array; document supported shapes |
| `temperature: null` vs `undefined` | Treat both as "default" → no bypass (default is 0 for most providers but caller responsibility) |
| Header case sensitivity | Use `req.headers.get` (case-insensitive for Headers object); test uses lowercase |
| Body mutation by handler later | Directive computed BEFORE handler runs; immutable result |

## Security Considerations

- Header values are user-controlled but only parsed, never executed. No injection risk.
- `bypassReason` logged to console — does not include body content.

## Red Team Adjustments — 2026-05-24

Findings **#9, #15** ACCEPTED. Body uses `Map` for tests (wrong) and treats undefined-temperature as cacheable (wrong).

### Tests use `Headers`, not `Map` (finding #15)

```js
const mkReq = (headers = {}) => ({ headers: new Headers(headers) });

// case-insensitive lookup (matches production)
const d = parseCacheDirective(mkReq({ "X-Router-Cache": "ttl=300" }), { model: "x", input: "y" });
expect(d.enabled).toBe(true);
```

### Header accessor (single source)

```js
const getHeader = (req, name) => req.headers?.get?.(name.toLowerCase()) ?? null;
```

Drop the polyfill fallback for plain objects. Production = Headers. Tests = Headers. Simpler.

### Temperature bypass tightened (finding #9)

OpenAI / Anthropic default `temperature: 1.0` when caller omits the field. Caching a missing-temperature request stores non-deterministic output.

```js
const isCacheable = (body) => {
  if (body.temperature === undefined || body.temperature === null) return false; // NEW
  if (body.temperature > 0) return false;
  return true;
};
```

Updated test:
```js
it("temperature missing → bypass (provider default = 1.0 is non-deterministic)", () => {
  const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=300" }), { model: "x", input: "y" });
  // body has no `temperature` field
  expect(d.enabled).toBe(false);
  expect(d.bypassReason).toBe("missing_or_nonzero_temperature");
});
```

### Drop `x-router-cache-stream` header (Phase 5 cancelled)

Header parser no longer recognizes `x-router-cache-stream`. Single header surface:
- `x-router-cache: ttl=300` → cache enabled with TTL
- `x-router-cache: no-store` → disabled
- `x-router-cache: ttl=300, no-store` → disabled (no-store wins)
- missing / empty / malformed → disabled

### Stream bypass simplified

`body.stream === true` → unconditional bypass (no opt-in path). v1 ships non-streaming cache only. Drop `streamEnabled` from `CacheDirective` shape.

```js
{
  enabled: boolean,
  ttl: number,            // 0 if disabled
  bypassReason: string | null,
}
```

### Tools/temperature/stream — order of bypass checks

Stream check first (cheapest). Then tools (heaviest — depends on `body.tools` array shape per #4 from MCP review). Then temperature.

### Embeddings has no `tools` / `temperature` / `stream` — bypass conditions DON'T apply

Embeddings body shape: `{ model, input, encoding_format?, dimensions?, user? }`. NO tools, NO temperature, NO stream. Phase 2 directive logic for embeddings: only `no-store` and missing-header bypass conditions apply.

Add explicit `kind` parameter:
```js
parseCacheDirective(req, body, kind)   // kind: "chat" | "embeddings"
```

For v1 (`kind === "embeddings"`), skip the tools/temperature/stream checks entirely.

### Embeddings-specific bypass: tokenized input + oversize input (findings #10)

`parseCacheDirective` (this module) OWNS all bypass logic — including embeddings input checks. Phase 4 consumes, does not define them. For `kind === "embeddings"`:

```js
const isTokenInput = (input) => {
  if (Array.isArray(input) && input.length > 0) {
    const first = input[0];
    if (typeof first === "number") return true;                          // number[]
    if (Array.isArray(first) && typeof first[0] === "number") return true; // number[][]
  }
  return false;
};

// inside parseCacheDirective, embeddings branch, after header opt-in confirmed:
if (isTokenInput(body.input)) {
  return { enabled: false, ttl: 0, bypassReason: "tokenized_input" };
}
if (JSON.stringify(body.input).length > 100_000) {                       // 100KB hash-input cap
  return { enabled: false, ttl: 0, bypassReason: "oversize_input" };
}
```

Add directive tests for both: `tokenized_input` (`input: [1,2,3]`) and `oversize_input` (`input: "x".repeat(100001)`).

### Effort revised

Was 2-3h. **Now 2h** (simpler, fewer headers, single accessor).
