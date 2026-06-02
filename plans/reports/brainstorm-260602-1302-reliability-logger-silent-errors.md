# Brainstorm — Reliability round: logger migration + silent-error triage

Date: 2026-06-02. Project: 9router (Next.js 16 LLM-router dashboard, 610 JS files, 0 TS).
Lens: **reliability / stop regressions**. God-file refactor DEFERRED (no test net).

## Problem statement

Debt signals found in scout:
- 360 raw `console.log` → ignore `LOG_LEVEL`, spam prod stdout.
- 167 empty `catch {}` → silent failures, undebuggable across proxy/tunnel/mitm.
- 8 god files >1000 lines (highest churn: `providers/[id]/page.js` 1529L/64 commits).
- No CI test gate; 26 pre-existing vitest failures; 85 test files / 610 src.

User goal = reliability. Scope chosen = logger migration + silent-error triage.
God-files + CI + the 26 failures explicitly OUT this round.

## Decisions (user-confirmed)

1. **Defer god-file refactor.** Splitting 1529-line React page with zero tests + no
   CI = regression roulette. Revisit after a test gate exists.
2. **Logger migration = server hotspots only.** Client-page `console.log` (browser
   devtools audience) is wrong target for the SSE stdout logger → separate follow-up.
3. **Logger reach = hotspot files** (>5 calls), not all 360.
4. **`logger.warn()` fix is in-scope** (prerequisite): its `console.warn` is commented
   out (`logger.js:43`); migrating any warning would silently vanish without it.
   (This resolves the deferral from the first-60s perf plan.)
5. **Silent-error triage = categorize, not blanket-fill.**

## Workstream A — server logger migration

Targets (~70 calls, server-side only):
- `src/shared/services/initializeApp.js` (19)
- `src/lib/tunnel/tailscale/manager.js` (11), `src/lib/tunnel/cloudflare/manager.js` (11)
- `src/lib/tunnel/tailscale/tailscale.js` (7)
- `src/app/api/providers/[id]/models/route.js` (9), `src/app/api/v1/models/route.js` (7)
- `src/lib/oauth/utils/ui.js` (8)
- (extend to other server files with >5 if cheap; mitm/manager.js candidate)

Prereq: uncomment `console.warn` in `src/sse/utils/logger.js:43`.

Mapping by intent:
- verbose/dev traces → `logger.debug`
- operational milestones (tunnel up, init done) → `logger.info`
- failure paths → `logger.error` (or `logger.warn` for recoverable)
- **Preserve** raw `[RTK] saved …` line (`open-sse/handlers/chatCore.js:119`) — e2e parses it; do NOT route through logger.

OUT: client dashboard pages (`providers/[id]/page.js`, `proxy-pools/page.js`,
`EndpointPageClient.js`, `ConnectionsCard.js`) — noted follow-up.

Acceptance:
- Migrated server files emit via logger; prod (INFO) hides debug, shows info/warn/error.
- `LOG_LEVEL=DEBUG` restores verbosity on migrated lines.
- `[RTK] saved` line unchanged; warmup e2e still parses it.

## Workstream B — silent-error triage

Scope: 167 empty `catch {}`. Prioritize hotspots:
`media-providers/[id]/page.js` (14, client), `initializeApp.js` (7),
`open-sse/handlers/chatCore.js` (6, proxy core), `mitm/manager.js` + `mitm/server.js` (8),
DB adapters/repos (intentional fallback — mostly keep + comment).

Per catch, classify:
- **Intentional best-effort** → `logger.debug(tag, msg, e?.message)` + keep, or
  `/* intentional: <reason> */` if logging adds noise.
- **Hides real failure** → `logger.error` + explicit handling (surface to caller/UI/retry).

Acceptance:
- No catch silently swallows a real failure.
- Each empty catch either logs (debug/error) or carries an intentional comment.
- No `logger.error` inside hot loops (spam) — use debug.

## Risks

- Low overall — both workstreams additive (logging), no logic rewrite.
- Watch: log spam in hot paths → prefer debug. Don't change control flow while triaging.
- `warn()` uncomment = new WARN output in all envs (intended; previously silent).

## Success metrics

- Server hotspot `console.log` count → ~0 (migrated).
- `logger.warn` functional (no longer no-op).
- Empty-catch count in hotspot files → each logged or commented.
- Build green; warmup 70/70 still pass; no new failures beyond the 26 known.

## Out of scope (next rounds)

- God-file refactor (needs tests-first / CI first).
- CI test gate + fixing the 26 failures.
- Client-page console.log migration.
- TypeScript adoption.

## Open questions

None — scope confirmed by user.
