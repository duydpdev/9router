---
phase: 3
title: "Settings & Audit"
status: completed
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

`botProtection` default shape (limits = starting values, user-tunable per brainstorm):
```js
botProtection: {
  enabled: true,
  trustProxy: false,            // honor x-forwarded-for ONLY when true (behind nginx). Default false = direct-exposed.
  blockProbePaths: true,
  blockBadUA: true,
  blockAiCrawlers: true,
  // global per-IP for dashboard/app routes. Authed (valid JWT) browser traffic exempt — see Phase 4.
  rateLimit: { enabled: true, limit: 300, windowMs: 60000 },        // 300 req/min/IP (raised: asset+poll fan-out)
  // /v1 LLM proxy: keyed by API key when present (NOT ip) so teams behind one NAT don't share a bucket.
  llmRateLimit: { enabled: true, limit: 120, windowMs: 60000,       // keyless /v1 per-IP
                  keyLimit: 1200, keyWindowMs: 60000 },              // per-KEY tier (agentic clients burst)
}
```

> `keyLimit` is applied **per API key** (`v1:key:${keyId}`), not per IP — fixes shared-NAT false-positives for agentic clients (Claude Code / Cursor parallel tool calls). See Phase 4. Defaults flagged for user confirmation (core-product endpoint).

## Verified Codebase Facts (grounded 2026-06-01)
- `src/lib/db/repos/settingsRepo.js`: `DEFAULT_SETTINGS` (line 6) = **33 flat scalar top-level keys** (rtkEnabled, cavemanEnabled, requireLogin, authMode, …). **No nested object exists today** — `botProtection` would be the first. `mergeWithDefaults` (line 48) is a **shallow spread** (`{...DEFAULT_SETTINGS, ...raw}`) → a partial user `botProtection:{enabled:false}` would clobber all sibling sub-keys. Nested merge IS required.
- Write API is `updateSettings(body)` (line 72), NOT `saveSettings`. Persisted as JSON blob in sqlite `settings.data` (id=1).
- **No reusable logger exists.** MITM logger (`src/mitm/logger.js`) + SSE logger (`src/sse/utils/logger.js`) are separate, console-only. Phase 3 creates a new file appender — confirmed, no DRY target.
- Data dir: `getDataDir()` at `src/lib/dataDir.js:14-29` → `process.env.DATA_DIR || ~/.9router`, auto-mkdir, silent fallback on EACCES. MITM already writes under `${DATA_DIR}/logs/mitm/`. Cross-deploy consistent (npx/docker/pm2).

`mergeWithDefaults` shallow-merges top-level keys. Nested `botProtection` needs a deep-merge for that one key so a user who set `{enabled:false}` keeps other sub-defaults. Add targeted nested merge (KISS — only for botProtection, not generic deep merge).

**Audit log:** `src/lib/security/auditLog.js` → `logBlocked({ ip, kind, reason, path, ua })`. Location: `${getDataDir()}/logs/bot-blocked.log` (import `getDataDir` from `src/lib/dataDir.js`). Append-only, try/catch, never throws.

**Log-injection hardening (mandatory — `path` and `ua` are attacker-controlled):**
- Write exactly `fs.appendFile(JSON.stringify(record) + "\n")`. `JSON.stringify` escapes embedded `\n`/`\r` to `\\n`/`\\r` inside string values → one physical line per event, no forged second line.
- **Truncate `ua` and `path` to 256 chars** before logging (defeats 1 MB-UA log-amplification / disk-fill).
- Never string-interpolate `ua`/`path` into `reason` or a template — only as `JSON.stringify` values.
- **Lock JSON shape here**; Phase 6 `failregex` uses named field captures (order-independent), not positional.

## Related Code Files
- Modify: `src/lib/db/repos/settingsRepo.js` (add `botProtection` default at L6 region + nested merge branch in `mergeWithDefaults` L48)
- Create: `src/lib/security/auditLog.js`
- Create: `tests/security/settingsBotProtection.test.js`
- Create: `tests/security/auditLog.test.js`
- Read for context: `src/lib/dataDir.js` (`getDataDir`), `src/mitm/logger.js` (existing `${DATA_DIR}/logs/` convention)

## Implementation Steps (TDD)
1. **Write tests first**:
   - `getSettings()` on empty DB → `botProtection` fully populated with defaults
   - raw settings with `botProtection:{enabled:false}` → merged keeps `blockProbePaths:true` etc. (nested merge proof)
   - existing flat key (e.g. `rtkEnabled:false`) still merges correctly (shallow-key regression)
   - `logBlocked` writes parseable single-line JSON with all fields; does not throw on write error
   - **injection test**: `ua` / `path` containing `\n`, `\r`, and `}{"ip":"1.2.3.4"` → file gains exactly ONE line that parses to ONE object with the literal malicious string preserved as the `ua`/`path` value (no forged second line)
   - **truncation test**: 5000-char `ua` → stored value ≤ 256 chars
2. Add `botProtection` to `DEFAULT_SETTINGS` + nested merge branch (botProtection only) in `mergeWithDefaults`.
3. Implement `auditLog.js` using `getDataDir()`; lock JSON shape.
4. Run → green.

## Success Criteria
- [ ] Defaults present + nested merge preserves partial overrides (test-proven)
- [ ] Audit line is single-line JSON, fail2ban-parseable, never throws
- [ ] Existing settings tests still green (no regression to shallow keys)

## Risk Assessment
- **Nested merge breaks existing shallow merge** → scope deep-merge to `botProtection` key only; cover existing flat keys with regression test.
- **Log path differs across deploy modes (npx/docker/pm2)** → resolved by `getDataDir()` (single source, already used by MITM); docker volume `/app/data` ⇒ `/app/data/logs/bot-blocked.log`. Document the resolved path per mode in Phase 6.
- **Disk fill from audit log** → document logrotate in Phase 6; out of code scope.
