# Code Review — Warmup Failure Notifications

**Branch:** `feature/dylan-improve`
**Commits reviewed:** 5973550d, 29fee0ad, 4e86dff3
**Tests:** `npm run test:warmup` → 54/54 pass (verified in-session)
**Reviewer:** code-reviewer
**Date:** 2026-05-19

## Verdict

All 22 acceptance criteria are materially implemented. No critical, high, or medium findings. Two **low** observations on operational hygiene listed below — neither blocks shipping.

## Findings

| # | path:line | severity | problem | fix |
|---|-----------|----------|---------|-----|
| 1 | `src/lib/warmup/notifier.js:458,512` | low | `new ProxyAgent({uri: cfg.proxyUrl})` constructed inside every `fanOut` / `fanOutDigest` call and never `.close()`-d. Under sustained traffic each dispatcher keeps its pool alive until socket-idle timeout — soft resource pressure, not a hard leak. Rate-limit caps (30/h failure + 5/h recovery) bound the blast radius. | Cache one dispatcher per `cfg.proxyUrl` at module scope, or `await dispatcher.close()` after `Promise.allSettled`. |
| 2 | `src/lib/warmup/notifier.js:14` | low | `DISCORD_WEBHOOK_RE` hard-codes token length `{60,80}`. Discord publishes no official bound; if they ever issue a shorter/longer token the channel silently demotes to `reason:"invalid_config"` without operator-visible cause beyond the boot log. | Widen to `{40,200}` or drop the length range and rely on the host + numeric-id structural check. Today's tokens (~68 chars) sit safely inside the band. |

## Pre-existing observation (NOT a regression from this plan)

| path:line | note |
|-----------|------|
| `src/lib/warmup/scheduler.js:36-56` | `startWarmupScheduler` has a TOCTOU window between `if (g.interval) return` and the eventual `g.interval = setInterval(...)`. Two concurrent callers would both pass the guard, both await the initial tick (idempotent — `g.running` re-entrancy guard handles this), and the second `setInterval` overwrites + leaks the first interval handle. Predates this plan (`85cbea9c`); not introduced by these commits. Worth a follow-up `g.starting = true` latch but out of scope here. |

## Acceptance Criteria Citation Table

