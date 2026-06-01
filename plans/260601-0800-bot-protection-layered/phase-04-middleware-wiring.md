---
phase: 4
title: "Middleware Wiring"
status: completed
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

## Verified Codebase Facts (grounded 2026-06-01)
- Helpers exist in `src/dashboardGuard.js`: `isLocalRequest` (L95-106), `hasValidApiKey` (L120-124, async → DB `validateApiKey`), `hasValidCliToken` (L16-19, async → cached machine-id), `loadSettings` (L145-151, wraps `getSettings()` with try/catch). **NONE are exported** — only `__test__` (L167-173) exports a different subset. → must add named exports for the 3 botGuard needs.
- `proxy()` (L175) first statement is `const { pathname } = request.nextUrl`. botGuard call goes **before** it.
- **Runtime: no new constraint.** No `export const runtime` in proxy/dashboardGuard and no `nodeMiddleware` config, yet `proxy()` already performs async sqlite I/O in production (`loadSettings`→`getSettings`, `hasValidApiKey`→`validateApiKey`). Whatever runtime serves those today serves botGuard's identical reads. (Prior plan claim of "Node runtime" was unverified — corrected to "inherits existing proxy DB behavior".)

## Architecture

```
src/lib/security/botGuard.js
  botGuard(request):
    if isStaticAsset(pathname) → null              // FIRST: 142 public/ assets hit proxy; skip classify+rate
    if method===OPTIONS || HEAD → null             // CORS preflight not rate-counted
    settings = getCachedBotSettings()              // ~5s TTL module cache (see below)
    if !settings.enabled → null
    if isLocalRequest(request) → null              // loopback exempt (dashboardGuard export)
    ip = getTrustedClientIp(request, {trustProxy: settings.trustProxy})
    ua = request.headers.get("user-agent")

    // 1. probe paths (always, even keyed — probes are never legit)
    cls = classifyRequest({pathname, userAgent: ua, opts})
    if cls.block && cls.kind==="probe" → logBlocked; 403
    if cls.block (bad-ua/ai-crawler):
       hasKey = await hasValidApiKey(request) || await hasValidCliToken(request)  // lazy: only when about to block
       if !hasKey → logBlocked; 403                // valid key exempt from UA/crawler

    // 2. rate limit
    if isPublicLlmApi(pathname):                    // /v1
       keyId = await validApiKeyId(request)         // null if none/invalid (hash of key, never raw)
       if keyId: check(`v1:key:${keyId}`, {limit:keyLimit, windowMs:keyWindowMs})   // per-KEY, not IP
       else:     check(`v1:ip:${ip}`,    {limit:llmRateLimit.limit, windowMs})
    else:
       if await isAuthenticated(request) → skip     // authed first-party browser exempt from global limit
       else check(`g:${ip}`, rateLimit)
    if !allowed → logBlocked; 429 + Retry-After (SSE-safe envelope for /v1)

    return null
```

**Per-key `/v1` keying** fixes the shared-NAT false positive: a team behind one office IP each get their own `v1:key:${keyId}` bucket; keyless callers fall back to per-IP. Needs a key→id (or key-hash) lookup — extend `validateApiKey` to return an id, or hash the key for the bucket name. **Never put the raw key in the bucket string or audit log.**

**Settings cache (not YAGNI — hottest path):** the existing `/v1` path does NOT read settings today (only `canAccessPublicLlmApi`). botGuard would add a fresh sqlite read per proxied LLM request → add a module-level `getCachedBotSettings()` with ~5s TTL wrapping `getSettings()`.

**SSE-safe 429:** `/v1` clients (Anthropic/OpenAI SDKs) expect a JSON error envelope + `Retry-After`; return `{ error: { message, type:"rate_limit" } }` + `Retry-After` header, not a bare `{error:"..."}` that hangs stream parsers.

**Happy-path cost:** static asset / OPTIONS → 1 check, return. Normal authed page → cached settings + cheap classify + auth check (skips rate). `/v1` with key → cached settings + key-id lookup + 1 Map check. Key validators lazy — only on imminent block or `/v1`.

