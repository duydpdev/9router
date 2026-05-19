# PM Sync Report — Warmup Failure Notifications

**Date:** 2026-05-19
**Plan:** `plans/20260519-1200-warmup-failure-notifications/plan.md`
**Branch:** `feature/dylan-improve`
**Status:** completed (code-side); live verification deferred

## Phase Summary

| Phase | Title | Status | Todo | Success Criteria | Notes |
|-------|-------|--------|------|------------------|-------|
| 1 | Notifier module + tests | completed | 8/8 | 11/11 | 25 new tests pass |
| 2 | Runner integration | completed | 10/10 | 9/9 | tri-state notify wired, lazy import verified |
| 3 | Scheduler/API wiring + env docs | completed | 10/10 | 7/7 | catch-up digest at 5-min threshold, manual API explicit `notify:false` |
| 4 | Verification | completed | 3/17 | 6/6 | code-side criteria verified; 14 live-env smoke steps deferred |

**Total checkboxes:** 64/78 (82%). Remaining 14 are Phase-4 live-environment smoke tests requiring real Discord/Telegram/webhook credentials.

## Commits (feature/dylan-improve)

```
19085bf6 fix(warmup): cache ProxyAgent dispatcher + widen Discord webhook regex
4e86dff3 feat(warmup): scheduler opts into notifier, manual run opts out, document env vars
29fee0ad feat(warmup): wire notifier into runner via opt-in notify flag
5973550d feat(warmup): add notifier module (env-driven, SSRF-safe, secret-redacted, no wiring yet)
```

## Files Touched

**New:**
- `src/lib/warmup/notifier.js` (650 lines, lazy-loaded)
- `tests/warmup-notifier.test.mjs` (25 tests)

**Modified:**
- `src/lib/warmup/runner.js` — tri-state `notify` opt-in
- `src/lib/warmup/scheduler.js` — boot log + catch-up digest derivation
- `src/app/api/warmup/run/route.js` — explicit `notify:false`
- `.env.example` — `WARMUP_NOTIFY_*` block appended
- `package.json` — `test:warmup` script

## Acceptance Criteria (22/22 materially implemented per code-reviewer)

| # | Criterion | Implementation Anchor |
|---|-----------|----------------------|
| 1-3 | Discord/Telegram/Generic channels | `notifier.js:sendDiscord/sendTelegram/sendGeneric` |
| 4 | Master switch | `notifier.js:notifyWarmupFailure` (`if !cfg.enabled return`) |
| 5 | Invalid config → channel disabled | `notifier.js:readEnv` validators |
| 6 | Manual run silent | `route.js:42` (`{ notify: false }`) |
| 7-8 | Recovery threshold + reset | `notifier.js:recordSuccess` (Set-keyed) |
| 9 | Boot log surfaces state size | `notifier.js:logBootStatus` |
| 10 | Notifier exception isolation | `runner.js` try/catch around lazy import |
| 11 | Rate-limit + separate recovery budget | `notifier.js:tryReserveFailureSlot/tryReserveRecoverySlot` |
| 12 | Secret redaction | `notifier.js:redactSecrets` + unit test |
| 13 | Single-line JSON logs | `notifier.js:log` (JSON.stringify) |
| 14 | Boot log before initial tick | `scheduler.js:31-40` (insertion order) |
| 15 | tests/warmup-notifier.test.mjs passes | 25/25 |
| 16 | SSRF deny-list + DNS-rebind recheck | `notifier.js:isValidPublicHttpUrl + isHostSendable` |
| 17 | Discord allowed_mentions + truncate | `notifier.js:buildDiscordPayload` |
| 18 | Telegram MarkdownV2 escape | `notifier.js:buildTelegramPayload + escapeMarkdownV2` |
| 19 | ProxyAgent honors HTTPS_PROXY | `notifier.js:getDispatcher` (cached) |
| 20 | isActive=false skips notify | `runner.js:isConfigStateError` gate |
| 21 | Catch-up → digest | `scheduler.js:90-93` |
| 22 | test:warmup script | `package.json:13` |

## Verification Surface

| Check | Result |
|-------|--------|
| `npm run test:warmup` | 54/54 pass |
| `npm run build` | clean |
| `npx eslint` on 4 modified files | clean |
| `node --check` on 4 modified files | clean |
| Top-level notifier import in runner/scheduler | 0 hits (verified via grep) |
| Code-reviewer subagent | 22/22 criteria, 0 critical/high/medium, 2 low (both fixed) |

## Deferred (Phase 4 live-env smoke tests)

Live verification requires real Discord webhook URL + Telegram bot token + generic webhook endpoint + a failing provider connection. Operator must run these in a staging environment with real credentials:

- Step 3 boot log inspection with real env
- Steps 4-9d external-channel arrivals + stdout secret grep
- Step 9c outbound proxy traversal verification

Code-side equivalents (redactor unit test, SSRF unit test, MarkdownV2 unit test, Discord-mention unit test) all pass — these prove the contract; live runs prove the wiring.

## Open / Follow-up

- Manual API auth gap (red-team #5) — deferred to separate hardening plan per Validation Session 1
- SIGTERM in-flight notifier drain (red-team Failure-7) — accepted out of scope
- Pre-existing scheduler TOCTOU between `if (g.interval) return` and `setInterval` assignment (code-reviewer low finding) — predates this plan, not addressed

## Unresolved Questions

None.
