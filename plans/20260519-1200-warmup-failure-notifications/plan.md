---
title: "Warmup Failure Notifications (env-based: Discord + Telegram + Generic + Recovery)"
description: "Add env-driven external notifications (Discord webhook, Telegram bot, generic webhook) when warmup chat fails. Scheduler-only — manual runs do not notify. Recovery alert after N consecutive failures. JSON structured logs. No UI, no DB persistence."
status: completed
priority: P2
branch: "feature/dylan-improve"
tags: ["warmup", "notifications", "env"]
blockedBy: []
blocks: []
created: "2026-05-19T11:58:22.088Z"
createdBy: "ck:plan"
source: skill
---

# Warmup Failure Notifications

## Overview

Warmup feature currently records failures into `warmupRuns` (lowdb) and shows them in `RunHistoryPanel` only. User does not get notified when 9Router is not actively watched. Add env-configured external channels (Discord webhook, Telegram bot, generic webhook). Scheduler-triggered failures push a notification; manual `/api/warmup/run` does not. Track per-connection consecutive-failure counter to emit a single recovery alert after N fails clear.

**Target branch:** `feature/dylan-improve` (warmup feature lives there). Plan file committed on `master` is fine; code changes must land on the warmup branch.

## Context Links

- Brainstorm session (in-conversation, not persisted as separate doc — design captured in this plan)
- Warmup design spec: `docs/superpowers/specs/2026-04-29-warmup-scheduler-design.md`
- Warmup implementation plan (legacy): `docs/superpowers/plans/2026-04-29-warmup-scheduler.md`
- Warmup robustness plan: `plans/20260517-1734-warmup-scheduler-robustness/` (on `feature/dylan-improve`)
- Existing runner: `src/lib/warmup/runner.js` (branch `feature/dylan-improve`)
- Existing scheduler: `src/lib/warmup/scheduler.js` (branch `feature/dylan-improve`)
- Existing manual run API: `src/app/api/warmup/run/route.js` (branch `feature/dylan-improve`)

## Approved Design (locked from brainstorm)

| Decision | Value |
|----------|-------|
| Config source | env vars only (file-mounted, e.g. via CapRover persistent volume) |
| Channels | Discord webhook, Telegram bot, generic webhook (any combination, presence-based enable) |
| Trigger | Every failure on a **scheduler tick** |
| Manual run notify | NO (failure and recovery both suppressed for `/api/warmup/run`) |
| Recovery alert | After `WARMUP_NOTIFY_RECOVERY_AFTER_FAILS` (default 3) consecutive failures cleared by a success |
| Instance count | 1 (no cross-instance dedupe) |
| Log format | Structured single-line JSON via `console.log(JSON.stringify({...}))` |
| New runtime deps | NONE — use existing `undici` (already at `^7.19.2`) + `AbortSignal.timeout`. Native global `fetch` is NOT used because it ignores `HTTP_PROXY` (red-team #8) |
| UI / API for config | NONE (no settings page, no PUT endpoint, no test button) |
| DB persistence of notif state | NONE (in-memory Map; resets on restart) |
| Rate limit | Sliding-hour cap (default 30, env override) |

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Notifier module + tests](./phase-01-notifier-module-tests.md) | Completed |
| 2 | [Runner integration](./phase-02-runner-integration.md) | Completed |
| 3 | [Scheduler/API wiring + env docs](./phase-03-scheduler-api-wiring-env-docs.md) | Completed |
| 4 | [Verification](./phase-04-verification.md) | Completed (code-side; live env deferred) |

## Dependencies

- Requires warmup feature present (commit `85cbea9c` on `feature/dylan-improve`). Master does not have warmup yet — plan must be implemented on the warmup branch.
- No cross-plan blockers.

## Out of Scope

- API config route or UI form
- Test button
- DB-persisted notification history
- Per-schedule config (global only)
- Cross-instance dedupe (single instance only)
- Encryption at rest for env values (delegated to deploy infra)
- Retry on transient 5xx (5s timeout, log + drop)
- Email / SMS channels

## Acceptance Criteria (whole-plan)

