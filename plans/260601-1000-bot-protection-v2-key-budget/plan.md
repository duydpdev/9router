---
title: "Bot Protection v2 — Per-Key Budget Alerts + Edge Hardening"
description: "Per-key daily budget monitor (alert-only) wired at the post-completion usage-write hook + edge hardening docs (nginx Turnstile, datacenter-ASN deny, fail2ban probe jail). Kills leaked-key free-quota mining + web scrape. TDD per phase."
status: completed
priority: P2
branch: "feat/implement-sercurity"
tags: [security, bot-protection, rate-limit, observability]
blockedBy: []
blocks: []
created: "2026-06-01T08:25:08.765Z"
createdBy: "ck:plan"
source: skill
---

# Bot Protection v2 — Per-Key Budget Alerts + Edge Hardening

## Overview

Extends shipped v1 floor (`plans/260601-0800-bot-protection-layered/`). v1 stops single scanner + 1-IP flood. v2 closes two gaps:

1. **"Đào" = leaked-key free-quota mining** — valid `/v1` key = 1200 req/min with **no daily cap** → leaked key drains Kiro/OpenCode/Vertex free quota. v2 adds a **per-key daily budget monitor**: after each request's usage is recorded, read today's token+request totals for that key and fire a webhook **alert** (Discord/Telegram/Generic) when it crosses `warnAtPercent` then 100%, with periodic **re-alert** while still over. **Alert-only** — never blocks, never disables (user decision: zero false-lockout on real keys).
2. **Web scrape** — keyless bots cào dashboard/web. v2 ships **edge hardening** docs/templates: nginx Turnstile on dashboard login, GeoIP2 datacenter-ASN deny on non-`/v1` web routes, fail2ban probe-403-flood jail.

Design source: `plans/reports/brainstorm-2026-06-01-bot-protection-v2-improvements.md` (Approach A, alert-only, budget = token OR request/day). Hardened by red-team 2026-06-01 (see `## Red Team Review`).

## Key Decisions

- **Approach A** — app monitor + edge docs. NOT building behavior-scoring, PoW, persistent-ban app-layer (fail2ban covers on VPS), or auto-disable.
- **Alert-only** (user-confirmed) — read usage + notify, never blocks/disables. Tradeoff is **honestly bounded** below.
- **Trigger point = post-completion, NOT request entry** — the budget check runs after `saveRequestUsage` (where token counts exist and the daily per-key aggregate is fresh), via a `statsEmitter` event. NOT in `botGuard`/`rateLimitLlm` (request-entry would see zero tokens for the current request — a single-shot token bomb would never alert; also keeps the `/v1` hot path latency-free).
- **Budget unit = token OR request/day** — token = `promptTokens + completionTokens` integer columns. Trip on either.
- **Single-instance only** — same constraint as v1 rate limiter (`rateLimiter.js:2`). Dedup + daily totals assume one process. Clustered deploy = duplicate alerts; documented, not solved (matches v1 posture).

### Alert-only tradeoff (explicit, from red-team Finding 12)

Alert-only means a leaked key keeps mining between the alert and manual revoke. Worst case at the v1 default 1200 req/min: ~72K req/hr, so an 8-hour unattended window ≈ **576K extra requests** draining free-tier quota. Mitigations kept within alert-only: (a) early alert at `warnAtPercent` (default 80%), (b) **re-alert every `reAlertHours` while still over** (not fire-once-then-silent), (c) the operator can revoke via existing `apiKeys.isActive` (already wired into `validateApiKey`). Auto-disable is intentionally NOT built; the plumbing (`isActive`) is available if the user later reverses this decision.

## Reuse (verified in codebase, 2026-06-01 — corrected post-red-team)

