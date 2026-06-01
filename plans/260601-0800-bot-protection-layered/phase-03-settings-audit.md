---
phase: 3
title: "Settings & Audit"
status: pending
priority: P1
effort: "2h"
dependencies: []
---

# Phase 3: Settings & Audit

## Overview

Add `botProtection` settings block (defaults ON) to `settingsRepo` and a structured audit-log emitter for blocked events (consumed by fail2ban in Phase 6). Independent of Phases 1/2.

## Requirements
- Functional: `DEFAULT_SETTINGS.botProtection` with sane defaults; `mergeWithDefaults` backward-compat for nested object (existing users with no key get full defaults).
- Functional: audit emitter writes one structured line per block: timestamp, client IP, reason/kind, path, UA — to a stable location fail2ban can tail.
- Non-functional: nested-object merge must not wipe partial user overrides; cheap; no throw on log failure.

## Architecture

`botProtection` default shape:
```js
botProtection: {
  enabled: true,
  blockProbePaths: true,
  blockBadUA: true,
  blockAiCrawlers: true,
  rateLimit: { enabled: true, limit: 120, windowMs: 60000 },        // 120 req/min/IP
  llmRateLimit: { enabled: true, limit: 60, windowMs: 60000,        // /v1 per-IP
                  keyLimit: 600 },                                   // higher tier when valid key
}
```

`mergeWithDefaults` currently shallow-merges top-level keys. Nested `botProtection` needs a deep-merge for that one key so a user who set `{enabled:false}` keeps other sub-defaults. Add targeted nested merge (KISS — only for botProtection, not generic deep merge).

**Audit log:** `src/lib/security/auditLog.js` → `logBlocked({ ip, kind, reason, path, ua })`. Writes JSON line. Location: reuse existing app logger if present; else append to `logs/bot-blocked.log` relative to cwd (matches pm2 cwd). Check for existing logger first (scout `src/lib` for logging util) — DRY.

## Related Code Files
- Modify: `src/lib/db/repos/settingsRepo.js` (add default + nested merge for `botProtection`)
- Create: `src/lib/security/auditLog.js`
- Create: `tests/security/settingsBotProtection.test.js`
- Create: `tests/security/auditLog.test.js`
- Read for context: existing logger under `src/lib` (grep `console.log`/logger util), `next.config.mjs` (logs dir excluded from watcher → `logs/` is the convention)

## Implementation Steps (TDD)
1. **Write tests first**:
   - `getSettings()` on empty DB → `botProtection` fully populated with defaults
   - raw settings with `botProtection:{enabled:false}` → merged keeps `blockProbePaths:true` etc. (nested merge proof)
   - `logBlocked` writes parseable JSON line with all fields; does not throw on write error
2. Scout for existing logger util; decide reuse vs new file appender.
3. Add `botProtection` to `DEFAULT_SETTINGS` + nested merge branch in `mergeWithDefaults`.
4. Implement `auditLog.js`.
5. Run → green.

## Success Criteria
- [ ] Defaults present + nested merge preserves partial overrides (test-proven)
- [ ] Audit line is single-line JSON, fail2ban-parseable, never throws
- [ ] Existing settings tests still green (no regression to shallow keys)

## Risk Assessment
- **Nested merge breaks existing shallow merge** → scope deep-merge to `botProtection` key only; cover existing keys with regression test.
- **Log path differs across deploy modes (npx/docker/pm2)** → resolve relative to `process.cwd()`; document in Phase 6 so fail2ban/docker volume points right.
- **Disk fill from audit log** → document logrotate in Phase 6; out of code scope.