1. Set `WARMUP_NOTIFY_DISCORD_WEBHOOK` → scheduler-tick fail → Discord receives message ≤5s
2. Set `WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN` + `WARMUP_NOTIFY_TELEGRAM_CHAT_ID` → scheduler fail → Telegram chat receives message
3. Set `WARMUP_NOTIFY_GENERIC_WEBHOOK_URL` → scheduler fail → URL receives JSON POST
4. `WARMUP_NOTIFY_ENABLED=false` → 0 sends across all channels
5. Invalid token/URL → channel disabled, boot log `invalid_config`, other channels unaffected
6. Manual run via `POST /api/warmup/run` → 0 notifications (failure AND recovery)
7. Recovery: scheduler `≥ RECOVERY_AFTER_FAILS` consecutive **distinct-slot** fails for one `connectionId` → next success emits recovery payload + resets counter (retried same slot does NOT inflate counter — red-team #6)
8. Recovery success when counter `< RECOVERY_AFTER_FAILS` → NO recovery emitted (counter reset only)
9. Restart between failures → counter resets AND boot log emits a `state_wiped` event with `recoveryState.size: 0, rateLimitWindow.length: 0` so operators can detect the discontinuity (red-team #13)
10. Notifier exception/timeout → `warmupRuns` write still succeeds, scheduler tick continues
11. Failure rate-limit cap reached → failure-send dropped + log event `rate_limited`. **Recovery alerts use a separate budget** (default 5/hour) so a failure storm cannot silence the all-clear (red-team #15)
12. Tokens / webhook URLs do NOT appear in stdout — enforced by `redactSecrets()` applied to every log line; verified by an automated unit test that injects a fake fetch throwing an error containing a configured token, then asserts the log output does not contain the token (red-team #3)
13. All notifier log lines are single-line JSON (`JSON.parse`-able)
14. Boot log dumps channel enable status + thresholds once at startup. Boot log fires **before** the initial scheduler tick so it never interleaves with catch-up `event:"sent"` lines (red-team #11)
15. `tests/warmup-notifier.test.mjs` passes (payload builders, rate-limit window, recovery state machine, env validation, manual-run gating, secret-redaction)
16. Generic webhook validator rejects loopback / RFC1918 / link-local / metadata-host targets at boot. Hostnames are DNS-resolved at send time and re-checked against the same deny-list to defeat DNS rebinding (red-team #1)
17. Discord payload includes `allowed_mentions: { parse: [] }` and error text is truncated to 1500 chars; assertion in `tests/warmup-notifier.test.mjs` (red-team #4)
18. Telegram uses `parse_mode: "MarkdownV2"` with escapeMarkdownV2 applied to every user-controlled field (schedule name, connection name, error text). Test asserts an error string containing `_*[](){}.!` is delivered without Telegram 400 (red-team #7)
19. Outbound notifier `fetch` honors `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` env via `undici.ProxyAgent` matching the existing pattern in `src/lib/network/proxyTest.js` (red-team #8)
20. `runWarmupDueItem` does NOT touch recovery state nor send notifications for the `Provider connection is inactive` error path — `isActive=false` is a config state, not a provider failure (red-team #14)
21. Catch-up mode is detected (when `from < now - 5 min` in scheduler) and the runner passes `{ notify: "digest" }` (instead of `true`) so the notifier emits at most ONE summary message per catch-up batch instead of per-item (red-team #2)
22. Test commands across all phases use `node --import ./tests/helpers/at-loader.mjs --test ...` (or an npm script that wraps this). A `package.json` script `test:warmup` is added in Phase 1 (red-team #9)

## Security Considerations

- `.env` already in `.gitignore` (verified: `.env*` present)
- `.env.example` will receive placeholder keys (committed as documentation)
- Token / webhook URL read inside notifier scope, never re-exported
- Logs MUST mask credentials — only print `channel: "discord" | "telegram" | "generic"` enum, never the URL or token
- **Hard-redact tokens / webhook URLs** from every log call via a `redactSecrets(text, cfg)` helper. Tokens can surface in `fetch` error messages (e.g. Telegram URL contains the bot token in the path). See red-team #3 + Phase 1
- **SSRF protection**: generic webhook validator rejects loopback (`127.0.0.0/8`, `::1`), RFC1918, link-local (`169.254.0.0/16` incl. cloud metadata host), and unique-local IPv6 ranges. DNS-resolved hostnames are re-checked at send time to defeat DNS rebinding. See red-team #1 + Phase 1
- **Discord mention containment**: every Discord payload sets `allowed_mentions: { parse: [] }` and truncates error text to 1500 chars to avoid `@everyone`/`@here`/role-mention amplification through attacker-controlled upstream error bodies. See red-team #4 + Phase 1
- **Manual API auth gap (deferred)**: `POST /api/warmup/run` is currently un-authenticated on `feature/dylan-improve`. This plan's "manual = silent" decision does NOT introduce the gap, but it does interact with it (an unauthenticated caller can spam manual runs to burn quota silently). Adding auth to the warmup API is out of scope for this plan — tracked as a separate hardening task. See red-team #5

## Open Questions

- **Manual API authentication** (red-team #5): [DEFERRED, confirmed in Validation Session 1] — `POST /api/warmup/run` un-authenticated is a pre-existing gap on `feature/dylan-improve`, not introduced by this plan. Tracked as a follow-up hardening plan to be created after this plan is cooked. No code change in this plan.

## Red Team Review

### Session — 2026-05-19
**Findings:** 15 (15 accepted, 0 rejected — 1 doc-only)
**Severity breakdown:** 3 Critical, 10 High, 2 Medium
**Reviewers:** Security Adversary, Failure Mode Analyst, Assumption Destroyer (parallel, hostile)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | SSRF: generic webhook validator accepts loopback / IMDS / RFC1918 | Critical | Accept | Phase 1 (validator + DNS-rebind check), Phase 4 |
| 2 | Catch-up storm silently drops notifications via rate-limit cap | Critical | Accept | Phase 1 (digest builder), Phase 2 (notify mode), Phase 3 (catch-up detection) |
| 3 | Telegram bot token leaks into `reason` via `fetch` error URL | Critical | Accept | Phase 1 (`redactSecrets` helper + test) |
| 4 | Discord `@everyone` / role-mention amplification via error text | High | Accept | Phase 1 (`allowed_mentions: { parse: [] }` + 1500-char truncate) |
| 5 | Manual API `/api/warmup/run` has no auth (pre-existing) | High | Accept (doc-only) | plan.md Security + Open Questions; deferred |
| 6 | Recovery counter false positive on retried same-slot failures | High | Accept | Phase 1 (key by `(connectionId, dedupeKey)`), Phase 2 |
| 7 | Telegram `parse_mode: "Markdown"` silently 400s on unescaped err | High | Accept | Phase 1 (switch to `MarkdownV2` + escapeMarkdownV2) |
| 8 | Native `fetch` ignores `HTTP_PROXY` → notifications dead behind proxy | High | Accept | Phase 1 (`undici.ProxyAgent`) |
| 9 | Test invocation missing `--import ./tests/helpers/at-loader.mjs` | High | Accept | Phase 1 (npm script `test:warmup`), all phases |
| 10 | Phase 4 Step 8 recovery recipe broken (dedupe blocks 2nd fail) | High | Accept | Phase 4 (rewrite Step 8 with 2-schedule recipe) |
| 11 | Boot log ordering vs initial tick ambiguous | High | Accept | Phase 3 (explicit insertion line) |
| 12 | Static notifier import contradicts plan's "lazy" success criterion | High | Accept | Phase 2 (lazy `await import()` inside runner functions + correct criterion) |
| 13 | Recovery + rate-limit state wiped on restart with no visibility | High | Accept | Phase 1 (boot log includes `recoveryState.size`, `rateLimitWindow.length`) |
| 14 | Recovery state unbounded for `isActive=false` connections | Medium | Accept | Phase 2 (skip notify on inactive-connection errors) |
| 15 | Recovery alert rate-limited by failure storm (silences all-clear) | Medium | Accept | Phase 1 (separate recovery budget, default 5/h) |

### Whole-Plan Consistency Sweep

- **Files reread:** `plan.md`, `phase-01-notifier-module-tests.md`, `phase-02-runner-integration.md`, `phase-03-scheduler-api-wiring-env-docs.md`, `phase-04-verification.md`
- **Decision deltas checked:**
  - `consecutiveFails` → `distinctFails` (recovery counter semantics; red-team #6)
  - `tryReserveSlot()` → `tryReserveFailureSlot()` + new `tryReserveRecoverySlot()` (red-team #15)
  - `isValidHttpUrl` repurposed as legacy alias for `isValidPublicHttpUrl` with SSRF deny-list (red-team #1)
  - `notify` is now tri-state `false | "scheduler" | "digest"` (red-team #2 catch-up digest)
  - `recordFailure(connectionId, dedupeKey)` — added `dedupeKey` parameter (red-team #6)
  - Notifier is lazy-imported via `await import("@/lib/warmup/notifier")` inside runner — no top-level static import (red-team #12)
  - `npm run test:warmup` script replaces bare `node --test` in every phase (red-team #9)
  - `undici.fetch` + `ProxyAgent` replaces native global `fetch` (red-team #8)
  - Discord payload: `allowed_mentions: { parse: [] }` + 1500-char error truncate (red-team #4)
  - Telegram payload: `parse_mode: "MarkdownV2"` + `escapeMarkdownV2()` on all dynamic fields (red-team #7)
  - Boot log: inserted AFTER `if (g.interval) return;`, BEFORE initial `tickWarmupScheduler()` (red-team #11)
  - Boot log payload includes `recoveryState.size`, `rateLimitWindow.length`, `recoveryWindow.length`, `proxy: "[redacted-proxy]"|null` (red-team #13)
  - `redactSecrets()` applied at every `log()` call; covered by an injected-token unit test (red-team #3)
  - `runner.js` skips notify entirely for `Provider connection not found/inactive` errors (red-team #14)
  - Phase 4 Step 8 recovery recipe rewritten to use 2-schedule pattern (red-team #10)
  - Phase 4 Step 9 rate-limit expectation rewritten unambiguously (red-team #M7)
  - `.env.example` expanded with `WARMUP_NOTIFY_RECOVERY_RATE_LIMIT_PER_HOUR`, SSRF deny-list note, proxy note, restart-required note
  - Manual API auth gap (red-team #5) documented in Security Considerations + Open Questions — no code change
- **Reconciled stale references:** 8 — all `consecutiveFails` → `distinctFails`, `tryReserveSlot` → `tryReserveFailureSlot`, `notify: true` → `notify: "scheduler"`, old `node --test` → `npm run test:warmup`, old `recordFailure(connectionId)` → `recordFailure(connectionId, dedupeKey)`.
- **Unresolved contradictions:** 0
- **Out-of-scope items deferred (not contradictions, explicitly out-of-scope per plan):**
  - SIGTERM in-flight notifier drain (red-team Failure-7) — accept worst-case truncated send
  - Manual API authentication (red-team Security-4 / #5) — tracked in Open Questions

Plan is internally consistent. Ready to recommend `/ck:cook` (single instance only — implementation on `feature/dylan-improve`).

## Validation Log

### Session 1 — 2026-05-19
**Trigger:** `/ck:plan validate` invoked after `/ck:plan red-team` accepted 15 findings.
**Questions asked:** 6
**Verification pass:** SKIPPED per Step 2.5 guard — `## Red Team Review` already produced verification evidence (file:line citations across all phases). No `[UNVERIFIED]` tags remain in the plan.

#### Questions & Answers

1. **[Architecture]** Ngưỡng catch-up digest: bao lâu offline thì chuyển sang digest mode thay vì per-item alerts?
   - Options: 5 phút (Recommended) | 10 phút | 30 phút | Luôn digest nếu >1 item
   - **Answer:** 5 phút (Recommended)
   - **Rationale:** Locks `isCatchUp = (now - from) > 5 * 60 * 1000` in `tickWarmupScheduler` (Phase 3). Catches restart-after-short-outage as catch-up without spamming per-item on normal once-per-minute ticks. Tunable via constant if future needs differ.

2. **[Risks / Architecture]** SSRF deny-list: có thêm opt-in `WARMUP_NOTIFY_ALLOW_PRIVATE_TARGETS=true` cho dev local không?
   - Options: Không — cứng như default (Recommended) | Có — thêm env opt-in
   - **Answer:** Không — cứng như default (Recommended)
   - **Rationale:** SSRF deny-list (loopback, RFC1918, link-local, IPv6 ULA) is HARD-CODED with no override env. Dev local should use webhook.site / ngrok / public test endpoint. Removes operator-foot-gun risk of leaving `ALLOW_PRIVATE_TARGETS=true` in production. Phase 1 implementation does NOT add an override env.

3. **[Architecture]** Generic webhook scheme: chỉ cho phép https hay cả http?
   - Options: Cả http và https (Recommended) | Chỉ https
   - **Answer:** Cả http và https (Recommended)
   - **Rationale:** `HTTP_URL_RE = /^https?:\/\/.+/` stays. Allows self-host LAN endpoints (Home Assistant, n8n, internal alerting) that lack TLS termination. Private-CIDR deny-list still blocks loopback/RFC1918, so this does NOT open SSRF — `http://203.0.113.1/x` is allowed (public), `http://10.0.0.1/x` is blocked (RFC1918). Confirms Phase 1 regex unchanged.

4. **[Assumptions]** Khi `Provider connection is inactive`, runner nên làm gì?
   - Options: Vẫn ghi failure row vào warmupRuns, không notify (Recommended) | Skip hoàn toàn (no row, no notify) | Vẫn ghi và vẫn notify (status quo)
   - **Answer:** Vẫn ghi failure row vào warmupRuns, không notify (Recommended)
   - **Rationale:** Phase 2 keeps the existing `appendWarmupRun({status:"failure"})` call BEFORE the notify gate. Only the notify path (and `recordFailure` recovery counter) is short-circuited by `isConfigStateError()`. Dashboard `RunHistoryPanel` still shows the failure row for operator visibility. (red-team #14 implementation matches user intent.)

5. **[Scope]** Open Question #5 (manual API auth): add auth cho `POST /api/warmup/run` ngay trong plan này, hay defer?
   - Options: Defer — plan riêng sau (Recommended) | Add auth ngay trong plan này
   - **Answer:** Defer — plan riêng sau (Recommended)
   - **Rationale:** Plan stays scoped to notifier wiring. Open Question #5 in plan.md updated below to mark as **deferred**, not unresolved. Auth hardening tracked as a separate follow-up plan (to be created after this plan is cooked).

6. **[Assumptions]** Default `WARMUP_NOTIFY_RECOVERY_AFTER_FAILS=3` (3 distinct-slot fails before recovery alert) đúng ý không?
   - Options: Giữ 3 (Recommended) | 1 (every fail) | 5 (conservative) | User configure via env, no default
   - **Answer:** Giữ 3 (Recommended)
   - **Rationale:** Locks `DEFAULT_RECOVERY_AFTER_FAILS = 3` in Phase 1. Env override `WARMUP_NOTIFY_RECOVERY_AFTER_FAILS` remains available. Matches the brainstorm decision and the existing test fixture.

#### Confirmed Decisions
- Catch-up digest threshold: 5 minutes (locked)
- SSRF deny-list: no opt-in override (locked)
- Generic webhook scheme: http and https (locked)
- `isActive=false` handling: write failure row, skip notify path (locked)
- Manual API auth: deferred to separate follow-up plan (locked)
- Recovery threshold default: 3 distinct-slot fails (locked)

#### Action Items
- [ ] Mark Open Question #5 as **deferred** (not unresolved) in plan.md so cook does not block on it
- [ ] Ensure Phase 3 catch-up threshold constant uses 5-minute window — already specified, confirmed
- [ ] Ensure Phase 1 omits any `ALLOW_PRIVATE_TARGETS` env handling — already absent, confirmed
- [ ] Ensure Phase 2 `isConfigStateError` path is positioned AFTER `appendWarmupRun({status:"failure"})` so the row persists — already specified, confirmed

#### Impact on Phases
- **Phase 1:** No changes — all defaults already match user decisions
- **Phase 2:** No changes — `appendWarmupRun` ordering already correct
- **Phase 3:** No changes — 5-minute catch-up threshold already specified
- **Phase 4:** No changes — verification steps already match decisions

### Whole-Plan Consistency Sweep

- **Files reread:** `plan.md`, `phase-01-notifier-module-tests.md`, `phase-02-runner-integration.md`, `phase-03-scheduler-api-wiring-env-docs.md`, `phase-04-verification.md`
- **Decision deltas from this session:** 6 (all confirm existing recommended defaults — no new terms, no renames, no field changes)
- **Reconciled stale references:** 0 (decisions matched existing text)
- **Unresolved contradictions:** 0
- **Open Questions adjustment:** Question #5 (manual API auth) is now marked **deferred** rather than open — see updated Open Questions section above

Plan is locked. Ready for `/ck:cook`.