Wire in `dashboardGuard.proxy()` as first statement:
```js
export async function proxy(request) {
  const botBlock = await botGuard(request);
  if (botBlock) return botBlock;
  const { pathname } = request.nextUrl;
  ... // existing logic unchanged
}
```

**Reuse, don't duplicate:** add named exports `export { isLocalRequest, hasValidApiKey, hasValidCliToken, isAuthenticated, isPublicLlmApi }` to `dashboardGuard.js` (currently internal); botGuard imports them. `getCachedBotSettings()` wraps `getSettings()`.

## Related Code Files
- Create: `src/lib/security/botGuard.js`
- Modify: `src/dashboardGuard.js` (add named exports for reused helpers; call botGuard first in `proxy()`)
- Modify: `src/lib/db/repos/apiKeyRepo.js` (or wherever `validateApiKey` lives) — return a key id/hash for per-key bucketing (scout exact module in cook)
- Create: `tests/security/botGuard.test.js`
- Read for context: `src/dashboardGuard.js:16-19,95-165,175` (helpers + isAuthenticated + isPublicLlmApi + proxy entry), `src/proxy.js:3-4` (matcher), `src/lib/db/repos/settingsRepo.js` (getSettings)

## Implementation Steps (TDD)
1. **Write tests first** `tests/security/botGuard.test.js` (mock request + settings + key validator):
   - static asset (`/providers/x.png`) → `null`, no rate-limit counted (asset flood does not trip limit)
   - `OPTIONS` preflight → `null` (not counted)
   - disabled setting → `null` (pass)
   - loopback request → `null` even for probe path
   - probe path from remote → 403, audit called
   - bad-UA remote no key → 403; bad-UA WITH valid key → pass
   - ai-crawler no key → 403; toggle off → pass
   - authed browser (valid JWT) on dashboard route → NOT counted against global limit (no 429 under heavy first-party use)
   - `/v1` keyless rate trip → 429 with `Retry-After` + SSE-safe error envelope
   - `/v1` per-key bucketing: two keys from SAME ip independent; one key from TWO ips shares its bucket
   - `/v1` with valid key uses keyLimit tier (higher) — allowed where keyless would block
2. Implement `botGuard.js` reusing dashboardGuard helpers.
3. Wire first-check into `proxy()`.
4. Add regression test: existing dashboardGuard auth tests still green (botGuard returns null for normal authed requests).
5. Run full suite → green.

## Success Criteria
- [ ] All botGuard tests green + existing dashboardGuard/auth tests green (no regression)
- [ ] botGuard is first check in `proxy()`; returns null on the happy path
- [ ] Static assets bypass rate limit (no false-positive on normal dashboard browsing)
- [ ] Exemptions correct: loopback + valid-key behave per spec
- [ ] 3 helpers named-exported from dashboardGuard; botGuard imports (no duplicated auth logic)
- [ ] Blocks emit audit log
- [ ] `npm run build` passes (middleware bundles in standalone)

## Risk Assessment
- **Middleware runtime**: no new constraint — botGuard does the same async sqlite reads (`getSettings`, `validateApiKey`) that `proxy()` already performs in production. No `export const runtime` exists today; do not add one. Confirm only that `npm run build` + a remote-request smoke test still pass.
- **Static-asset rate-limit false positive** (matcher catches 142 `public/` files) → mitigated by `isStaticAsset()` first-exit (Phase 1). Without it, ~3 dashboard loads trip the 120/min default. Covered by test.
- **Per-request settings read cost** → `getSettings` already read by proxy downstream; key validators called lazily (only on imminent block / `/v1`). Add TTL~5s settings cache only if profiling shows cost (YAGNI).
- **False-positive lockout of operator** → loopback + valid-key exemptions + global toggle; audit log to diagnose; conservative default limits.
- **Breaking `/v1` clients** → key-aware tier + bad-UA/crawler exemption for valid keys covers legit SDK traffic.
