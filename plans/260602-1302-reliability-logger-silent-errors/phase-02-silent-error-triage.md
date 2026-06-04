---
phase: 2
title: Silent-error triage
status: completed
priority: P1
effort: 4-5h
dependencies:
  - 1
---

# Phase 2: Silent-error triage

## Overview
Make silent failures debuggable. Triage empty `catch {}` blocks in hotspot files:
classify each as intentional best-effort (log at debug or comment) vs hides-a-
real-failure (log at error + handle). No control-flow rewrites.

## Requirements
- Functional: no empty catch in hotspot files silently swallows a real failure.
- Non-functional: no log spam; no behavior change to success paths.

## Architecture

### Classification (per catch block)
1. **Intentional best-effort** — cleanup/teardown, optional feature probe, DB
   driver fallback, parse-with-default. Action: `logger.debug(tag, "what failed", e?.message)`
   so it's traceable at DEBUG but silent in prod. If even debug is noise (tight
   loop), replace `{}` with `{ /* intentional: <reason> */ }`.
2. **Hides real failure** — an operation the user/caller depends on (provider
   connect, token refresh, request proxying, DB write). Action: `logger.error(tag,
   "...", e?.message)` AND surface: rethrow, return error result, or set error
   state — whatever the caller already expects. Do NOT invent new control flow;
   match the existing pattern in that module.

### Priority hotspots
- `src/shared/services/initializeApp.js` (7) — mostly best-effort (cleanup, DNS);
  likely debug-log.
- `open-sse/handlers/chatCore.js` (6) — **proxy core; scrutinize** — a swallowed
  error here = a dropped/garbled completion. Most likely need error-level.
- `src/mitm/manager.js` (4) + `src/mitm/server.js` (4) — proxy path; scrutinize.
- `src/lib/db/repos/usageRepo.js` (6), DB adapters (`nodeSqliteAdapter` 6,
  `bunSqliteAdapter` 5, `betterSqliteAdapter` 5), `migrate.js` (4) — driver
  fallback is mostly **intentional**; comment + maybe debug, don't error-spam.
- `src/shared/utils/machineId.js` (4), `src/shared/components/OAuthModal.js` (4).
- `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js` (14) —
  CLIENT page. Browser audience → this round, just add `/* intentional */`
  comments or a client `console.debug`; do NOT pull the server logger into a
  client component. (Defer deep client handling to the client-log follow-up.)

### Scope discipline
- Only triage the hotspot files above (~60 of the 167). Remaining scattered
  single-catch files are a later incremental pass — note the count left.
- Do NOT change what a function returns or throws unless the catch was clearly
  hiding a failure the caller already has a path for.

## Related Code Files
- Modify: hotspot files listed above (server ones use Phase-1 logger; client page gets comments)
- Read for context: callers of the hides-real-failure catches to confirm the surfacing pattern

## Implementation Steps
1. Grep each hotspot file for `catch.*{[[:space:]]*}` and read surrounding context.
2. Classify each (best-effort vs hides-failure) — note the call's purpose.
3. Apply: debug-log + keep / intentional-comment / error-log + surface.
4. For `chatCore.js` and `mitm/*` specifically, trace the caller to ensure an
   error-level log won't fire on a normal/expected path (e.g. client disconnect).
5. `npm run build` green; `npm run test:warmup` green (initializeApp touched).
6. Record count of catches triaged vs left for the follow-up pass.

## Success Criteria
- [ ] Every empty catch in hotspot files: logs (debug/error) or has `/* intentional: reason */`.
- [ ] `chatCore.js` / `mitm/*` swallowed-failure cases now error-logged + surfaced per existing pattern.
- [ ] No `logger.error` on an expected path (client disconnect, optional probe).
- [ ] Build + warmup green; remaining-catch count documented.

## Risk Assessment
- Risk: error-logging an expected condition (e.g. client aborts stream) → false
  alarms. Mitigation: trace caller; use debug for expected, error for unexpected.
- Risk: changing surfacing breaks a caller that relied on the swallow. Mitigation:
  only surface where caller already handles errors; otherwise log-only.
- Risk: scope creep across all 167. Mitigation: hotspot files only; log the rest.
