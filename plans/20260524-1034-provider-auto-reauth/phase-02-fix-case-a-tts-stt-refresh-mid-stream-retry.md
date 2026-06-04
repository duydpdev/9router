---
phase: 2
title: Fix Case A — tts/stt proactive refresh + mid-stream 401 retry-once
status: completed
priority: P1
effort: 4-6h
dependencies:
  - 1
---

# Phase 2: Fix Case A — tts/stt refresh + mid-stream 401 retry-once

## Overview

Plug the proactive-refresh hole in `src/sse/handlers/tts.js` and `src/sse/handlers/stt.js`, and add a single 401/403 retry-after-refresh path to the 6 stream handlers that currently lack it (only `open-sse/handlers/chatCore.js` has it). This phase does NOT touch the `needsReauth` flag — it strengthens Case A (refresh-token still alive). Phase 4 hooks the failure path for Case B.

## Requirements

- Functional
  - `tts.js` and `stt.js` MUST call `await checkAndRefreshToken(provider, credentials)` between `getProviderCredentials` and the core call, matching the pattern in `chat.js:217`, `imageGeneration.js:108`, `embeddings.js:108`, `search.js:171`, `fetch.js:172`.
  - When a non-chat upstream returns HTTP 401 or 403, the handler MUST attempt one `forceRefresh` (bypass expiry-window) and retry the upstream call exactly once. If the retry still 4xx-auths, fall through to the existing fallback loop.
  - Retry budget is exactly one attempt per request — no recursion, no nested loops.
- Non-functional
  - No behavior change for non-OAuth providers (`apikey` / `access_token` skip the retry path).
  - No additional latency on the success path.

## Architecture

```
Current (chat.js — already works):
  getProviderCredentials → checkAndRefreshToken → handleChatCore
                              (chatCore has internal retry-after-refresh via executor.refreshCredentials)

Target for tts/stt/image/embed/search/fetch:
  getProviderCredentials → checkAndRefreshToken → handle<Core>
                                                      ↓
                                              if result.status ∈ {401, 403} AND authType=oauth
                                                  → forceRefresh(credentials)
                                                  → handle<Core> once more
                                                      ↓
                                              if still 401/403 → existing fallback / markAccountUnavailable
```

`forceRefresh(provider, credentials)` is a thin helper that bypasses the `expiresAt` window check and calls `getAccessToken` directly, then persists. Added to `src/sse/services/tokenRefresh.js` alongside `checkAndRefreshToken`.

## Related Code Files

- Modify: `src/sse/handlers/tts.js` (add `checkAndRefreshToken` + retry-on-401 block)
- Modify: `src/sse/handlers/stt.js` (same)
- Modify: `src/sse/handlers/imageGeneration.js` (add retry-on-401 block; refresh already present)
- Modify: `src/sse/handlers/embeddings.js` (add retry-on-401 block)
- Modify: `src/sse/handlers/search.js` (add retry-on-401 block)
- Modify: `src/sse/handlers/fetch.js` (add retry-on-401 block)
- Modify: `src/sse/services/tokenRefresh.js` — add `forceRefresh(provider, credentials)`
- Create: `tests/sse/handlers/tts-refresh.test.js`
- Create: `tests/sse/handlers/stt-refresh.test.js`
- Create: `tests/sse/handlers/mid-stream-401-retry.test.js`

## TDD — failing tests first

`tts-refresh.test.js`:
1. Given a credential with `expiresAt` < now and a valid `refreshToken`, calling the tts handler MUST invoke `refreshTokenByProvider` exactly once before the upstream TTS request.
2. Mock the refresh to return a fresh access token — assert the upstream call uses the NEW token.
3. If refresh returns `null` / throws, handler returns SERVICE_UNAVAILABLE (does NOT crash).

`stt-refresh.test.js` — mirror of #1–#3 for stt.

