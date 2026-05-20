---
title: "Provider Auto Re-Login (refresh token death detection + 1-click reconnect)"
description: "Detect dead refresh tokens, mark connections needsReauth, notify via warmup webhook, surface 1-click reconnect deep-link. Also fixes proactive refresh missing in tts/stt and adds mid-stream 401 retry-once across all stream handlers."
status: pending
priority: P2
branch: "feature/dylan-improve"
tags: ["oauth", "auth", "providers", "notifier", "reliability"]
blockedBy: []
blocks: []
created: "2026-05-24T03:34:46.036Z"
createdBy: "ck:plan"
source: skill
---

# Provider Auto Re-Login

## Overview

OAuth provider connections currently die in two ways:

- **Case A (refresh-token still alive, access-token expired):** `checkAndRefreshToken` exists in `src/sse/services/tokenRefresh.js` and runs in chat / embeddings / imageGeneration / search / fetch handlers — but `tts.js` and `stt.js` skip it. Also no retry-once on mid-stream 401/403 in any handler except `open-sse/handlers/chatCore.js`. Result: speech requests fail spuriously, transient revocations are not retried.
- **Case B (refresh-token dead — `invalid_grant`, family rotation, idle expiry):** today only `lastError` + `lastErrorType=token_refresh_failed` are written. UI shows generic "AUTH" badge. No notification. User must discover the dead state, find the right provider, and click reconnect manually.

Goal: drive time-to-recovery from "next time I notice" → "1 click after notification". True silent re-login is impossible with standard OAuth; this plan removes friction without storing IdP credentials.

Approach: minimal reactive (no cron, no IdP creds, no headless browser). Detect refresh failure in the existing path, mark connection `needsReauth=true`, fire a single Discord/Telegram/Generic webhook reusing `src/lib/warmup/notifier.js`, link directly to `/dashboard/providers/<provider>?reconnect=<connId>`, and clear the flag on the next successful OAuth callback. Combo fallback auto-skips `needsReauth` connections so coding does not block.

## Phases

| Phase | Name                                                                                                  | Status  |
| ----- | ----------------------------------------------------------------------------------------------------- | ------- |
| 1     | [Foundation (schema + helpers)](./phase-01-foundation-schema-helpers.md)                              | Pending |
| 2     | [Fix Case A (tts/stt refresh + mid-stream retry)](./phase-02-fix-case-a-tts-stt-refresh-mid-stream-retry.md) | Pending |
| 3     | [Reauth notifier (bridge to warmup notifier)](./phase-03-reauth-notifier.md)                          | Pending |
| 4     | [Mark + notify on refresh failure](./phase-04-mark-notify-on-refresh-failure.md)                      | Pending |
| 5     | [Fallback skip needsReauth in getProviderCredentials](./phase-05-fallback-skip-needsreauth.md)        | Pending |
| 6     | [UI deep-link reconnect + badge](./phase-06-ui-deep-link-reconnect.md)                                | Pending |
| 7     | [OAuth callback clears flag + projectId re-fetch](./phase-07-oauth-callback-clear-flag-projectid.md)  | Pending |
| 8     | [E2E smoke + docs/CHANGELOG](./phase-08-e2e-docs.md)                                                  | Pending |

## Dependencies

No cross-plan blocking. Reuses notifier infra from completed plan `20260519-1200-warmup-failure-notifications`. Does NOT touch the pending `20260517-1734-warmup-scheduler-robustness` plan.

## Context Links

- Brainstorm: this session (in-conversation, no separate file)
- Scout: [reports/scout-token-state-surfaces.md](./reports/scout-token-state-surfaces.md)
- Research: [reports/research-oauth-refresh-lifecycle.md](./reports/research-oauth-refresh-lifecycle.md)

## Architecture (one-page summary)

