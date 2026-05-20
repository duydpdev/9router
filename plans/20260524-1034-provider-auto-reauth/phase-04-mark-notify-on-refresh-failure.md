---
phase: 4
title: "Mark + notify on refresh failure"
status: pending
priority: P1
effort: "3-4h"
dependencies: [1, 2, 3]
---

# Phase 4: Mark + notify on refresh failure (Case B detection)

## Overview

Wrap `getAccessToken` / `forceRefresh` in `checkAndRefreshToken` with a refusal-classifier. When the classifier identifies a dead refresh token (`invalid_grant`, `refresh_token_reused`, persistent 401 from refresh endpoint), call `markNeedsReauth` and fire `notifyReauthRequired`. Transient errors (timeouts, 5xx from token endpoint) keep retrying as before — do NOT misclassify as Case B.

## Requirements

- Functional
  - New classifier `isFatalRefreshFailure(error|response)` returns one of:
    - `null` — transient / unknown → leave creds alone, return original.
    - `"invalid_grant"` — refresh-token rejected.
    - `"refresh_family_revoked"` — Codex / Google family rotation.
    - `"refresh_http_error"` — refresh endpoint returns persistent 4xx (after one retry).
  - `checkAndRefreshToken` catches refresh errors, classifies, on fatal → calls `markNeedsReauth(connectionId, { reason })` + `notifyReauthRequired({ connection, reason, reauthAt })`.
  - `forceRefresh` (from Phase 2) shares the same classifier and same fatal-path.
  - Notifier call is `await`-ed inside a try/catch that swallows errors — request path never crashes.
- Non-functional
  - Refresh paths still return the *original* credentials on fatal failure so the calling handler can present a graceful 503 (combo fallback handles the request retry).
  - Existing log lines preserved (kept "Token expiring soon, refreshing proactively" + new "Token refresh failed (fatal: invalid_grant), marking needsReauth").

## Architecture

```
checkAndRefreshToken / forceRefresh
   ├── try getAccessToken(provider, creds)
   │     ├── success → persist, return new creds
   │     └── failure (caught) ──┐
   │                             ↓
   │                  classify(error|response)
   │                             ├── null (transient) → log warn, return creds unchanged
   │                             └── fatal ──┐
   │                                          ↓
   │                                 reauthAt = ISO now
   │                                 await markNeedsReauth(connId, { reason, reauthAt })
   │                                 fire-and-forget:
   │                                    notifyReauthRequired({ connection, reason, reauthAt })
   │                                       .catch(log)
   │                                 return creds unchanged
   └──
```

Note: `getAccessToken` already returns `{ error: "invalid_grant" }` for Codex (line 270 in `open-sse/services/tokenRefresh.js`). For other providers it throws or returns null. The classifier handles both shapes.

## Related Code Files

- Modify: `src/sse/services/tokenRefresh.js` — wrap `checkAndRefreshToken` and `forceRefresh` with classifier + reauth path
- Create: `src/lib/oauth/refresh-failure-classifier.js`
- Create: `tests/oauth/refresh-failure-classifier.test.js`
- Create: `tests/sse/services/token-refresh-fatal.test.js`

## TDD — failing tests first

`refresh-failure-classifier.test.js`:
1. Error message `"invalid_grant"` → `"invalid_grant"`.
2. Error message `"invalid_request"` → `"invalid_grant"` (RFC 6749 treats this similarly for refresh).
3. Error object `{ error: "invalid_grant" }` → `"invalid_grant"`.
4. Error message `"refresh_token_reused"` → `"refresh_family_revoked"`.
5. Error message `"token_expired"` (from refresh endpoint, not the access token itself) → `"invalid_grant"`.
6. HTTP 400 + body containing `"invalid_grant"` → `"invalid_grant"`.
7. HTTP 401 from refresh endpoint, no body match → `"refresh_http_error"`.
8. HTTP 500 / timeout / ECONNRESET → `null` (transient).
9. Plain `null` / `undefined` input → `null`.

