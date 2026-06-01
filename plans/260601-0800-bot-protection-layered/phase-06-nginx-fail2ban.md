---
phase: 6
title: "Nginx & Fail2ban"
status: completed
priority: P2
effort: "2h"
dependencies: [3]
---

# Phase 6: Nginx & Fail2ban

## Overview

Optional booster layer shipped as **templates + docs** (not enforced by the package). Coarse nginx pre-filter + fail2ban jail that tails the Phase-3 audit log and escalates repeat offenders to an iptables/nginx IP ban — closing the loop with the operator's existing nginx IP ban.

## Requirements
- Functional: nginx example server block with `limit_req_zone`/`limit_req`, `limit_conn`, bad-UA `map`→444, probe-path→444.
- Functional: fail2ban filter regex matching the audit-log JSON line + jail config (findtime, maxretry, bantime, action=iptables/nginx).
- Functional: docs explaining install, log path per deploy mode, logrotate, and the app-layer/nginx-layer split.
- Non-functional: templates are copy-paste ready; no secrets; commented.

## Architecture

```
deploy/
  nginx/9router.conf.example      # server block: rate, conn, UA map, probe deny
  fail2ban/9router.filter          # failregex matching audit-log line
  fail2ban/9router.jail            # jail: logpath, maxretry, bantime, action
docs/bot-protection.md             # operator guide: layers, install, tuning, log path
```

- fail2ban `failregex` matches the Phase-3 audit JSON via **named field captures** (`"ip":"<HOST>"` extracted by field name, anchored `^`) — NOT positional/field-order dependent (a future object-key reorder must not silently break bans). Capture-by-name + `^` anchor also rejects attacker-injected mid-line forgery.
- **Ban-target safety (depends on `trustProxy`):** the IP in the app audit log is only trustworthy when `botProtection.trustProxy=true` (behind nginx that overwrites XFF). For **direct-exposed** deploys, a forged `X-Forwarded-For` lets an attacker write a victim IP into the log → fail2ban would ban the victim. **Therefore: docs MUST instruct fail2ban to ban off NGINX's own access/error log (real socket IP) — the app audit log is detection signal, not the ban source — UNLESS the operator runs behind a trusted proxy with `trustProxy=true`.** Mark the app-log jail "proxy-mode only."
- **Audit log path = `${getDataDir()}/logs/bot-blocked.log`** (Phase 3). Resolution per mode (verified): npx/pm2 → `~/.9router/logs/bot-blocked.log` (or `$DATA_DIR/logs/...`); docker → `/app/data/logs/bot-blocked.log` (volume `9router-data:/app/data`, see `start.sh`). fail2ban `logpath` + docker tailing must point here.
- README deploy section: link `docs/bot-protection.md`.

## Verified Codebase Facts (grounded 2026-06-01)
- **No `deploy.sh`.** Ship script is `start.sh` (docker entrypoint, cwd `/app/data`, volume `9router-data:/app/data`). pm2/VPS is documented in README but not scripted.
- `getDataDir()` (`src/lib/dataDir.js`) is the single path authority; `next.config.mjs:44` already excludes `logs/` from the webpack watcher.

## Related Code Files
- Create: `deploy/nginx/9router.conf.example`
- Create: `deploy/fail2ban/9router.filter`
- Create: `deploy/fail2ban/9router.jail`
- Create: `docs/bot-protection.md`
- Modify: `README.md` (deploy section link)
- Read for context: Phase-3 `auditLog.js` output format, `start.sh` (docker cwd `/app/data`, volume), `src/lib/dataDir.js` (path resolution)

## Implementation Steps
1. Capture a **real** audit-log sample line emitted by Phase-3 `auditLog.js` (generate a fixture from the actual appender, not hand-written) — `9router.filter` depends on Phase 4 producing real blocks too.
2. Write `9router.filter` `failregex` with named field captures (`<HOST>` from `"ip":"..."`, anchored `^`). **Validate executably:** `fail2ban-regex <sample-fixture> 9router.filter` must report 1 match; document this as a CI/check command (not "mentally").
3. Write `9router.jail` (maxretry, findtime, bantime, banaction). Default jail = **nginx-log-based** (real socket IP); ship a second commented "app-log jail (trustProxy=true only)" block.
4. Write `9router.conf.example` nginx block (rate zone, conn limit, UA map, probe deny → 444).
5. Write `docs/bot-protection.md`: architecture diagram, two-layer split, install steps, log path per mode, logrotate, tuning defaults, single-instance caveat.
6. Link from README.

## Success Criteria
- [ ] Templates copy-paste ready, commented, no secrets
- [ ] `failregex` uses named `<HOST>` capture, anchored `^`; passes `fail2ban-regex` against a real Phase-3 fixture line (executable, not mental)
- [ ] Default jail bans off nginx log (real IP); app-log jail clearly marked "trustProxy=true only"
- [ ] Docs cover all deploy modes + `${getDataDir()}/logs/` path + logrotate + the XFF/trustProxy ban-safety caveat
- [ ] README links the guide

## Risk Assessment
- **Audit-log format drift** between Phase 3 and the regex → write regex against captured real line; if format changes, update filter (note the coupling in docs).
- **Operators without nginx/fail2ban** → clearly marked optional; app layer already protects. No package dependency on these files.
- **Wrong log path per deploy mode** → all modes resolve via `getDataDir()`; enumerate npx/pm2 (`~/.9router/logs/`) vs docker (`/app/data/logs/`) explicitly; cross-check `start.sh` volume.

## Out of Scope
- No automatic fail2ban install/config from the app — operator runs it manually per docs.
- No geo-IP / Cloudflare WAF integration (separate future work).