```
┌──────────────────────────────────────────────────────────────────────┐
│ SSE handler (chat/tts/stt/...) — every request                       │
│   getProviderCredentials → SKIP if needsReauth=true (Phase 5)        │
│   checkAndRefreshToken → catches invalid_grant from refreshTokenByProvider │
│        ↓                                                             │
│   markNeedsReauth(connId, reason)  (Phase 4)                         │
│        ├─ writes data.needsReauth=true, reauthReason, reauthAt       │
│        ├─ writes lastErrorType="token_refresh_failed"                │
│        └─ enqueue notifyReauthRequired(conn, deepLink) (Phase 3)     │
│             dedup by (connectionId, reauthAt) — once per incident    │
│             reuses warmup ENV: WARMUP_NOTIFY_ENABLED /                │
│             WARMUP_NOTIFY_DISCORD_WEBHOOK /                           │
│             WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN /                        │
│             WARMUP_NOTIFY_TELEGRAM_CHAT_ID /                          │
│             WARMUP_NOTIFY_GENERIC_WEBHOOK_URL + new PUBLIC_BASE_URL   │
│                                                                      │
│ Combo fallback hops to next account, request succeeds elsewhere      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ User opens deep-link /dashboard/providers/<provider>?reconnect=<id>  │
│   Page reads ?reconnect query (Phase 6)                              │
│   Auto-triggers existing OAuth flow for that connectionId            │
│   User completes IdP login                                           │
│        ↓                                                             │
│   /api/oauth/[provider]/[action] exchange/poll succeeds (Phase 7)    │
│        ├─ updateProviderConnection(accessToken, refreshToken, …)     │
│        ├─ clearNeedsReauth(connId)                                   │
│        └─ for antigravity/gemini-cli → _refreshProjectId(...)        │
└──────────────────────────────────────────────────────────────────────┘
```

## Design decisions (locked from brainstorm)

| Decision                                  | Choice                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Scope                                     | Cover both Case A (proactive refresh hole) + Case B (notify + 1-click)   |
| UX level                                  | Notify + 1-click reconnect (no IdP-cred storage, no headless browser)    |
| Providers                                 | Active OAuth providers from `src/shared/constants/providers.js` OAUTH_PROVIDERS = {claude, antigravity, codex, github, cursor, xai, kilocode, cline}; non-refresh providers (cursor / kiro / iflow / gitlab / qoder / codex-import) get manual-reimport UX track (see Phase 6 F9). Stale plan list (Qwen/iFlow/GitLab/Qoder commented out) corrected post-red-team. |
| Detection                                 | Reactive only (no periodic cron sweep)                                   |
| Fallback on dead refresh token            | Mark `needsReauth`, notify, combo fallback skips connection              |
| Notify channel                            | Reuse warmup ENV vars + notifier module; prefix message `[REAUTH]`       |
| Dedup                                     | 1 notify per `(connectionId, reauthAt)` — until reconnect or new failure |
| Deep-link target                          | `/dashboard/providers/<provider>?reconnect=<connId>` — auto-trigger OAuth |
| Mid-stream 401/403 (Approach 2)           | Include now — audit all 7 handlers, add retry-after-refresh where missing |
| projectId for antigravity / gemini-cli    | Auto re-fetch via existing `_refreshProjectId` on reconnect success      |

## Methodology: TDD per phase

Each phase opens with a failing test or test-suite that pins the desired behavior, followed by the smallest production change to pass. Validation runs against the existing `tests/` directory using **Vitest** (verified: `tests/unit/*.test.js` uses `import { describe, it, expect, vi } from "vitest"`; `tests/package.json:8` declares vitest). Only the warmup-specific `tests/warmup-*.test.mjs` files at repo root use `node --test`; all new tests under `tests/{oauth,sse,notifier,ui}/` follow the Vitest pattern. UI tests in Phase 6 fall back to a pure-helper unit test + manual-smoke checklist (no React Testing Library installed — see Phase 8 F14 adjustments).

## Out of scope

- Periodic background sweep / cron (chose reactive in brainstorm).
- Storing IdP password/cookie for silent re-login (security non-starter).
- Headless browser auto-OAuth (Puppeteer/Playwright) — high complexity, fragile.
- Email notify channel (no SMTP infra).
- Allow user to silence notifications per-connection (can add later if noisy).
- Refactor of `markAccountUnavailable` cooldown system — `needsReauth` is a distinct concept (not a transient cooldown).

## Success criteria (whole plan)

