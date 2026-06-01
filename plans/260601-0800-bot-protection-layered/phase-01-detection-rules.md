---
phase: 1
title: "Detection Rules"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Detection Rules

## Overview

Pure, stateless request-classification rules: probe-path blocklist, bad-UA detection, AI-crawler UA detection. Plus shared `getClientIp` extraction (DRY with `loginLimiter`). No state, no middleware wiring yet — fully unit-testable in isolation.

## Requirements
- Functional: given a `Request`-like object (pathname + headers), classify as `{ block: bool, reason: string|null, kind: "probe"|"bad-ua"|"ai-crawler"|null }`.
- Functional: detect empty/missing User-Agent and known scanner UAs (sqlmap, nikto, masscan, zgrab, nmap, curl-as-attacker is NOT blocked — too broad), and probe paths (`/.env`, `/.git`, `/wp-login.php`, `/wp-admin`, `/phpmyadmin`, `/.aws/`, `/config.json`, `/vendor/`, `/xmlrpc.php`).
- Functional: AI-crawler list separate (GPTBot, CCBot, ClaudeBot, Google-Extended, anthropic-ai, PerplexityBot, Bytespider) — toggled independently.
- Non-functional: O(1)/cheap regex; no allocations per request beyond small; pure functions.

## Architecture

```
src/lib/security/
  clientIp.js      ← extracted getClientIp (loginLimiter re-imports)
  botRules.js      ← probe paths, bad-UA regex, ai-crawler regex, classifyRequest()
```

`classifyRequest({ pathname, userAgent, opts })` where `opts = { blockProbePaths, blockBadUA, blockAiCrawlers }` (from settings). Returns first match. Order: probe → bad-UA → ai-crawler.

**DRY:** move `getClientIp` from `src/lib/auth/loginLimiter.js` → `src/lib/security/clientIp.js`; loginLimiter and login route re-import. Verify both call sites still resolve.

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
   - probe path `/.env` → `{block:true, kind:"probe"}` when `blockProbePaths`
   - normal path `/dashboard` → `{block:false}`
   - empty UA → bad-ua when `blockBadUA`
   - `sqlmap/1.0` UA → bad-ua
   - `GPTBot` UA → ai-crawler when `blockAiCrawlers`, but NOT when toggle off
   - all toggles off → never blocks
3. Implement `clientIp.js` (move logic verbatim from loginLimiter).
4. Re-export from `loginLimiter.js`: `export { getClientIp } from "../security/clientIp.js";` — confirm login route + limiter still pass.
5. Implement `botRules.js`: constant arrays/regex + `classifyRequest`.
6. Run tests → green.

## Success Criteria
- [ ] All Phase-1 tests green
- [ ] `getClientIp` single source of truth; login route + loginLimiter still resolve (no broken import)
- [ ] `classifyRequest` pure, respects all 3 toggles, correct precedence
- [ ] Files <200 lines

## Risk Assessment
- **Over-broad UA block** (e.g. blocking `curl`/`python-requests` breaks legit API clients) → keep bad-UA list to known *malicious scanners* only; legit-but-generic UAs NOT blocked. Valid-key exemption (Phase 4) is the safety net.
- **Moving getClientIp breaks login** → re-export keeps old import path working; test both.