- **Daily per-key aggregate already exists** — `usageDaily` table holds one JSON row per local day keyed by `getLocalDateKey` (`usageRepo.js:30,267-274`), with `byApiKey[ "${apiKey}|${model}|${provider}" ] = { requests, promptTokens, completionTokens, cost }`, upserted inside `saveRequestUsage`'s transaction. → today's per-key total = **one PK lookup** `SELECT data FROM usageDaily WHERE dateKey=?` + sum matching entries. **No `usageHistory` scan, no new index** (the earlier "indexed read of usageHistory" claim was wrong: `usageHistory.tokens` is a JSON TEXT column — `SUM(tokens)`=0; and there is no `apiKey` index, `schema.js:122`).
- **Post-write event hook** — `saveRequestUsage` already emits `statsEmitter.emit("update")` (`usageRepo.js:283`). v2 adds a payload-carrying `statsEmitter.emit("usage", entry)` so the monitor subscribes without `usageRepo` importing security code (clean layering).
- **Notifier transport** — `getNotifierConfig/getNotifierDispatcher/sendDiscord/sendTelegram/sendGeneric` (`notifier.js:115,442,454,468`). ⚠️ `getNotifierConfig().enabled` is driven solely by `WARMUP_NOTIFY_ENABLED` env and frozen at first call (`notifier.js:51,115-118`) — budget alerts are silently dead without it (red-team Finding 6). Phase 1 surfaces this in the UI.
- **Settings deep-merge on READ** — `botProtection` ∈ `NESTED_DEFAULT_KEYS` + `deepMergeDefaults` (`settingsRepo.js:56,96`). ⚠️ `updateSettings` WRITE is shallow (`settingsRepo.js:113`); the UI must send the whole `botProtection` object (as it already does, `EndpointPageClient.js:325-329`) — red-team Finding 9.
- **`keyHash`** exists but is **private** in `botGuard.js:17` → extract to a shared module so the monitor + alert can import it (red-team Finding 8).
- `BotProtectionSettings.js:47-76` has reusable Toggle/Input markup; `toPositiveInt` clamp at `:16-18` (needs a percent clamp for `warnAtPercent`).
- `bot-blocked.log` JSON `kind:"probe"` lines (`auditLog.js:17-29`) → fail2ban jail premise valid.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Settings & UI](./phase-01-settings-ui.md) | Completed |
| 2 | [Budget Core](./phase-02-budget-core.md) | Completed |
| 3 | [Alert & Wiring](./phase-03-alert-wiring.md) | Completed |
| 4 | [Edge Hardening](./phase-04-edge-hardening.md) | Completed |

## Implementation Outcome (2026-06-01)

All 4 phases shipped on `feat/implement-sercurity`. 74/74 security unit tests green (`tests/unit/security-*`, `usage-today-for-key`). Code review: no blocking issues; security invariant (no raw key in any alert payload/log) verified, sync-claim concurrency yields exactly-one-send, monitor fully isolated from the `/v1` hot path, reader O(1) on `usageDaily` PK.

Files: `keyHash.js` + `botSettingsCache.js` (extracted), `keyBudget.js` + `key-budget-alert.js` (new), `usageRepo.js` (`getTodayUsageForKey` reader + `usage` event), `settingsRepo.js` (defaults), `botGuard.js` (shared imports), `initializeApp.js` (boot wiring), `settings/route.js` + `BotProtectionSettings.js` + `EndpointPageClient.js` (UI + notifier-status), Phase-4 `deploy/` templates + `docs/bot-protection.md`.

**Unverified:** `npm run build` not run (root deps not installed in dev env) — run `next build` in CI before merge to confirm the new `@/lib/security/keyBudget` import resolves under the Next bundler. nginx `-t` / `fail2ban-regex` / curl smoke are VPS-side (tools absent locally); probe failregex validated via unit test instead.

## Dependencies

- Phase 1 (settings) → Phase 2 (reader+evaluator, depends on settings shape + shared keyHash) → Phase 3 (post-completion hook + alert). Phase 4 (edge docs) independent.
- Reuses warmup notifier (shipped `20260519-1200-warmup-failure-notifications` = completed) — read-only, no blocking. No cross-plan blocking detected.

## TDD Note

Phases 1-3 tests-first (Vitest v4, `tests/`, run `cd tests && npm test -- unit/security-*.test.js`). Phase 4 = docs/templates; validate via `fail2ban-regex` + `nginx -t` + a curl smoke test, not unit tests.

## Red Team Review

