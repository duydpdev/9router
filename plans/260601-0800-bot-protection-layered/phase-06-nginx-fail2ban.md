---
phase: 6
title: "Nginx & Fail2ban"
status: pending
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

- fail2ban `failregex` must match exact JSON shape from Phase-3 `auditLog.js` — **lock the log format in Phase 3 first**, then write regex against real sample lines.
- Document log path resolution: pm2 cwd `workspace/9router/logs/`, docker volume mount, npx `~/.9router/logs` (confirm actual). Keep consistent with Phase 3 decision.
- README deploy section: link `docs/bot-protection.md`.

## Related Code Files
- Create: `deploy/nginx/9router.conf.example`
- Create: `deploy/fail2ban/9router.filter`
- Create: `deploy/fail2ban/9router.jail`
- Create: `docs/bot-protection.md`
- Modify: `README.md` (deploy section link) + optionally `GUIDE.md`
- Read for context: Phase-3 `auditLog.js` output format, `deploy.sh` (server paths: `workspace/9router`)

## Implementation Steps
1. Capture a real audit-log sample line (from Phase 3 / Phase 4 tests).
2. Write `9router.filter` `failregex` against that exact line; validate with `fail2ban-regex` mentally / note the test command.
3. Write `9router.jail` (maxretry, findtime, bantime, banaction).
4. Write `9router.conf.example` nginx block (rate zone, conn limit, UA map, probe deny → 444).
5. Write `docs/bot-protection.md`: architecture diagram, two-layer split, install steps, log path per mode, logrotate, tuning defaults, single-instance caveat.
6. Link from README.

## Success Criteria
- [ ] Templates copy-paste ready, commented, no secrets
- [ ] fail2ban `failregex` matches actual Phase-3 audit line (verified against sample)
- [ ] Docs cover all 3 deploy modes + log path + logrotate + caveats
- [ ] README links the guide

## Risk Assessment
- **Audit-log format drift** between Phase 3 and the regex → write regex against captured real line; if format changes, update filter (note the coupling in docs).
- **Operators without nginx/fail2ban** → clearly marked optional; app layer already protects. No package dependency on these files.
- **Wrong log path per deploy mode** → enumerate each mode explicitly; cross-check with Phase 3 path decision + `deploy.sh`.

## Out of Scope
- No automatic fail2ban install/config from the app — operator runs it manually per docs.
- No geo-IP / Cloudflare WAF integration (separate future work).
