# Brainstorm — Bot Protection (Approach C: Hybrid)

Date: 2026-06-01 · Status: design approved, pending plan

## Problem

9router deployed publicly (Next.js standalone + pm2 behind nginx). Existing defense: nginx IP ban only. No app-level bot defense (no rate-limit, UA filter, robots, login throttle). Want layered bot protection shipped to **all** self-host users (npx + docker + vps).

Threats to stop (user-confirmed, all 4):
1. Vuln scanners probing `/api`, `/.env`, `/wp-*` etc.
2. Brute-force on `/login`.
3. Crawlers / AI scrapers indexing dashboard + landing.
4. Abuse of `/v1` LLM proxy.

## Hard constraint

Package ships as npx/docker/vps — **cannot control user nginx**. npx/docker users may have none.
→ **App-middleware layer = mandatory floor** (every deploy mode). **Nginx layer = optional booster** shipped as template + docs.

## Decisions (user-confirmed)

| Decision | Choice |
|---|---|
| Architecture | **C — Hybrid**: app floor + nginx/fail2ban booster, closes loop with existing nginx IP ban |
| Rate-limit state | **In-memory `Map` + TTL eviction** (KISS, no dep; resets on restart; single-instance OK) |
| Default posture | **ON with sane defaults**, all toggleable |
| Scope | Ship to all self-host users (feature in codebase + settings UI) |
| Layers | Both: nginx coarse + app fine |

## Chokepoint

Single edge already exists: `proxy()` in `src/dashboardGuard.js` (matcher catches all routes except static). Bot guard runs as **first check** there, before auth. No new edge layer.

## Architecture

```
request
  └─[nginx booster: limit_req, conn cap, bad-UA→444]   (optional, template)
       └─ pm2 fork → Next middleware proxy()
            └─ botGuard()  ← NEW, runs first
                 1. loopback/API-key exempt check
                 2. probe-path blocklist  → 403 + audit
                 3. bad-UA + AI-crawler block → 403 + audit
                 4. login throttle (/login, /api/auth/login)
                 5. rate limit (global per-IP, /v1 key-aware)
                 └─ pass → existing auth logic
       └─[fail2ban tails app audit log → iptables/nginx IP ban]  (optional)
```

## Mechanics

New module: `src/lib/security/botGuard.js` (+ split helpers if >200 lines: `botGuard/rateLimiter.js`, `botGuard/uaRules.js`, `botGuard/probePaths.js`, `botGuard/store.js`).

| Concern | Mechanism | Default |
|---|---|---|
| Vuln scanners | Probe-path blocklist → instant 403 + audit | ON |
| Brute-force /login | Per-IP attempt counter, temp lockout after N fails | ON |
| Crawlers/AI scrapers | `robots.txt` route + hard UA block (GPTBot/CCBot/ClaudeBot...) + `noindex` on dashboard layout | ON |
| /v1 abuse | Per-IP + per-key rate cap; valid key = higher tier | ON (moderate) |
| Generic flood | Sliding-window per-IP global rate limit | ON (moderate) |

- **Client IP:** `x-forwarded-for` (nginx-set), fallback request IP. Loopback always exempt.
- **Valid API key / CLI token:** exempt from crawler/UA block, higher rate tier (don't break legit proxy clients).
- **State:** in-memory `Map`, TTL eviction sweep. Limitation: multi-instance needs shared store → **YAGNI**, documented.
- **Audit:** blocked events → existing app log (structured) so fail2ban can escalate.

## Settings + UI

- New settings block `botProtection: { enabled, rateLimit, loginThrottle, blockBadUA, blockAiCrawlers, blockProbePaths }`.
- Toggle UI: new security section in dashboard settings.
- Defaults ON, loopback exempt always.

## Nginx booster (template, docs only — NOT enforced)

- `deploy/nginx/9router.conf.example`: `limit_req_zone` + `limit_req`, `limit_conn`, bad-UA `map`→444, probe-path→444.
- `deploy/fail2ban/9router.{conf,filter}`: tail app audit log → ban repeat 403/401 IPs via iptables.
- Documented in `docs/` + README deploy section.

## Expected output (acceptance)

- `botGuard()` wired first in `proxy()`; all 5 mechanisms work; loopback + valid-key exempt.
- `robots.txt` served; dashboard `noindex`.
- Settings toggles persist + respected at runtime.
- Nginx + fail2ban templates in `deploy/` + docs.
- Tests: probe→403, bad-UA→403, login throttle locks after N, rate-limit trips, loopback bypass, valid-key bypass.

## Scope boundary (OUT)

- No captcha / JS challenge (heavy, hurts self-host UX).
- No Redis / shared store (single-instance only now).
- No geo-IP blocking (separate concern).
- No ML/behavioral bot scoring.

## Risks

| Risk | Mitigation |
|---|---|
| False-positive blocks legit users | Loopback + valid-key exempt; moderate defaults; all toggleable; audit log to diagnose |
| In-memory state lost on pm2 restart | Acceptable for throttle/rate (short windows); fail2ban handles durable bans |
| Middleware per-request CPU cost | O(1) Map lookups + cheap regex; cheaper than serving the blocked request |
| Breaking existing API-key clients on /v1 | Key-aware tier, exempt from UA/crawler rules |

## Open questions

- Exact default thresholds (req/window, login attempts, lockout TTL)? → set in plan with conservative starting values, tune later.
- Probe-path + bad-UA + AI-crawler lists: maintain inline constant vs config file? → lean inline constant, KISS.