`mid-stream-401-retry.test.js` — parameterized over [image, embed, search, fetch, tts, stt]:
4. Upstream returns 401 on first attempt → handler calls `forceRefresh` once → retries upstream with new token → returns 200.
5. Upstream returns 401 on both attempts → handler does NOT retry a 3rd time → falls through to fallback loop (next account excluded).
6. Upstream returns 200 on first attempt → `forceRefresh` is NOT called (no perf regression).
7. Upstream returns 500 on first attempt → `forceRefresh` is NOT called (non-auth status doesn't trigger refresh).
8. Force-refresh of an `apikey` connection is a no-op (no provider OAuth call).

Run all → confirm red.

## Implementation Steps

1. **Write failing tests** for `tts.js` and `stt.js` refresh (steps 1–3). Confirm red.
2. Patch `tts.js` around line 87–101:
   ```js
   const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
   if (!credentials || credentials.allRateLimited) { /* existing */ }
   const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
   log.info("AUTH", `\x1b[32mUsing ${provider} account: ${refreshedCredentials.connectionName}\x1b[0m`);
   const result = await handleTtsCore({
     provider, model, input: body.input,
     credentials: refreshedCredentials,
     responseFormat, language,
   });
   ```
   Mirror in `stt.js` line 61–75. Run tests — green.
3. **Write failing tests** for mid-stream retry (steps 4–8). Confirm red.
4. Add `forceRefresh` to `src/sse/services/tokenRefresh.js`:
   ```js
   export async function forceRefresh(provider, credentials) {
     if (!credentials || credentials.authType !== "oauth" || !credentials.refreshToken) {
       return credentials;
     }
     const newCreds = await getAccessToken(provider, { ...credentials, expiresAt: 0 });
     if (!newCreds?.accessToken) return credentials;
     const merged = {
       ...credentials,
       accessToken: newCreds.accessToken,
       refreshToken: newCreds.refreshToken ?? credentials.refreshToken,
       expiresAt: newCreds.expiresIn
         ? new Date(Date.now() + newCreds.expiresIn * 1000).toISOString()
         : credentials.expiresAt,
     };
     await updateProviderCredentials(credentials.connectionId, {
       ...newCreds,
       existingProviderSpecificData: credentials.providerSpecificData,
     });
     return merged;
   }
   ```
5. Add retry block to each of the 6 handlers (tts/stt/image/embed/search/fetch). Pattern (using imageGeneration as the template):
   ```js
   let result = await handleImageGenerationCore({ provider, model, body, credentials: refreshedCredentials });
   if ((result.status === 401 || result.status === 403) && refreshedCredentials.authType === "oauth") {
     const reCreds = await forceRefresh(provider, refreshedCredentials);
     if (reCreds.accessToken !== refreshedCredentials.accessToken) {
       result = await handleImageGenerationCore({ provider, model, body, credentials: reCreds });
     }
   }
   ```
   Keep YAGNI: only extract a helper `retryOnAuthFailure(coreFn, ctx, credentials)` if all 6 sites converge on identical shape — otherwise inline.
6. Run all tests — green.
7. Manual smoke: run `npm run dev`, trigger a TTS request with a forcibly-expired OAuth connection (set `expiresAt` to `new Date(Date.now() - 60000).toISOString()` in DB), confirm refresh fires and request succeeds.

## Success Criteria

- [ ] All 8 unit/integration tests pass.
- [ ] `tts.js` and `stt.js` show `checkAndRefreshToken` in the request path (`grep -n checkAndRefreshToken src/sse/handlers/{tts,stt}.js`).
- [ ] Manual smoke: forcibly-expired OAuth connection makes a successful TTS/STT request without dashboard reconnect.
- [ ] No regression in existing chat / imageGeneration / etc. tests.

## Risk Assessment

| Risk | Mitigation |
| ---- | ---------- |
| Retry loop on a server returning 401 for non-auth reasons (rate-limit masking as 401) | Single retry budget — no infinite loop. Subsequent 401 falls through to existing fallback (which marks account unavailable). |
| `forceRefresh` triggering on apikey/access_token connections | Guarded by `authType === "oauth"` check before retry. Test #8 covers this. |
| Stream handlers (chat) already have internal retry — double-retry | Retry block lives at SSE layer, NOT inside `*Core`. Chat already retries in `chatCore.js:209` — we are NOT adding a second retry to chat. Only the 6 non-chat handlers get the new block. |

## Next Steps

Phase 3 builds the reauth notifier so Phase 4 can fire it when `getAccessToken` returns `{ error: "invalid_grant" }` (refresh-token truly dead, not just transient 401).

## Red Team Adjustments — 2026-05-24

Finding **F7** accepted (HIGH). Major scope reduction.

### F7 — Mid-stream 401 retry already exists in *Core handlers; only tts/stt cores actually lack it

Plan's premise "no retry-once on mid-stream 401/403 in any handler except `open-sse/handlers/chatCore.js`" is **false**. Verified:
- `open-sse/handlers/imageGenerationCore.js:80-114` — has `refreshWithRetry → executor.refreshCredentials` retry-on-401.
- `open-sse/handlers/embeddingsCore.js:72-80` — same.
- `open-sse/handlers/responsesHandler.js` — same.

Adding a SECOND retry layer at the SSE handler around the *Core call causes **double-retry** (3 attempts from `refreshWithRetry` + 1 attempt from new wrapper = 4 refreshes). Risk: Auth0/Codex `refresh_token_reused` family-revoke triggers when parallel refreshes race past `refreshPromiseCache` dedup.

**Revised scope for Phase 2:**

1. **Keep (real bug):** add `checkAndRefreshToken` between `getProviderCredentials` and `handleTtsCore` / `handleSttCore` in `src/sse/handlers/tts.js` and `src/sse/handlers/stt.js`. This is the only verified Case-A hole.

2. **Move mid-stream retry INTO `sttCore.js` and `ttsCore.js`** (matching chat/image/embed pattern), not at the SSE-handler wrapper layer. Reuse `refreshWithRetry(executor.refreshCredentials, 3, log)` — do NOT introduce a new `forceRefresh` helper that duplicates the merge logic in `tokenRefresh.js:215-246`.

3. **Drop from scope:** retry-on-401 wrapper for `imageGeneration.js`, `embeddings.js`, `search.js`, `fetch.js`, `responses.js`. Already covered in their *Core handlers. Verify with `grep -n "401\|403\|refreshCredentials" open-sse/handlers/*Core.js` before any wrapper change.

4. **Drop `forceRefresh` export** — re-use existing `executor.refreshCredentials` (already wired through `tokenRefresh.js`). If a forced refresh is truly needed for the tts/stt cores, parameterize `checkAndRefreshToken` with `{ force: true }` instead of duplicating the persist/merge code.

**Updated test plan:**
- Keep tests #1-3 (tts/stt proactive refresh).
- Drop tests #4-8 parameterized over [image, embed, search, fetch] — already covered upstream.
- Keep #4-5 parameterized over [tts, stt] only — verify mid-stream retry-once via `refreshWithRetry` in their *Core.

**Updated effort:** 4-6h → 2-3h.
