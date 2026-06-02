---
phase: 2
title: "Quick wins (dead code + logger)"
status: completed
priority: P1
effort: "2-3h"
dependencies: []
---

# Phase 2: Quick wins (dead code + logger)

## Overview
Two confirmed, low-risk debt items independent of measurement. Delete a dead
59KB duplicate file, and make the logger respect an env-controlled level so
production stops emitting DEBUG spam (385 raw `console.log` currently always
print).

## Requirements
- Functional: `page.new.js` gone; logger level controlled by `LOG_LEVEL` env.
- Non-functional: zero behavior change to dashboard; build + tests stay green.

## Architecture

### Item C1 — delete dead file
- `src/app/(dashboard)/dashboard/providers/[id]/page.new.js` (59KB, 1724 lines).
- Scout confirmed **zero imports** (`grep "page.new"` → no consumers; Next App
  Router only routes `page.js`, never `page.new.js`).
- Sibling `page.js` (1529 lines) is the live route — untouched.

### Item C2 — logger env-gate
- `src/sse/utils/logger.js:10` hardcodes `const LEVEL = LOG_LEVELS.DEBUG;` →
  every `debug()`/`info()` call always hits `console.log`.
- Change to read env once at module load:
  ```js
  const LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || "").toUpperCase()]
    ?? (process.env.NODE_ENV === "production" ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG);
  ```
- Prod default = **INFO** (validation decision): silences only DEBUG in prod,
  keeps INFO/WARN/ERROR. Preserves operational visibility for the 32
  `logger.info` calls in hot-path handlers (`auth`, `tokenRefresh`, `chat`,
  `embeddings`) that self-hosters use to debug. Dev stays DEBUG-verbose.
  `LOG_LEVEL=DEBUG` opt-in restores full verbosity (ties to README troubleshooting).
- **Verified safe:** the `[RTK] saved …` savings marker users rely on is emitted
  via raw `console.log` (`open-sse/handlers/chatCore.js:119`), NOT the logger —
  so this change does not silence it. The RTK e2e tests (opt-in `RUN_E2E=1`)
  parse that raw line and are unaffected.
- **Scope discipline:** do NOT mass-migrate the 385 raw `console.log` in this
  phase. That's a separate incremental cleanup. This phase only fixes the
  logger module + documents the env var. Migrating call sites is opt-in later.

## Related Code Files
- Delete: `src/app/(dashboard)/dashboard/providers/[id]/page.new.js`
- Modify: `src/sse/utils/logger.js` (LEVEL resolution only)
- Modify: `README.md` env-var table + `.env.example` — add `LOG_LEVEL` row
  (DEBUG|INFO|WARN|ERROR, default INFO in prod / DEBUG in dev)

## Implementation Steps
1. Re-confirm dead file: `grep -rn "page.new" src --include="*.js"` returns only
   the file's own path. If any consumer appears, STOP and report (don't delete).
2. `git rm` the dead file.
3. Edit `logger.js:10` to env-driven LEVEL (snippet above). Keep the existing
   `LOG_LEVELS` map and per-fn guards unchanged.
4. Add `LOG_LEVEL` to README env table + `.env.example`.
5. `npm run build` — confirm green (dead-file removal can't break build since
   unimported, but verify).
6. `npm test` (vitest) — confirm logger change breaks nothing
   (logger has no dedicated test; ensure no suite imported the dead file).

## Success Criteria
- [ ] `page.new.js` deleted; `npm run build` green.
- [ ] `logger.js` LEVEL resolved from `LOG_LEVEL` env with prod→INFO default.
- [ ] `LOG_LEVEL` documented in README + `.env.example`.
- [ ] Full vitest suite still passes.

## Risk Assessment
- Risk: hidden dynamic reference to `page.new`. Mitigation: Step 1 re-grep gate.
- Risk: something relied on DEBUG always printing (e.g. a test parsing stdout).
  Mitigation: run full suite; default keeps DEV verbose so local dev unchanged.