| # | Criterion | Cite |
|---|-----------|------|
| 1 | Discord scheduler-fail | `notifier.js:419-429, 460-466`; gated by `notify === "scheduler"` in `runner.js:118` |
| 2 | Telegram scheduler-fail | `notifier.js:431-443, 468-477` |
| 3 | Generic webhook scheduler-fail | `notifier.js:445-455, 478-485, 317-345` |
| 4 | `WARMUP_NOTIFY_ENABLED=false` → 0 sends | `notifier.js:33, 567, 591, 615` (early-return guard) |
| 5 | Invalid token/URL → `invalid_config` in boot log | `notifier.js:64,71-74,79,637-656` |
| 6 | Manual run → 0 notifications | `route.js:42` passes `notify:false`; runner guards `notify === "scheduler"` at `runner.js:68,118` and `notify === "digest"` at `runner.js:171,183`; default `notify=false` at `runner.js:34,160` |
| 7 | Recovery after N distinct-slot fails | `notifier.js:178-187` (Set-by-slot), tested at `tests/warmup-notifier.test.mjs:266-286` |
| 8 | Below threshold → reset only, no recovery | `notifier.js:189-196`, tested at `:130-152` |
| 9 | Restart → `state_wiped` boot log | `notifier.js:637-656` emits `recoveryState.size, rateLimitWindow.length, recoveryWindow.length`; tested at `:301-316` |
| 10 | Notifier exception → `warmupRuns` row still written | `runner.js:104` (`appendWarmupRun` before notify); notifier never throws (`notifier.js:564-586,588-610,612-634` outer try/catch); runner wraps notify in try/catch (`runner.js:97-99,150-152,187-189`) |
| 11 | Separate recovery budget | `notifier.js:199-205` (`tryReserveFailureSlot` vs `tryReserveRecoverySlot`), `:29-30` separate arrays, tested at `:290-297` |
| 12 | Token/URL never in stdout | `notifier.js:217-226, 658-668` (`redactSecrets` on every log value), tested at `:198-218` |
| 13 | JSON single-line logs | `notifier.js:665-667` (`JSON.stringify`), tested at `:357-367` |
| 14 | Boot log before initial tick | `scheduler.js:41-49` (boot block) precedes `:52` (`await tickWarmupScheduler()`) |
| 15 | Notifier tests pass | `npm run test:warmup` → 54/54 |
| 16 | SSRF deny-list + DNS-rebind recheck | `notifier.js:102-127` (boot — IP literals + localhost), `:158-176` (send — DNS-resolves hostnames), tested at `:172-194` |
| 17 | Discord `allowed_mentions` + 1500-char truncate | `notifier.js:9` (`ERROR_TRUNCATE = 1500`), `:266` (apply), `:278` (`allowed_mentions: { parse: [] }`), tested at `:222-233` |
| 18 | Telegram MarkdownV2 + escape | `notifier.js:282-315` (`parse_mode: "MarkdownV2"` + `escapeMarkdownV2` on every dynamic field), tested at `:237-262` |
| 19 | ProxyAgent honors HTTPS_PROXY/HTTP_PROXY/ALL_PROXY | `notifier.js:38-47, 458, 512` (SOCKS5 supported as experimental in current Node — confirmed locally) |
| 20 | `isActive=false` skips notify + recovery state | `runner.js:13-19` (`isConfigStateError`), `:118` gate. Failure row still persisted at `:104-115` per Validation Session Q4. |
| 21 | Catch-up mode → digest, one summary | `scheduler.js:109-111` (5-min threshold), `runner.js:167,171-180,183-190` (accumulate + one fanout) |
| 22 | `test:warmup` npm script | `package.json` diff (added `"test:warmup": "node --import ./tests/helpers/at-loader.mjs --test tests/warmup-*.test.mjs"`) |

## Structural Checks

- **(b) Manual API path unchanged in behavior** — `route.js:42` passes `notify:false`; recovery state and notifier are NEVER touched on manual runs. Verified by grep across `runner.js` for all three notify gates.
- **(c) `runWarmupItems` callers** — only one caller (`route.js:4,42`); was updated to pass explicit `notify:false`. New parameter is destructured with a `false` default, so any future caller that omits the option is also silent — no breaking change.
- **(d) Notifier is lazy-imported everywhere** — only two callers: `runner.js:9` and `scheduler.js:17`, both via dynamic `await import("@/lib/warmup/notifier")`. No top-level static import outside `tests/warmup-notifier.test.mjs`. Verified with `grep -rn "@/lib/warmup/notifier" src`.
- **(e) Build / lint** — repo has no `lint` npm script. Tests pass cleanly; no syntax issues observed. Plan asserts build was already verified clean.
- **(f) Secret-leak surfaces** — `redactSecrets` covers configured `discord.url`, `generic.url`, `telegram.token`, plus the global `bot\d+:[A-Za-z0-9_-]{20,}` pattern. Notifier internals never throw to the runner (top-level try/catch), so `[WarmupRunner] notify ... failed: ${notifyError.message}` logs in `runner.js:98,151,188` cannot leak channel config. Boot-log proxy URL is masked to `[redacted-proxy]` at `notifier.js:648`.

## Recommended Actions

1. (low) Consider caching `ProxyAgent` per `cfg.proxyUrl` at module scope to avoid per-call construction.
2. (low) Widen `DISCORD_WEBHOOK_RE` token-length range from `{60,80}` to `{40,200}` to be forward-compatible with future Discord token formats.

## Unresolved Questions

None.