- [ ] STT/TTS request with access-token expired but refresh-token alive → succeeds (proactive refresh fixes Case A in tts/stt).
- [ ] Mid-stream 401 in any of chat/imageGeneration/embeddings/search/fetch/tts/stt → 1 refresh + 1 retry; if still 401, mark `needsReauth`.
- [ ] Injecting `invalid_grant` from `refreshTokenByProvider` → connection marked `needsReauth=true`, exactly one Discord webhook sent with `[REAUTH]` prefix + reconnect URL, combo fallback selects next connection.
- [ ] 100 consecutive failures on the same connection within 1h → 1 webhook (dedup).
- [ ] Click reconnect URL → page auto-opens OAuth flow for the right connection.
- [ ] Complete OAuth → `needsReauth` cleared, no second notification fires; for antigravity/gemini-cli the `projectId` is refreshed.
- [ ] All new tests pass; no existing test regressions.

## Open questions (post-validation)

- Should reconnect URL include a short-lived signed token to prevent CSRF on the `?reconnect=` auto-trigger? Currently dashboard auth cookie already gates the page; revisit in Phase 6 if needed. **Update post-red-team:** Phase 7 now signs the OAuth `state` parameter (HMAC over `connectionId|nonce|timestamp`, 10-min TTL — see Phase 7 F3 adjustments). The `?reconnect=` query is informational only; trust is anchored in the signed state at the exchange step.
- For Codex `refresh_token_reused` family-rotation, do we need a stronger notification ("require full re-login, refresh family invalidated")? Phase 4 can carry a distinct `reauthReason` enum value. **Resolved:** Phase 4 F2 adjustments map Codex `{error:"unrecoverable_refresh_error", code:"refresh_token_reused"}` → `"refresh_family_revoked"` reauthReason. Notifier can render a stronger message conditional on that enum.
- **(NEW from F1)** Should `WARMUP_NOTIFY_ENABLED=false` also suppress reauth notifications? Default in plan: YES (shared gate). If a deployment wants reauth-only, add `REAUTH_NOTIFY_ENABLED` with `cfg.enabled` as default. Confirm with user before implementing.

## Red Team Review

### Session — 2026-05-24

**Reviewers spawned:** 4 (Security Adversary [Fact Checker], Failure Mode Analyst [Flow Tracer], Assumption Destroyer [Scope Auditor], Scope & Complexity Critic [Contract Verifier]).
**Reviewer outcomes:** 3 returned full reports (10 findings each); 1 (Security Adversary) hit Anthropic Usage Policy block mid-run — security-relevant findings still covered via Fact Checker / Scope Auditor / Contract Verifier roles carried by the other three reviewers.
**Findings:** 30 raw → 15 deduped (15 accepted, 0 rejected post evidence-filter — every finding included `file:line` evidence).
**Severity breakdown:** 5 Critical, 8 High, 2 Medium.

