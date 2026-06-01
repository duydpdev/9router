---
phase: 4
title: "Middleware Wiring"
status: pending
priority: P1
effort: "4h"
dependencies: [1, 2, 3]
---

# Phase 4: Middleware Wiring

## Overview

The integration phase. `botGuard()` orchestrates Phase 1 rules + Phase 2 rate limiter + Phase 3 settings/audit, with exemptions (loopback, valid key). Wired as the **first check** in `proxy()` (`dashboardGuard.js`). This is where bot protection becomes real.

## Requirements
- Functional: `botGuard(request) → NextResponse | null`. Returns a block response (403 for UA/probe, 429 for rate) or `null` to pass through.
- Functional: short-circuit when `settings.botProtection.enabled === false`.
- Functional: **exemptions** — loopback always passes; valid API key / CLI token skip UA + crawler block and get `llmRateLimit.keyLimit` tier on `/v1`.
- Functional: every block calls `logBlocked` (Phase 3).
- Non-functional: settings read must not deadlock (reuse `loadSettings()` pattern in dashboardGuard — direct DB read, not self-fetch).

## Architecture

```
src/lib/security/botGuard.js
  botGuard(request):
    settings = await loadBotSettings()        // direct DB read (no self-fetch)
    if !settings.enabled → null
    if isLoopback(request) → null             // reuse dashboardGuard isLocalRequest helper
    ip = getClientIp(request)
    ua = request.headers.get("user-agent")
    hasKey = await hasValidApiKey || hasValidCliToken   // reuse dashboardGuard helpers

    // 1. probe paths (always, even keyed — probes are never legit)
    cls = classifyRequest({pathname, userAgent: ua, opts})
    if cls.block && cls.kind==="probe" → logBlocked; 403
    if cls.block && !hasKey → logBlocked; 403      // bad-UA / ai-crawler skipped for valid key

    // 2. rate limit
    if /v1: tier = hasKey ? keyLimit : limit; check(`v1:${ip}`,...)
    else: check(`g:${ip}`, rateLimit)
    if !allowed → logBlocked; 429 + Retry-After

    return null
```

Wire in `dashboardGuard.proxy()` as first statement:
```js
export async function proxy(request) {
  const botBlock = await botGuard(request);
  if (botBlock) return botBlock;
  const { pathname } = request.nextUrl;
  ... // existing logic unchanged
}
```

**Reuse, don't duplicate:** export `isLocalRequest`, `hasValidApiKey`, `hasValidCliToken` helpers from dashboardGuard (already in `__test__`) or import shared. Keep botGuard importing them to honor DRY.

## Related Code Files
- Create: `src/lib/security/botGuard.js`
- Modify: `src/dashboardGuard.js` (call botGuard first; export helpers if needed for reuse)
- Create: `tests/security/botGuard.test.js`
- Read for context: `src/dashboardGuard.js` (helpers, loadSettings, isLocalRequest), `src/proxy.js` (matcher)

## Implementation Steps (TDD)
1. **Write tests first** `tests/security/botGuard.test.js` (mock request + settings + key validator):
   - disabled setting → `null` (pass)
   - loopback request → `null` even for probe path
   - probe path from remote → 403, audit called
   - bad-UA remote no key → 403; bad-UA WITH valid key → pass
   - ai-crawler no key → 403; toggle off → pass
   - rate limit trip → 429 with Retry-After header
   - `/v1` with valid key uses keyLimit tier (higher) — allowed where no-key would block
2. Implement `botGuard.js` reusing dashboardGuard helpers.
3. Wire first-check into `proxy()`.
4. Add regression test: existing dashboardGuard auth tests still green (botGuard returns null for normal authed requests).
5. Run full suite → green.

## Success Criteria
- [ ] All botGuard tests green + existing dashboardGuard/auth tests green (no regression)
- [ ] botGuard is first check in `proxy()`; returns null on the happy path
- [ ] Exemptions correct: loopback + valid-key behave per spec
- [ ] Blocks emit audit log
- [ ] `npm run build` passes (middleware bundles in standalone)

## Risk Assessment
- **Middleware runtime**: `proxy.js` runs in Node runtime (standalone) — `better-sqlite3` DB read OK (already used by `loadSettings`). Confirm no edge-runtime constraint introduced.
- **Per-request settings read cost** → `loadSettings` already called for dashboard routes; consider short in-memory settings cache (TTL ~5s) if profiling shows cost. Defer unless measured (YAGNI).
- **False-positive lockout of operator** → loopback + valid-key exemptions + global toggle; audit log to diagnose; conservative default limits.
- **Breaking `/v1` clients** → key-aware tier + bad-UA/crawler exemption for valid keys covers legit SDK traffic.