### Session — 2026-06-01
**Findings:** 15 (15 accepted [1 partial], 0 rejected)
**Severity breakdown:** 3 Critical, 10 High, 2 Medium
**Reviewers:** Security Adversary, Failure Mode Analyst, Assumption Destroyer (all evidence-backed, file:line)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | `SUM(tokens)` sums a JSON TEXT column → token total always 0 | Critical | Accept | Phase 2 (read aggregate, sum int cols) |
| 2 | Day boundary: `getLocalDateKey` returns a string, timestamps are UTC ISO → wrong window | Critical | Accept | Phase 2 (read `usageDaily` by dateKey, no timestamp predicate) |
| 3 | Check at request-entry but tokens written post-completion → single-shot token bomb never alerts | Critical | Accept | Phase 3 (move to post-write `statsEmitter` hook) |
| 4 | No `apiKey` index → full scan on hot path; contradicts "no schema change" | High | Accept | Phase 2 (O(1) `usageDaily` PK read) |
| 5 | Dedup Map unbounded + non-atomic across await + restart storm | High | Accept | Phase 3 (sync slot-claim + evict/sweep) |
| 6 | Alerts silently dead unless `WARMUP_NOTIFY_ENABLED`; ENV frozen | High | Accept | Phase 1 (UI channel-status warning) + Phase 3 |
| 7 | Raw-key leak via generic payload `fields` spread / name lookup | High | Accept | Phase 3 (reader returns masked only; payload string test) |
| 8 | `keyHash` private in botGuard.js → not importable | High | Accept | Phase 2 (extract shared `keyHash.js`) |
| 9 | `updateSettings` shallow merge → partial write clobbers siblings; no clamp | High | Accept | Phase 1 (send full object; clamp percent 1-100) |
| 10 | Budget alerts bypass notifier global limiter → alert-flood | High | Accept | Phase 3 (dedicated hourly cap) |
| 11 | Fire-and-forget sync throw escapes `.catch` | High | Accept | Phase 3 (off hot path + sync try/catch) |
| 12 | Alert-only = unbounded mining; CLI-token path uncovered; fire-once | High | Accept (partial) | plan.md tradeoff + Phase 3 re-alert + CLI decision |
| 13 | Multi-instance: per-process dedup → dup/never-fire, undocumented | High | Accept | plan.md single-instance constraint + Phase 4 docs |
| 14 | Edge ASN/Turnstile may block `/v1` SDK from datacenters | Medium | Accept | Phase 4 (`location ^~ /v1` exclusion + smoke test) |
| 15 | fail2ban probe-jail bans spoofed-XFF victim | Medium | Accept | Phase 4 (jail off-by-default; ban off nginx log) |

**Finding 12 — user-decision guard:** alert-only is the user's confirmed choice. NOT reversed to auto-block. Accepted scope = honesty (worst-case quantified above), re-alert escalation, and an explicit CLI-token-path coverage decision (Phase 3). Auto-disable remains out of scope.

### Whole-Plan Consistency Sweep (red-team)
Performed after applying findings. Decision deltas reconciled across all files: trigger point moved request-entry → post-completion (plan.md + phase-02 + phase-03); token source `SUM(tokens)` → `usageDaily.byApiKey` integer sums (phase-02); `keyHash` reuse → extract shared module (plan.md + phase-02 + phase-03); "no schema change/indexed" claim corrected (plan.md + phase-02); dedup Map → sync-claim + evict/sweep (phase-03); notifier env coupling surfaced (plan.md + phase-01 + phase-03). No stale request-entry/`SUM(tokens)`/private-keyHash references remain. Zero unresolved contradictions.

## Validation Log

### Session — 2026-06-01
Verification pass skipped per guard: `## Red Team Review` already carries file:line evidence; no `[UNVERIFIED]` tags remained.

Decision points confirmed (all matched existing plan defaults — no phase changes required):

| Topic | Decision | Effect |
|-------|----------|--------|
| Budget defaults | Moderate: `tokenPerDay=5_000_000`, `requestPerDay=5000`, `warnAtPercent=80` | Confirms Phase 1 default block (still a `TODO(human)` tuning point at cook) |
| Notifier gate (Finding 6) | Reuse `WARMUP_NOTIFY_*`; budget alerts fire only when `WARMUP_NOTIFY_ENABLED=true`; UI warns when budgets on + no channel | Confirms Phase 1 + Phase 3 design; no independent notifier enable |
| Instance count | Single-instance (accept v1 constraint) | Confirms in-memory dedup is sufficient; no DB-CAS dedup; clustering documented as unsupported |

### Whole-Plan Consistency Sweep (validation)
No plan edits were needed — all three decisions confirmed pre-existing defaults. Re-read all files: no new contradictions introduced. Zero unresolved contradictions.