| #  | Finding (deduped)                                                                                                      | Severity | Disposition | Applied To |
|----|------------------------------------------------------------------------------------------------------------------------|----------|-------------|------------|
| 1  | Wrong notifier ENV names (`DISCORD_WEBHOOK_URL`≠`WARMUP_NOTIFY_DISCORD_WEBHOOK`); nonexistent `postWebhook` export; `cfg.discord.webhookUrl`/`cfg.telegram.chatIds[]` mismatch; missing `cfg.enabled` gate | Critical | Accept | Phase 3, Phase 8, plan.md |
| 2  | `getAccessToken` returns `null` for 9/12 providers (not `{error:"invalid_grant"}`); Codex returns `{error:"unrecoverable_refresh_error", code}` — classifier silent for most | Critical | Accept | Phase 4 |
| 3  | Phase 7 "generic OAuth session store" doesn't exist for 9/12 providers — must use signed-state JWT instead              | Critical | Accept | Phase 7 |
| 4  | `_refreshProjectId` NOT exported (plan falsely claims line 121) — Phase 7 import would throw                            | Critical | Accept | Phase 7 |
| 5  | Phase 6 modifies `page.new.js` — Next.js routes to `page.js`; `page.new.js` is dead code (1724 LOC, 0 importers)        | Critical | Accept | Phase 6 |
| 6  | `markReauthNotified` CAS is read+write across 2 statements — concurrent failures duplicate webhooks                      | High     | Accept | Phase 1 |
| 7  | Phase 2 mid-stream 401-retry is duplicate work for image/embed/responses — already in their *Core handlers              | High     | Accept | Phase 2 |
| 8  | Classifier returns `refresh_http_error` for any 4xx — marks transient outage (Google `temporarily_unavailable`, Auth0 burst 403, GitHub `secondary_rate_limit`) as fatal | High     | Accept | Phase 4 |
| 9  | Cursor / GitLab PAT / Codex import / iFlow cookie have `refreshToken: null` — no OAuth refresh path; needs separate `manual_reimport_needed` UX | High     | Accept | Phase 6, plan.md |
| 10 | Warmup builders hard-coded to warmup ctx — `kind === "reauth"` needs schema branch + Telegram MarkdownV2 URL escaping + `connectionName` sanitization | High     | Accept | Phase 3 |
| 11 | Rate limiter shared between warmup + reauth — family-revoke burst saturates window, reauth dropped exactly when needed   | High     | Accept | Phase 3 |
| 12 | Phase 5 calls non-existent `getActiveConnections`; double-read race; `.every()` on empty array returns `true` (false `allNeedReauth`) | High     | Accept | Phase 5 |
| 13 | `markNeedsReauth` writes `lastErrorType` (not in `OPTIONAL_FIELDS`); `clearNeedsReauth` never resets it → sticky UI badge after reconnect | High     | Accept | Phase 1, Phase 7 |
| 14 | Plan says `node --test`; repo uses Vitest. All TDD instructions use wrong API; no React Testing Library installed         | Medium   | Accept | plan.md, Phase 8, all phases |
| 15 | `cleanupProviderConnections` keeps hardcoded `fieldsToCheck` mirror at line 235 — Phase 1 only updates `OPTIONAL_FIELDS` at line 5 | Medium   | Accept | Phase 1 |

**Files modified:** `plan.md`, `phase-01-foundation-schema-helpers.md`, `phase-02-fix-case-a-tts-stt-refresh-mid-stream-retry.md`, `phase-03-reauth-notifier.md`, `phase-04-mark-notify-on-refresh-failure.md`, `phase-05-fallback-skip-needsreauth.md`, `phase-06-ui-deep-link-reconnect.md`, `phase-07-oauth-callback-clear-flag-projectid.md`, `phase-08-e2e-docs.md`.

## Validation Log

### Session 1 — 2026-05-24
**Trigger:** Post-red-team interview to lock decision points before cook.
**Verification pass:** Skipped per workflow guard — Red Team Review already provides Fact Checker + Contract Verifier + Scope Auditor evidence (all 15 findings have file:line citations, 0 failed verifications). Pre-grep confirmed: `JWT_SECRET` exists at `src/lib/auth/dashboardSession.js:8`; deployment target is Docker (no `vercel.json`).
**Questions asked:** 4

#### Questions & Answers

1. **[Scope/Tooling]** Phase 6 UI test approach — install React Testing Library?
   - Options: Helper unit test + manual checklist (Recommended) | Install @testing-library/react + happy-dom
   - **Answer:** Helper unit test + manual checklist
   - **Rationale:** Zero new deps; matches existing repo Vitest pattern; auto-trigger gesture is one hook, doesn't justify ~6MB of test-only deps. Confirms Phase 8 F14 fallback.

2. **[Architecture]** Phase 7 POST /exchange with `state.connectionId` pointing to a NON-existent row — behavior?
   - Options: Reject 404 (Recommended) | Fall through to createProviderConnection (new row)
   - **Answer:** Reject 404
   - **Rationale:** Resolves Phase 7 test #4 ambiguity. Prevents orphan-row creation when a user intentionally deletes a connection between notify and reconnect. User receives a clear error; they can re-add from the dashboard.

3. **[Architecture/Security]** Phase 7 signed-state HMAC secret source?
   - Options: Reuse JWT_SECRET (Recommended) | Declare new OAUTH_STATE_SECRET env var
   - **Answer:** Reuse JWT_SECRET
   - **Rationale:** Already exists at `src/lib/auth/dashboardSession.js:8` with file fallback (`DATA_DIR/jwt-secret`). Same trust domain as dashboard auth. One less env var for self-hosters to manage.

