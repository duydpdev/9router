---
phase: 3
title: "Runner usage poll"
status: completed
priority: P1
effort: "8h"
dependencies: [1, 2]
---

# Phase 3: Runner usage poll

## Overview

After a warmup returns 200, for Claude/Codex poll the usage endpoint (with token refresh + proxy + served-account check), classify via Phase 2, persist `resetsAt`/`utilization`/`sessionState`. **Run `status` stays `success`/`failure`** — the session signal is the `session_state` column. On `not-registered`, do a single confirmation re-poll before committing, then notify. This phase carries the three empirical gates G1–G3.

## Requirements

- Functional: enrich every Claude/Codex success warmup; non-session → `sessionState='n/a'`. `not-registered` is recorded (status still `success`) and routed to the not-registered notifier (real-time) or digest bucket (catch-up).
- Non-functional: usage poll failure NEVER fails the warmup (→ `unknown`). Exactly one usage GET per warmup in the happy path; at most one extra re-poll only when the first says `not-registered`.

## Architecture

### Shared usage helper (Findings 2, 3)
Extract `fetchUsageForConnection(connectionId)` from the usage route body (`route.js:128-163`) into a reusable module (e.g. `src/lib/usage/fetch-usage-for-connection.js`). It must: re-fetch the connection by id (picking up any token the warmup chat just refreshed and persisted, `chat.js:257-264`), `resolveConnectionProxyConfig(connection.providerSpecificData)`, `refreshAndUpdateCredentials(connection, false, proxyOptions)` for OAuth, then `getUsageForProvider(connection, proxyOptions)` with the route's single auth-expired retry. Return `{ usage, authoritative }` where `authoritative` is true only for the OAuth/primary shape (NOT Claude legacy fallback — detect via the `{message}`-without-`quotas` or org-usage shape, `usage.js:591-606`). Call this from BOTH the route (DRY) and the runner.

