---
title: "Bot Protection (Layered: App Middleware + Nginx Booster)"
description: "Layered bot defense — app middleware floor (ships to every deploy mode) + optional nginx/fail2ban booster that reuses existing IP ban. TDD per phase."
status: completed
priority: P2
branch: "feat/implement-sercurity"
tags: [security, middleware, bot-protection]
blockedBy: []
blocks: []
created: "2026-06-01T01:19:40.761Z"
createdBy: "ck:plan"
source: skill
---

# Bot Protection (Layered: App Middleware + Nginx Booster)

## Overview

Add layered bot defense to 9router. **App middleware = mandatory floor** (works in npx/docker/vps — the only enforceable layer in the distributed package). **Nginx + fail2ban = optional booster** shipped as templates + docs that close the loop with the operator's existing nginx IP ban.

Single chokepoint already exists: `proxy()` in `src/dashboardGuard.js` (matcher catches all routes). Bot guard runs as **first check** there, before auth.

Reuses proven in-memory `Map`+TTL pattern from `src/lib/auth/loginLimiter.js` and its `getClientIp`. **Login brute-force is already handled** by that limiter — out of scope here.

Design source: `plans/reports/brainstorm-2026-06-01-bot-protection.md` (Approach C, in-memory store, defaults ON).

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Detection Rules](./phase-01-detection-rules.md) | ✅ Complete |
| 2 | [Rate Limiter](./phase-02-rate-limiter.md) | ✅ Complete |
| 3 | [Settings & Audit](./phase-03-settings-audit.md) | ✅ Complete |
| 4 | [Middleware Wiring](./phase-04-middleware-wiring.md) | ✅ Complete |
| 5 | [Crawler Control](./phase-05-crawler-control.md) | ✅ Complete |
| 6 | [Nginx & Fail2ban](./phase-06-nginx-fail2ban.md) | ✅ Complete |

> **Implemented 2026-06-01.** 61 unit tests green (9 files). Code review: 6/7 criteria pass + C1 (unguarded botGuard → fail-all-on-DB-error) fixed by fail-open try/catch. Run tests: `bash tests/run-security-tests.sh unit/security-*.test.js`.

## Key Decisions (from brainstorm)

- **Architecture:** Hybrid (app floor + nginx booster).
- **State:** in-memory `Map` + TTL. Single-instance only; multi-instance = YAGNI, documented.
- **Defaults:** ON, all toggleable via `settings.botProtection`.
- **Exempt always:** loopback; valid API key / CLI token get higher rate tier + skip UA/crawler block.
- **Client IP:** reuse `getClientIp` (x-forwarded-for from nginx).
- **NOT in scope:** captcha/JS challenge, Redis/shared store, geo-IP, ML scoring, login brute-force (already done).

## Grounding & Corrections (deep-mode codebase verification, 2026-06-01)

- **Login throttle = already enforced** — `src/lib/auth/loginLimiter.js` (5 fails → 30s/2m/10m/30m escalating lock, 429+Retry-After) called in `src/app/api/auth/login/route.js:36-101`. Brainstorm mechanism #4 superseded; correctly dropped.
- **Static-asset false-positive (NEW, plan-missed)** — middleware matcher (`src/proxy.js:3`) catches all but `_next/static|_next/image|favicon.ico`; the 142 `public/` assets hit `proxy()`. Without exemption the 120/min global limit trips on normal browsing. → `isStaticAsset()` first-exit added (Phase 1+4).
- **Runtime = no new constraint** — `proxy()` already does async sqlite I/O in prod; no `export const runtime`. botGuard inherits identical path. Prior "Node runtime" claim corrected.
- **dashboardGuard helpers internal** — `isLocalRequest`/`hasValidApiKey`/`hasValidCliToken` exist but unexported → Phase 4 adds named exports for DRY reuse.
- **Audit log path** — `${getDataDir()}/logs/bot-blocked.log` (`src/lib/dataDir.js`), not cwd. No reusable logger exists; Phase 3 creates appender. Cross-deploy: docker `/app/data/logs/`, npx/pm2 `~/.9router/logs/`.
- **Settings shape** — `DEFAULT_SETTINGS` = 33 flat scalar keys; `mergeWithDefaults` is shallow spread. `botProtection` is the first nested object → targeted nested merge required. Write API is `updateSettings` (not `saveSettings`).
- **Settings UI** — `EndpointPageClient.js` (1510 lines), mirror RTK toggle L1023; extract bot section to child component (modularization). Dashboard layout `(dashboard)/layout.js` exists, no metadata export yet.
- **Test runner = Vitest v4** (`tests/vitest.config.js`, glob `**/*.test.js`, `npm test`).
- **Ship script = `start.sh` (docker)**; no `deploy.sh`.

## Red-Team Resolutions (deep-mode adversarial pass, 2026-06-01)

| # | Finding (sev) | Resolution | Phase |
|---|---|---|---|
| 1 | XFF first-hop spoofable in direct-exposed mode → rate-limit bypass + fail2ban victim-framing (HIGH) | `trustProxy` setting (default false); `getTrustedClientIp` separate from login's `getClientIp`; fail2ban bans off nginx log unless trustProxy; stateless probe/UA blocks unaffected | 1,3,4,6 |
| 2 | `/v1` 60/min IP-keyed false-positives agentic clients + shared NAT (HIGH) | Key `/v1` by API-key-id (not IP) when present; raise defaults (keyless 120, per-key 1200); authed browser exempt from global limit | 3,4 |
| 3 | Unbounded distinct-key Map → OOM/event-loop stall (HIGH) | `MAX_KEYS` cap + insertion-order eviction; sweep always cheap | 2 |
| 4 | Probe over-match / `/config.json` collision (MED) | Anchored-prefix match (never substring); drop `/config.json`; over-match tests | 1 |
| 5 | New sqlite read per `/v1` (MED) | `getCachedBotSettings()` ~5s TTL | 4 |
| 6 | Log injection via UA/path → forged fail2ban bans + disk fill (HIGH) | `JSON.stringify`+`\n` single-line invariant; truncate ua/path 256; injection test; named-capture anchored failregex; executable `fail2ban-regex` check | 3,6 |
| 7 | SSE clients break on bare 429; OPTIONS counted; getClientIp divergence (MED/LOW) | SSE-safe error envelope on `/v1`; exempt OPTIONS/HEAD; keep login `getClientIp` untouched | 4,1 |

## Dependencies

- Phases 1,2,3 = independent modules. Phase 4 wires them into middleware (depends 1,2,3). Phase 5 crawler control (depends 3 for toggle). Phase 6 docs/templates (depends 3 for audit-log format).
- No cross-plan dependencies detected (scanned unfinished plans 2026-06-01).