`token-refresh-fatal.test.js`:
10. Mock `getAccessToken` to throw `Error("invalid_grant")` → `checkAndRefreshToken` calls `markNeedsReauth` with `reason="invalid_grant"`.
11. Same as #10 → `notifyReauthRequired` is called once.
12. Mock `getAccessToken` to return `{ error: "invalid_grant" }` (Codex shape) → fatal path hit.
13. Mock `getAccessToken` to throw ECONNRESET → fatal path NOT hit, original creds returned.
14. Two concurrent calls trigger fatal path → `markNeedsReauth` called twice but `markReauthNotified` (inside notifier) dedupes — only one webhook call (cross-references Phase 3 dedup test).
15. Fatal path → `checkAndRefreshToken` returns the ORIGINAL credentials (NOT the new ones, which don't exist).
16. Notifier rejection (`Promise.reject(new Error("webhook 500"))`) does NOT cause `checkAndRefreshToken` to throw.

Run all → confirm red.

## Implementation Steps

1. **Write failing tests** (1–16). Confirm red.
2. Implement `src/lib/oauth/refresh-failure-classifier.js`:
   ```js
   const FATAL_GRANT_PATTERNS = [
     /invalid_grant/i, /invalid_request/i, /token_expired/i,
     /expired_token/i, /unauthorized_client/i,
   ];
   const FAMILY_ROTATION_PATTERNS = [
     /refresh_token_reused/i, /token has been used/i,
   ];

   export function isFatalRefreshFailure(input) {
     if (input == null) return null;

     // String shape
     if (typeof input === "string") {
       if (FAMILY_ROTATION_PATTERNS.some(r => r.test(input))) return "refresh_family_revoked";
       if (FATAL_GRANT_PATTERNS.some(r => r.test(input))) return "invalid_grant";
       return null;
     }

     // Error / object shape
     const msg = input.message ?? input.error_description ?? input.error ?? "";
     const status = Number(input.status ?? input.statusCode);

     if (FAMILY_ROTATION_PATTERNS.some(r => r.test(String(msg)))) return "refresh_family_revoked";
     if (FATAL_GRANT_PATTERNS.some(r => r.test(String(msg)))) return "invalid_grant";

     // HTTP 4xx from refresh endpoint without a recognized body → refresh_http_error
     if (status >= 400 && status < 500 && status !== 429) return "refresh_http_error";

     return null;
   }
   ```
3. Modify `src/sse/services/tokenRefresh.js::checkAndRefreshToken`:
   - Wrap the inner `getAccessToken(...)` call in `try { ... } catch (err) { ... }`.
   - Also check the returned object for `{ error: "..." }` (Codex shape).
   - On fatal: call helper `await handleFatalRefresh(provider, creds, reason)`:
     ```js
     async function handleFatalRefresh(provider, creds, reason) {
       const reauthAt = new Date().toISOString();
       await markNeedsReauth(creds.connectionId, { reason, reauthAt });
       // fire-and-forget notify; do not block request
       notifyReauthRequired({
         connection: { id: creds.connectionId, provider, name: creds.connectionName, email: creds.email },
         reason,
         reauthAt,
       }).catch(err => log.warn("REAUTH_NOTIFY", `Notify failed: ${err?.message ?? err}`));
     }
     ```
   - Return `creds` (the original) unchanged on fatal.
4. Mirror the same handler in `forceRefresh` (Phase 2 added). Both paths share `handleFatalRefresh`.
5. Run tests — green.
6. Manual smoke: temporarily set `refreshToken` to garbage on one OAuth connection, fire a chat request. Confirm:
   - DB row has `needsReauth=true`, `reauthReason="invalid_grant"`, `reauthAt=...`.
   - Discord webhook arrives with `[REAUTH]` prefix + correct deep-link.
   - Repeating the request → second webhook does NOT fire (dedup hit).

## Success Criteria

- [ ] Classifier returns correct enum for 9 input cases.
- [ ] `checkAndRefreshToken` and `forceRefresh` both invoke `markNeedsReauth` + `notifyReauthRequired` on fatal.
- [ ] Transient errors do NOT trigger reauth path.
- [ ] Request path never throws due to notifier failure.
- [ ] Two concurrent fatal-triggers send exactly one webhook (Phase 3 dedup verified end-to-end).

## Risk Assessment

| Risk | Mitigation |
| ---- | ---------- |
| Classifier false-positive marks a transient hiccup as fatal | Conservative regex set + HTTP-status guard. Phase 8 E2E test injects transient (500, timeout) failures and asserts `needsReauth` is NOT set. |
| Classifier false-negative misses a provider-specific message | Add provider-specific patterns as they are observed. Open issue in CHANGELOG with current pattern list. |
| `notifyReauthRequired` runs after request has already returned (fire-and-forget) | Acceptable — webhook delivery is async, user reads it in their channel. Test #16 verifies the request path is unaffected. |
| `markNeedsReauth` write fails (DB locked) | Logged; next failed request will retry the mark. Dedup absorbs the retry-notify. |

## Next Steps

Phase 5 makes `getProviderCredentials` skip `needsReauth=true` connections so combo fallback hops to the next account immediately instead of trying a doomed request.

## Red Team Adjustments — 2026-05-24

Findings **F2, F8** accepted. Classifier reframed; detection path widened.

### F2 — `getAccessToken` does NOT throw `{error:"invalid_grant"}` for 9/12 providers (CRITICAL)

Plan's Architecture note (line 52) "Codex returns `{error:"invalid_grant"}`" is **wrong**. Verified shapes in `open-sse/services/tokenRefresh.js`:

Verified refresh fns in `open-sse/services/tokenRefresh.js` (names confirmed via `grep "^export async function refresh"`):

| Function (line) | Used by provider(s) | Failure shape on dead refresh |
|---|---|---|
| `refreshClaudeOAuthToken` (122) | claude | **returns `null`** on `!response.ok` |
| `refreshGoogleToken` (155) | antigravity, gemini-cli (shared) | **returns `null`** on `!response.ok` |
| `refreshQwenToken` (189) | (qwen — commented out in OAUTH_PROVIDERS) | **returns `null`** |
| `refreshCodexToken` (246) | codex | `{ error: "unrecoverable_refresh_error", code: "refresh_token_reused" \| "invalid_grant" \| "token_expired" \| "invalid_token" }` — tagged already |
| `refreshKiroToken` (315) | kiro (FREE_PROVIDERS) | verify behavior |
| `refreshIflowToken` (405) | (iflow — commented out) | **returns `null`** |
| `refreshGitHubToken` (450) | github | **returns `null`** |
| `refreshCopilotToken` (496) | github copilot follow-up | **returns `null`** |
| `refreshXaiToken` (8) | xai | verify behavior |
| `refreshVertexToken` (756) | vertex (apikey/SA) | n/a — no refresh-token flow |
| cursor / gitlab-pat / github-device-flow | — | `refreshToken: null` at insertion; no refresh path. Routed to `manual_reimport_needed` UX (see Phase 6 F9). |

**Plan's classifier only matches `/invalid_grant/` on `input.error` or `input.message` → never fires for 9 of 12 providers.** Case B detection silently broken for >80% of providers.

**Two coordinated fixes:**

1. **Refactor refresh primitives to return tagged-error objects, NOT bare `null`.** In each provider refresh fn (`refreshClaudeToken`, `refreshGoogleToken`, `refreshQwenToken`, `refreshGeminiCliToken`, `refreshAntigravityToken`, `refreshKiroToken`, `refreshGithubToken`, `refreshIflowToken`, `refreshQoderToken`), replace `return null;` after `!response.ok` with:
   ```js
   return { error: "refresh_failed", status: response.status, body: text };
   ```
   Existing callers that test `!newCreds?.accessToken` continue to work (no `accessToken` key on error object).

2. **Reuse `isUnrecoverableRefreshError(input)` from `open-sse/services/tokenRefresh.js:42-50` as the first-line classifier.** Add only the gaps it doesn't cover (Codex `"unrecoverable_refresh_error"` code → "refresh_family_revoked" mapping).

Rewrite classifier:
```js
import { isUnrecoverableRefreshError } from "@/open-sse/services/tokenRefresh.js"; // add export

export function isFatalRefreshFailure(input) {
  if (input == null) return null;
  // Codex shape — tagged
  if (input.error === "unrecoverable_refresh_error") {
    return input.code === "refresh_token_reused" ? "refresh_family_revoked" : "invalid_grant";
  }
  // Reuse existing detector
  if (isUnrecoverableRefreshError(input)) return "invalid_grant";
  // Family rotation patterns
  if (FAMILY_ROTATION_PATTERNS.some(r => r.test(String(input.message ?? input.error ?? input)))) {
    return "refresh_family_revoked";
  }
  return null;
}
```

Update test #3 (`{ error: "invalid_grant" }` → `"invalid_grant"`) — still passes via `isUnrecoverableRefreshError`. Drop test #7 catch-all (see F8). Add test #11 — `{ error: "unrecoverable_refresh_error", code: "refresh_token_reused" }` → `"refresh_family_revoked"`.

### F8 — Drop catch-all `refresh_http_error` for any 4xx (HIGH)

Original classifier returns `refresh_http_error` for any HTTP `>=400 <500 !== 429`. Transient 4xx is common: Google `temporarily_unavailable`, Auth0 burst 403, GitHub `secondary_rate_limit`, `slow_down`. Marking these fatal → false `needsReauth` → user paged → reconnect works first try because token wasn't actually dead.

**Corrections:**

1. **Remove the catch-all** `if (status >= 400 && status < 500 && status !== 429)` branch from the classifier.
2. **Add explicit transient patterns:**
   ```js
   const TRANSIENT_PATTERNS = [
     /temporarily_unavailable/i, /service_unavailable/i,
     /secondary_rate_limit/i, /slow_down/i, /try_again/i,
   ];
   ```
   If body matches → return `null` (transient).
3. **For HTTP-only fatal classification, require body match.** Status alone is insufficient.
4. **Optional escalation (future, not this phase):** require 2+ HTTP-only failures within N minutes before marking fatal. Adds a failure-counter column. Skip for now — F2's tagged-error shape already covers the strongest signal.

Drop test #7. Replace with #7a — `HTTP 400 + body "temporarily_unavailable"` → `null`. #7b — `HTTP 400 + body "invalid_grant"` → `"invalid_grant"`.

### F13 cont. — Fire-and-forget notify in serverless (locked design 2026-05-24)

**Decision: CAS-first + rollback on total fanout failure** (option a, see plan.md Red Team Review → Resolved decisions).

Pattern: `markReauthNotified` claims the slot BEFORE fanout. After fanout, if zero channels delivered, **roll back** the claim so the next failed request re-fires. This is airtight under concurrent failures AND survives serverless mid-`fetch` kill (next request observes `reauthNotifiedAt=null` and re-fires).

`handleFatalRefresh` in `tokenRefresh.js`:
```js
async function handleFatalRefresh(provider, creds, reason) {
  const reauthAt = new Date().toISOString();
  await markNeedsReauth(creds.connectionId, { reason, reauthAt });
  // Best-effort await with bounded budget — never block request path > 2s
  try {
    await Promise.race([
      notifyReauthRequired({
        connection: { id: creds.connectionId, provider, name: creds.connectionName, email: creds.email },
        reason, reauthAt,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("notify_timeout_2s")), 2000)),
    ]);
  } catch (err) {
    log.warn("REAUTH_NOTIFY", `Notify failed: ${err?.message ?? err}`);
  }
}
```

`notifyReauthRequired` in `reauth-alert.js` is responsible for the CAS-then-rollback contract:
```js
export async function notifyReauthRequired({ connection, reason, reauthAt }) {
  // 1) CAS — claim the slot
  const claimed = await markReauthNotified(connection.id, { reauthAt });
  if (!claimed) return { notified: false, deduped: true };

  // 2) Fanout
  const cfg = getNotifierConfig();
  if (!cfg.enabled) return { notified: false, disabled: true };
  const tasks = [];
  if (cfg.discord?.url) tasks.push(sendDiscord(cfg.discord.url, buildReauthDiscordPayload(ctx)));
  if (cfg.telegram?.token && cfg.telegram?.chatId) tasks.push(sendTelegram(cfg.telegram.token, cfg.telegram.chatId, buildReauthTelegramText(ctx)));
  if (cfg.generic?.url) tasks.push(sendGeneric(cfg.generic.url, buildReauthGenericPayload(ctx)));
  const results = await Promise.allSettled(tasks);
  const delivered = results.filter(r => r.status === "fulfilled").length;

  // 3) Rollback if no channel delivered
  if (delivered === 0) {
    await compareAndUpdateProviderConnection(
      connection.id,
      row => row.reauthAt === reauthAt && row.reauthNotifiedAt != null,
      { reauthNotifiedAt: null },
    );
    return { notified: false, rolledBack: true, channels: results.length };
  }

  return { notified: true, channels: results.length, delivered };
}
```

Add test #17 — `notifyReauthRequired` when all channels reject → `reauthNotifiedAt` is rolled back to `null` (next call returns `claimed=true` again).
Add test #18 — `notifyReauthRequired` when at least one channel fulfills → `reauthNotifiedAt` stays set (no rollback).
