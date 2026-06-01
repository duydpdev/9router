---
title: "Bot Protection (Layered: App Middleware + Nginx Booster)"
description: "Layered bot defense — app middleware floor (ships to every deploy mode) + optional nginx/fail2ban booster that reuses existing IP ban. TDD per phase."
status: pending
priority: P2
branch: "feature/dylan-improve"
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
| 1 | [Detection Rules](./phase-01-detection-rules.md) | Pending |
| 2 | [Rate Limiter](./phase-02-rate-limiter.md) | Pending |
| 3 | [Settings & Audit](./phase-03-settings-audit.md) | Pending |
| 4 | [Middleware Wiring](./phase-04-middleware-wiring.md) | Pending |
| 5 | [Crawler Control](./phase-05-crawler-control.md) | Pending |
| 6 | [Nginx & Fail2ban](./phase-06-nginx-fail2ban.md) | Pending |

## Key Decisions (from brainstorm)

- **Architecture:** Hybrid (app floor + nginx booster).
- **State:** in-memory `Map` + TTL. Single-instance only; multi-instance = YAGNI, documented.
- **Defaults:** ON, all toggleable via `settings.botProtection`.
- **Exempt always:** loopback; valid API key / CLI token get higher rate tier + skip UA/crawler block.
- **Client IP:** reuse `getClientIp` (x-forwarded-for from nginx).
- **NOT in scope:** captcha/JS challenge, Redis/shared store, geo-IP, ML scoring, login brute-force (already done).

## Dependencies

- Phases 1,2,3 = independent modules. Phase 4 wires them into middleware (depends 1,2,3). Phase 5 crawler control (depends 3 for toggle). Phase 6 docs/templates (depends 3 for audit-log format).
- No cross-plan dependencies detected (scanned unfinished plans 2026-06-01).
