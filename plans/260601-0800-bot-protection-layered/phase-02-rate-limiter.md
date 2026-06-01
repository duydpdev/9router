---
phase: 2
title: "Rate Limiter"
status: pending
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
  - check(key, {limit, windowMs}) → {allowed, retryAfter}
  - sweep()  // prune expired; called lazily + optional setInterval guarded by `typeof setInterval`
  - __test__ reset()  // clear buckets between tests
```

Sliding window: store hit timestamps, drop those older than `now - windowMs`, allow if remaining count < limit. `retryAfter = ceil((oldestInWindow + windowMs - now)/1000)`.

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
   - `__test__.reset()` clears state
2. Implement `rateLimiter.js`.
3. Run → green.

## Success Criteria
- [ ] All Phase-2 tests green
- [ ] Sliding window correct (not fixed-bucket off-by-one)
- [ ] Memory bounded via sweep; no unbounded growth on many distinct keys (sweep prunes)
- [ ] File <200 lines, no deps

## Risk Assessment
- **Memory growth from many unique IPs** → lazy prune on access + periodic sweep cap; acceptable for self-host scale.
- **State lost on pm2 restart** → acceptable for short windows; durable bans handled by fail2ban (Phase 6).
- **setInterval in Next standalone** → guard with `typeof setInterval !== "undefined"`; primary pruning is lazy-on-access so it works without the timer.