4. **[Scope/UX]** Reauth notification body — differentiate by `reauthReason` enum?
   - Options: Include reason as a field only (Recommended) | Custom message per enum value
   - **Answer:** Include reason as a field only
   - **Rationale:** Simpler builder; reason field already in `buildReauthDiscordPayload`. User can read enum value (`invalid_grant`, `refresh_family_revoked`) and act. Custom strings can be added later if support tickets show users need stronger urgency cues.

#### Confirmed Decisions

- **D-V1** Phase 6 UI tests = helper-unit (Vitest) + manual checklist. No new deps.
- **D-V2** Phase 7 unknown-connectionId path → return `404 { error: "connection not found" }`. Update Phase 7 test #4 to assert 404.
- **D-V3** Phase 7 signed-state HMAC uses `JWT_SECRET` from `dashboardSession.js`. Drop `OAUTH_STATE_SECRET` fallback.
- **D-V4** Reauth notification body shows `reauthReason` as a Discord embed field / Telegram line, NOT a per-enum custom string.

#### Action Items

- [ ] Phase 7 F3 adjustment: replace `process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET` with import from `src/lib/auth/dashboardSession.js` (the resolver already handles file fallback) — single source of truth.
- [ ] Phase 7 test #4 spec: pointing to non-existent row → assert 404 (not 200 + create-new).
- [ ] Phase 8 CHANGELOG: confirm no new env var for OAuth state.
- [ ] Phase 3 builder: keep `Reason: <enum>` as a discrete field per D-V4 (already in F10 adjustment — re-confirm during code review).

#### Impact on Phases

- **Phase 6 (F14 fallback):** unit-test + manual checklist locked. Phase 6 "Related Code Files" stays as-is.
- **Phase 7 (F3 adjustment):** secret source narrowed to `JWT_SECRET` resolver. Test #4 disposition locked.
- **Phase 3 (F10):** no change — `Reason: ctx.fields.reason` field already shows enum.
- **Phase 8 (F14):** docs stay terse on env vars; no `OAUTH_STATE_SECRET` mention.

### Whole-Plan Consistency Sweep — Validation Pass

- **Files re-read:** `plan.md`, all 8 phase files.
- **Decision deltas checked:** 4 (D-V1 through D-V4).
- **Reconciled stale references:** 1 — Phase 7 F3 secret resolver simplified (action item below).
- **Unresolved contradictions:** 0.
- **Status:** Plan ready for `/ck:cook`. All 15 red-team findings applied; both red-team-residual contradictions resolved; all 4 validation-pass questions locked.

**Key risks addressed:**
- OAuth re-bind architecture (F3) — pivoted from non-existent session store to signed-state JWT. Effort estimate Phase 7: 3-4h → 6-8h.
- Case B detection (F2) — refactored provider refresh primitives to return tagged-error objects instead of `null`; reused existing `isUnrecoverableRefreshError` helper.
- Atomic dedup (F6) — added `compareAndUpdateProviderConnection` transaction-bounded helper.
- Scope reduction (F7) — Phase 2 narrowed to tts/stt cores; image/embed/responses already covered upstream. Effort Phase 2: 4-6h → 2-3h.
- UI canonical file (F5) — page.js, not page.new.js.
- Non-refresh-capable providers (F9) — separate `manual_reimport_needed` UX track instead of broken auto-OAuth.

### Whole-Plan Consistency Sweep