### probeSession in runner.js
After `sendWarmupRequest` resolves:
1. Hoist `const actualRanAt = new Date().toISOString()` here (currently inline at the `appendWarmupRun` call, `runner.js:59`) and reuse it for the run row.
2. **Served-account check (G2, Finding 3):** determine which connection actually served the warmup. `handleInternalWarmupChat` must surface the served connectionId. If served ≠ pinned → `sessionState='n/a'` with no poll (it's a known router divert, not a mystery) — optionally tag the row so the UI can show "served by other account". Do NOT classify `not-registered` in this case. **G2 fallback (user-confirmed):** if the handler CANNOT surface the served connectionId, classify session-provider warmups as `unknown` (never `not-registered`) and surface the limitation — do not risk false alerts.
3. If `provider ∉ {claude,codex}` → `{ sessionState:'n/a', resetsAt:null, utilization:null }`, no poll.
4. `const { usage, authoritative } = await fetchUsageForConnection(connection.id)` in try/catch; `usageOk = !!usage && !!usage.quotas` (claude legacy `{message}` → falsy quotas → `unknown`).
5. Extract the normalized quota: claude → `usage.quotas["session (5h)"]`, codex → `usage.quotas["session"]`.
6. `let r = classifyWarmupSession({ provider, quota, usageOk, authoritative })`.
7. **Confirmation re-poll (Finding 7, G3):** if `r.sessionState === 'not-registered'`, wait a short delay (**default 5s**, tune from G3) and re-poll once. Only keep `not-registered` if the second poll also says so; otherwise upgrade to the second result. This absorbs usage-endpoint propagation lag and prevents alert churn. Make the delay a named constant (injectable in tests so the suite doesn't sleep 5s).
8. Persist via `appendWarmupRun({ ...runFields, status, resetsAt:r.resetsAt, utilization:r.utilization, sessionState:r.sessionState })` where `status` is the EXISTING success/failure value (unchanged), and `actualRanAt` is the hoisted constant.

### Notify routing (Findings 5, 6)
The runner's notify logic is split: a success/recovery branch (`runner.js:68-100`, calls `recordSuccess`) and a failure `catch` branch (`runner.js:103-153`). `not-registered` arrives on the SUCCESS path. So:
- Real-time (`notify === "scheduler"`): after persisting, if `sessionState === 'not-registered'`, call `notifyWarmupNotRegistered` (Phase 4). Do this independently of the recovery logic — `recordSuccess` may still run (the request did succeed), but the not-registered alert fires regardless. Document the ordering explicitly so the alert isn't swallowed by the recovery threshold.
- Digest/catch-up (`runWarmupItems`, `notify === "digest"`): per-item notify is suppressed (`runner.js:167`) and the digest batch currently filters `result?.status === "failure"` (`runner.js:171`). Add a SEPARATE collection branch keyed on `result?.sessionState === 'not-registered'` into a `notRegisteredBatch`, and send it (Phase 4 digest). Update the send-gate so it fires when `digestBatch.length || notRegisteredBatch.length`.

Imports: `classifyWarmupSession` from `@/lib/warmup/session-state`; `fetchUsageForConnection` from the new helper.

### Dedupe (plan Design #1)
No new status. The dedupe row is written with the run's normal `status` (`success` for a 200). The earlier "leave the slot open" idea is dropped — flag+notify is the deliverable, not re-run.

## Related Code Files

- Create: `src/lib/usage/fetch-usage-for-connection.js` (extracted shared helper).
- Modify: `src/app/api/usage/[connectionId]/route.js` — call the shared helper (DRY).
- Modify: `src/lib/warmup/runner.js` — `probeSession`, hoist `actualRanAt`, served-account gate, confirmation re-poll, persist new fields, notify routing (real-time + digest bucket).
- Modify: `open-sse/services/usage.js` — only if G1 confirms Codex needs `resetAt` derived from `resets_in_seconds` in `formatCodexWindow`.
- Read: `src/app/api/usage/[connectionId]/route.js`, `src/lib/db/repos/connectionsRepo.js:73-77`, `src/sse/services/auth.js` (refresh), `src/sse/handlers/chat.js:257-277`.
- Create/Modify: `tests/warmup-runner-session.test.mjs`.

## Implementation Steps

1. **Resolve gates first.** G1: capture a live Codex `/usage` response; if `resets_in_seconds`-only, extend `formatCodexWindow` (+ usage-layer test) so `resetAt` is populated. G2: verify served-connection is obtainable; if not, decide fallback (treat session-provider warmups as `unknown` rather than `not-registered`, and surface the limitation) — record the decision in this file. G3: measure propagation lag → set the re-poll delay.
2. **(TEST FIRST)** `tests/warmup-runner-session.test.mjs` (seam: make `fetchUsageForConnection` injectable/stubbable, mirroring how existing warmup tests isolate the chat handler):
   - stub 200 + usage with fresh `session (5h)` window → `status='success'`, `sessionState='active'`, `resetsAt` set.
   - stub usage with NO session window, `authoritative:true`, AND re-poll also empty → `sessionState='not-registered'`, status still `success`, dedupe row = `success` (slot NOT special).
   - stub first poll empty but re-poll returns a window → `sessionState='active'` (confirmation re-poll absorbs lag, Finding 7).
   - stub Claude legacy `{message}`-without-quotas → `sessionState='unknown'` (Finding 11), status `success`.
   - stub `fetchUsageForConnection` throwing → `sessionState='unknown'`, warmup still `success`.
   - non-session provider (`qwen`) → no poll, `sessionState='n/a'`.
   - served ≠ pinned (fallback) → `sessionState='n/a'`, no `not-registered` (Finding 3).
   - digest mode: a `not-registered` item lands in `notRegisteredBatch` and triggers a send (Finding 6).
   - Run → fails.
3. Build the shared helper; wire the route to it; confirm route tests still pass.
4. Implement `probeSession` + notify routing in `runner.js`.
5. Run → passes.

## Success Criteria

- [ ] Poll refreshes token + resolves proxy (reuses route logic via shared helper).
- [ ] Served ≠ pinned → not classified `not-registered` (G2).
- [ ] Confirmation re-poll prevents transient false `not-registered`.
- [ ] Claude legacy / poll-failure → `unknown`, warmup still `success`.
- [ ] Run `status` unchanged (no new value); `session_state` carries the signal.
- [ ] Real-time + digest both surface `not-registered`.
- [ ] G1/G2/G3 decisions recorded in this file before sign-off.

## Risk Assessment

- G1 unresolved → Codex false positives (Critical). Mitigation: gate; Claude-only fallback.
- G2 unresolved → `not-registered` unreliable on fallback. Mitigation: served-account gate; if unobtainable, downgrade to `unknown` + surface.
- Extra re-poll adds latency only on the `not-registered` path. Bounded to one.
- `actualRanAt` drift eliminated by hoisting + removal of tolerance math.

## Security Considerations

- Reuse proxy-aware fetch; never log access tokens. Token refresh persists via the existing `updateProviderCredentials` path. Usage response carries utilization %, not message content.

## Gate Resolutions (recorded at implementation)

- **G1 — Codex window shape:** Handled defensively in `formatCodexWindow` (`usage.js`): if no absolute `reset_at`/`resets_at`, derive `resetAt = now + resets_in_seconds` (also `reset_after_seconds`/`resets_in`/`seconds_until_reset`). Unit-tested in `tests/warmup-codex-window.test.mjs` against a synthetic duration-only window. NOT live-verified (no prod Codex creds in this session) — the derivation covers both observed shapes, so Codex stays in scope.
- **G2 — served-account exposure:** SOLVED. `handleInternalWarmupChat` threads a `servedRef` through `handleSingleModelChat` (set on the success branch) and stamps `x-9router-served-connection-id` on the response. `sendWarmupRequest` returns `{ servedConnectionId }`. Zero impact on `handleChat` (ref defaults null). Fallback honored: if the header is absent (e.g. immutable streaming response), `probeSession` classifies `unknown`, never `not-registered`.
- **G3 — propagation lag:** Re-poll delay defaulted to `NOT_REGISTERED_REPOLL_MS = 5000` (named export, injectable; tests pass `repollDelayMs: 0` + no-op `sleep`). NOT empirically measured on the prod VPS — 5s is the user-confirmed default; tune later if false `not-registered` alerts appear.

## Next Steps

Phase 4 implements `notifyWarmupNotRegistered` + digest section; Phase 5 renders the fields.
