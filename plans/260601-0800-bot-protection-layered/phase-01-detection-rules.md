---
phase: 1
title: "Detection Rules"
status: completed
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Detection Rules

## Overview

Pure, stateless request-classification rules: static-asset exemption, probe-path blocklist, bad-UA detection, AI-crawler UA detection. Plus shared `getClientIp` extraction (DRY with `loginLimiter`). No state, no middleware wiring yet — fully unit-testable in isolation.

## Verified Codebase Facts (grounded 2026-06-01)
- `getClientIp` lives at `src/lib/auth/loginLimiter.js:48-52`; reads `x-forwarded-for` first hop → `x-real-ip` → `"unknown"`. **Only two importers**: loginLimiter itself + `src/app/api/auth/login/route.js:10`. Safe to move + re-export.
- **Matcher overshoot (critical):** `src/proxy.js:3-4` matcher = `/((?!_next/static|_next/image|favicon\.ico).*)` — every `public/` asset (142 files: 130+ provider icons, svgs, `sw.js`) hits `proxy()`. A single dashboard render fans out dozens of icon GETs. Without a static-asset exemption the per-IP rate limit (Phase 2/4) trips on normal browsing. → `isStaticAsset()` added here, wired as first exempt check in Phase 4.

## Requirements
- Functional: given a `Request`-like object (pathname + headers), classify as `{ block: bool, reason: string|null, kind: "probe"|"bad-ua"|"ai-crawler"|null }`.
- Functional: `isStaticAsset(pathname)` → true for asset extensions (`.png .jpg .jpeg .gif .svg .webp .ico .css .js .map .woff .woff2 .ttf .eot`) + `sw.js`. **`.json` is NOT a static asset** (kept out so JSON API/config fetches still flow through classification + rate limiting, not silently exempted).
- Functional: detect empty/missing User-Agent and known scanner UAs (sqlmap, nikto, masscan, zgrab, nmap; curl/python-requests NOT blocked — too broad), and probe paths.
- **Probe match semantics (explicit):** each probe pattern is an **anchored prefix** match on the normalized pathname (`pathname === p || pathname.startsWith(p + "/")` for dir-like, exact for file-like) — **never substring** (so `/api/vendors` does NOT match `/vendor`, `/dashboard/x` does NOT match a probe). Probe list: `/.env`, `/.git`, `/wp-login.php`, `/wp-admin`, `/phpmyadmin`, `/.aws`, `/vendor`, `/xmlrpc.php`. **`/config.json` REMOVED** from probes — collides with plausible app/PWA assets; rely on `/.env`/`/.git` etc. for scanner signal instead (grep confirmed no legit `/config.json` route, but the false-positive + fail2ban-strike risk outweighs the marginal detection value).
- Functional: AI-crawler list separate (GPTBot, CCBot, ClaudeBot, Google-Extended, anthropic-ai, PerplexityBot, Bytespider) — toggled independently.
- Non-functional: O(1)/cheap regex; no allocations per request beyond small; pure functions.

## Architecture

```
src/lib/security/
  clientIp.js      ← getClientIp (extracted, loginLimiter re-imports, UNCHANGED behavior)
                     + getTrustedClientIp(request, {trustProxy})  ← NEW, for botGuard only
  botRules.js      ← isStaticAsset(), probe paths, bad-UA regex, ai-crawler regex, classifyRequest()
```

**`getTrustedClientIp(request, { trustProxy })`** (separate from `getClientIp` to avoid changing the done login path):
- `trustProxy === true` → behind a reverse proxy that sets XFF: return `x-forwarded-for` first hop (current `getClientIp` logic).
- `trustProxy === false` (direct-exposed npx/docker default) → XFF is client-controlled and unsafe; the IP-keyed rate limit becomes best-effort and fail2ban must NOT ban off the app log (Phase 6). Still derive an IP from XFF for bucketing (no socket IP available in Next middleware) but the **value is untrusted** — documented. Stateless probe/UA blocks are unaffected (don't depend on IP).

`classifyRequest({ pathname, userAgent, opts })` where `opts = { blockProbePaths, blockBadUA, blockAiCrawlers }` (from settings). Returns first match. Order: probe → bad-UA → ai-crawler. `isStaticAsset` is separate (caller short-circuits before classify+rate-limit).

**DRY:** move `getClientIp` from `src/lib/auth/loginLimiter.js:48-52` → `src/lib/security/clientIp.js`; loginLimiter re-exports (`export { getClientIp } from "../security/clientIp.js"`) so `login/route.js` import path stays intact. Verify both call sites still resolve.

## Related Code Files
- Create: `src/lib/security/clientIp.js`
- Create: `src/lib/security/botRules.js`
- Create: `tests/security/botRules.test.js`
- Create: `tests/security/clientIp.test.js`
- Modify: `src/lib/auth/loginLimiter.js` (re-export `getClientIp` from new module, keep backward-compat export)
- Read for context: `src/app/api/auth/login/route.js` (imports `getClientIp` from loginLimiter — must not break)

## Implementation Steps (TDD)
1. **Write tests first** `tests/security/clientIp.test.js`: xff first-hop wins, x-real-ip fallback, "unknown" fallback, trims whitespace.
2. **Write tests first** `tests/security/botRules.test.js`:
   - `isStaticAsset("/providers/foo.png")` → true; `isStaticAsset("/config.json")` → false; `isStaticAsset("/dashboard")` → false; `isStaticAsset("/sw.js")` → true
   - probe path `/.env` → `{block:true, kind:"probe"}` when `blockProbePaths`
   - **over-match guard**: `/api/vendors` → `{block:false}` (does NOT match `/vendor`); `/config.json` → `{block:false}` (removed from probes)
   - normal path `/dashboard` → `{block:false}`
   - `getTrustedClientIp` with `trustProxy:true` → XFF first hop; with `trustProxy:false` → still parses XFF but caller treats as untrusted (assert it returns the value, behavior documented)
   - empty UA → bad-ua when `blockBadUA`
   - `sqlmap/1.0` UA → bad-ua
   - `GPTBot` UA → ai-crawler when `blockAiCrawlers`, but NOT when toggle off
   - all toggles off → never blocks
3. Implement `clientIp.js` (move logic verbatim from loginLimiter).
4. Re-export from `loginLimiter.js`: `export { getClientIp } from "../security/clientIp.js";` — confirm login route + limiter still pass.
5. Implement `botRules.js`: `isStaticAsset` + constant arrays/regex + `classifyRequest`.
6. Run tests → green.

## Success Criteria
- [ ] All Phase-1 tests green
- [ ] `isStaticAsset` true for asset exts, false for `.json` (probe-safe) and page routes
- [ ] `getClientIp` single source of truth; login route + loginLimiter still resolve (no broken import)
- [ ] `classifyRequest` pure, respects all 3 toggles, correct precedence
- [ ] Files <200 lines

## Risk Assessment
- **Over-broad UA block** (e.g. blocking `curl`/`python-requests` breaks legit API clients) → keep bad-UA list to known *malicious scanners* only; legit-but-generic UAs NOT blocked. Valid-key exemption (Phase 4) is the safety net.
- **Moving getClientIp breaks login** → re-export keeps old import path working; test both.