- **Files re-read:** `plan.md`, `phase-01-foundation-schema-helpers.md`, `phase-02-fix-case-a-tts-stt-refresh-mid-stream-retry.md`, `phase-03-reauth-notifier.md`, `phase-04-mark-notify-on-refresh-failure.md`, `phase-05-fallback-skip-needsreauth.md`, `phase-06-ui-deep-link-reconnect.md`, `phase-07-oauth-callback-clear-flag-projectid.md`, `phase-08-e2e-docs.md`.
- **Decision deltas checked:** 20
  - D1 ENV names → `WARMUP_NOTIFY_*` (Phase 3, Phase 8, plan.md architecture, plan.md table)
  - D2 `postWebhook` removed → `sendDiscord`/`sendTelegram`/`sendGeneric` (Phase 3)
  - D3 `BASE_URL` → `PUBLIC_BASE_URL` w/ path-only fallback (Phase 3, Phase 8)
  - D4 Refresh primitives return tagged-error `{error, status, body}` not `null` (Phase 4)
  - D5 Classifier reuses `isUnrecoverableRefreshError` (Phase 4)
  - D6 `refresh_http_error` catch-all dropped; explicit body match + `TRANSIENT_PATTERNS` (Phase 4)
  - D7 Phase 2 scope reduced to tts/stt cores only via existing `refreshWithRetry` (Phase 2)
  - D8 `forceRefresh` dropped; reuse `executor.refreshCredentials` (Phase 2)
  - D9 `markReauthNotified` atomic CAS via `compareAndUpdateProviderConnection` (Phase 1)
  - D10 `lastErrorType` added to `OPTIONAL_FIELDS`; cleared by `clearNeedsReauth` + Phase 7 exchange (Phase 1, Phase 7)
  - D11 `cleanupProviderConnections` refactored to import `OPTIONAL_FIELDS` (Phase 1)
  - D12 Phase 5 uses `getProviderConnections({provider, isActive: true})`; reuses local list; empty-array guard (Phase 5)
  - D13 Phase 6 modifies `page.js` not `page.new.js`; canonical-route pre-flight grep (Phase 6)
  - D14 `supportsAutomatedReauth(conn)` runtime check — NOT hardcoded NON_REFRESH_PROVIDERS list (Phase 6, Phase 4)
  - D15 Phase 7 architecture pivot — signed-state HMAC JWT for `connectionId` round-trip (Phase 7)
  - D16 `_refreshProjectId → refreshProjectId` with `export` keyword (Phase 7)
  - D17 Phase 4 fire-and-forget bounded with `waitUntil`/timeout; dedup ordering reconciliation pending (see unresolved below)
  - D18 Provider list = live `OAUTH_PROVIDERS` registry (8 active: claude/antigravity/codex/github/cursor/xai/kilocode/cline) (plan.md, Phase 8)
  - D19 Test runner = Vitest (plan.md Methodology, Phase 8, all phases)
  - D20 UI tests = helper-unit + manual checklist (no React Testing Library installed) (Phase 6, Phase 8)
- **Reconciled stale references:** 9
  - Plan.md "Methodology" rewritten (`node --test` → Vitest)
  - Plan.md architecture block ENV vars corrected
  - Plan.md providers row corrected (12 stale → 8 live)
  - Plan.md open-questions extended w/ post-red-team resolutions
  - Phase 4 provider failure-shape table aligned with live `tokenRefresh.js` function names
  - Phase 6 `NON_REFRESH_PROVIDERS` constant replaced with runtime `supportsAutomatedReauth` helper (removes invalid `codex-import` provider id)
  - Phase 3 fanout block re-tied to real config shape
  - Phase 7 `_refreshProjectId` line-121 verification claim removed (was false)
  - Phase 5 `.every` empty-array bug guarded
- **Unresolved contradictions:** 0 (both resolved by user 2026-05-24)

#### Resolved decisions (locked 2026-05-24)

1. **Dedup ordering** → **(a) CAS-first + rollback on total fanout failure.** `markReauthNotified` claims the slot before fanout; after `Promise.allSettled`, if zero promises fulfilled, run `compareAndUpdateProviderConnection` to reset `reauthNotifiedAt = null` (restore claim). Cost: one extra DB write on the rare full-failure path. Applies to Phase 1 (CAS helper), Phase 3 (fanout + rollback), Phase 4 (caller). Drop the F13-cont "move CAS to AFTER fanout" advice.

2. **Master notification gate** → **shared.** `WARMUP_NOTIFY_ENABLED=false` suppresses BOTH warmup and reauth notifications. No new `REAUTH_NOTIFY_ENABLED` env var. Document in Phase 8 CHANGELOG: "Reauth notifications honor the existing `WARMUP_NOTIFY_ENABLED` master gate."

#### Implementer guidance (post-sweep)

- Each phase file ends with a `## Red Team Adjustments — 2026-05-24` section. Those sections **supersede** any conflicting code blocks in the body of the same phase. Read the entire phase before starting.
- Original code snippets in Phase 3 step 3, Phase 5 step 2, Phase 6 "Related Code Files", and Phase 7 step 6 are KNOWN STALE — left in place for traceability of what the red team caught; do not copy them verbatim.
