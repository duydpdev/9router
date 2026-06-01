---
phase: 2
title: "Rate Limiter"
status: completed
priority: P1
effort: "3h"
dependencies: [1]
---

# Phase 2: Rate Limiter

## Overview

In-memory sliding-window rate limiter keyed by arbitrary string (IP or `ip:key`), mirroring the proven `Map`+TTL pattern in `loginLimiter.js`. Pure module, no middleware wiring. Supports tiered limits passed by caller.

## Requirements
- Functional: `check(key, { limit, windowMs }) → { allowed: bool, retryAfter: seconds }`. Sliding window (timestamp list or rolling counter).
- Functional: TTL eviction sweep so memory bounded — entries idle > windowMs auto-pruned (lazy on access + periodic sweep guarded so it survives serverless).
- Functional: deterministic under injected clock for tests (accept optional `now` injection, like loginLimiter uses `Date.now()`).
- Non-functional: O(1) amortized per check; no external deps; single-instance only (documented).

## Architecture

```
src/lib/security/rateLimiter.js
  - const buckets = new Map()   // key → { hits: number[], }  (timestamps in window)
  - const MAX_KEYS = 50000      // hard cap — see DoS note below
  - check(key, {limit, windowMs}) → {allowed, retryAfter}
  - sweep()  // prune expired; called lazily + optional setInterval guarded by `typeof setInterval`
  - __test__ reset()  // clear buckets between tests
```

Sliding window: store hit timestamps, drop those older than `now - windowMs`, allow if remaining count < limit. `retryAfter = ceil((oldestInWindow + windowMs - now)/1000)`.

**Bounded memory (DoS hard cap):** a spoofed-XFF flood (see Phase 4 trustProxy) creates one bucket per fake IP. Lazy-on-access prune never reclaims keys that are never re-accessed, and an O(n) sweep over millions of entries stalls the event loop on the hot `/v1` path. → cap `buckets.size` at `MAX_KEYS`; on insert-at-cap, evict oldest-inserted (Map preserves insertion order — `buckets.delete(buckets.keys().next().value)`) before adding. Guarantees bounded memory + cheap sweep regardless of attack volume.

**Mirror loginLimiter conventions:** module-level `Map`, `now()` helper, in-memory comment header noting reset-on-restart + single-instance limitation.

## Related Code Files
- Create: `src/lib/security/rateLimiter.js`
- Create: `tests/security/rateLimiter.test.js`
- Read for context: `src/lib/auth/loginLimiter.js` (pattern reference)

## Implementation Steps (TDD)
1. **Write tests first** `tests/security/rateLimiter.test.js`:
   - under limit → allowed
   - exceed limit within window → `{allowed:false, retryAfter>0}`
   - window slides: after windowMs old hits drop, allowed again
   - distinct keys independent
   - `retryAfter` math correct
   - **cap eviction**: inserting key N+1 past `MAX_KEYS` evicts oldest; `buckets.size` never exceeds cap
   - `__test__.reset()` clears state
2. Implement `rateLimiter.js`.
3. Run → green.

## Success Criteria
- [ ] All Phase-2 tests green
- [ ] Sliding window correct (not fixed-bucket off-by-one)
- [ ] Memory hard-bounded: `buckets.size ≤ MAX_KEYS` under any input (LRU eviction proven by test)
- [ ] File <200 lines, no deps

## Risk Assessment
- **Memory growth from many unique IPs (spoofed-XFF flood)** → `MAX_KEYS` cap + insertion-order eviction bounds peak memory and keeps sweep cheap; not reliant on prune timing.
- **State lost on pm2 restart** → acceptable for short windows; durable bans handled by fail2ban (Phase 6).
- **setInterval in Next standalone** → guard with `typeof setInterval !== "undefined"`; primary pruning is lazy-on-access so it works without the timer.
