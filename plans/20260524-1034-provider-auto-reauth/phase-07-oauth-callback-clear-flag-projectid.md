---
phase: 7
title: "OAuth callback clears flag + projectId re-fetch"
status: pending
priority: P1
effort: "3-4h"
dependencies: [1, 6]
---

# Phase 7: OAuth callback clears needsReauth + projectId re-fetch

## Overview

Make the OAuth exchange/poll/import handlers update the EXISTING connection row when re-auth is requested for a specific `connectionId`, instead of always calling `createProviderConnection` (which inserts a new row). On success: clear `needsReauth` and friends, and for `antigravity` / `gemini-cli` re-fetch the Google project ID via the existing `_refreshProjectId` helper.

## Requirements

- Functional
  - `state` parameter of the OAuth flow carries the optional `connectionId` to re-auth (added on the authorize side in Phase 6 / here).
  - `/api/oauth/[provider]/[action]/route.js::POST exchange` (and the device-code poll path, and `cursor/import`, `kiro/import`, `kiro/social-exchange`) accepts an optional `connectionId` from the OAuth state OR from the request body, and on present:
    - calls `updateProviderConnection(connectionId, { accessToken, refreshToken, expiresAt, ... })` instead of `createProviderConnection`.
    - calls `clearNeedsReauth(connectionId)`.
    - for `provider === "antigravity" || provider === "gemini-cli"` → schedule `_refreshProjectId(provider, connectionId, accessToken)` (already non-blocking).
  - When `connectionId` is absent → existing behavior (new connection row).
- Non-functional
  - No new endpoints.
  - OAuth `state` must remain unforgeable — the `connectionId` rides inside the existing signed/random state, NOT as a raw query param.
  - If the supplied `connectionId` does not belong to the same provider, REJECT (defense-in-depth — cross-provider hijack guard).

## Architecture

```
Authorize (Phase 6 piggybacks):
   /api/oauth/<provider>/authorize?connectionId=<id>
       ↓
   generateAuthData(provider, redirectUri, { connectionId })
       ↓ store connectionId in server-side session keyed by `state`
       ↓
   Browser → IdP → redirect back with code + state

Exchange:
   POST /api/oauth/<provider>/exchange { code, state, ... }
       1. lookup session by state → recover connectionId (if any)
       2. exchangeTokens(provider, code, redirectUri, codeVerifier, state)
       3. if (connectionId):
            a. row = getProviderConnectionById(connectionId)
            b. assert row.provider === provider (defense-in-depth)
            c. updateProviderConnection(connectionId, { accessToken, refreshToken, expiresAt, testStatus: "active", lastError: null, lastErrorAt: null, errorCode: null })
            d. await clearNeedsReauth(connectionId)
            e. if provider needs projectId → _refreshProjectId(provider, connectionId, accessToken)
       4. else:
            createProviderConnection({ ...existing path })
```

Stateful piece: the OAuth-session store currently lives in `src/lib/oauth/utils/server.js` (see `registerCodexSession`, `getCodexSessionStatus` etc.). We extend whichever generic session storage handles the standard PKCE/device flow to carry `connectionId` alongside `codeVerifier` and `redirectUri`.

## Related Code Files

- Modify: `src/lib/oauth/utils/server.js` — generic session store accepts/returns `connectionId`
- Modify: `src/lib/oauth/providers.js::generateAuthData` — pass-through `connectionId` if provided
- Modify: `src/app/api/oauth/[provider]/[action]/route.js`
  - GET `authorize` (line 74–80) — read `connectionId` from `searchParams.connectionId`, attach to session
  - POST `exchange` (line 188–262) — recover `connectionId`, branch update-vs-create
  - GET `poll` (device code path, ~287–297) — same branch
  - xAI manual code path (line 23–60) — same branch
- Modify: `src/app/api/oauth/cursor/import/route.js` (line 42–57) — accept `connectionId` from body, branch
- Modify: `src/app/api/oauth/kiro/import/route.js` (line 29–42) — same
- Modify: `src/app/api/oauth/kiro/social-exchange/route.js` (line 40–53) — same
- Create: `tests/oauth/callback-update-existing.test.js`

## TDD — failing tests first

`callback-update-existing.test.js`:
1. POST `/api/oauth/claude-code/exchange` with `connectionId=<existing>` → existing row updated, `needsReauth` cleared, NO new row inserted.
2. Same POST without `connectionId` → new row created (existing behavior preserved).
3. POST with `connectionId` pointing to a connection on a DIFFERENT provider → rejected with 400.
4. POST with `connectionId` pointing to a non-existent row → rejected with 404 `{error: "connection not found"}`. (Locked Validation Session 1 D-V2.)
5. `provider === "antigravity"` + successful exchange → `_refreshProjectId` is called with new access token.
6. `cursor/import` with `connectionId` → row updated, not created.
7. `kiro/social-exchange` with `connectionId` → row updated, not created.
8. After successful update path, `lastError`, `lastErrorAt`, `errorCode`, `reauthReason`, `reauthAt`, `reauthNotifiedAt` all cleared.

Run all → red.

## Implementation Steps

1. **Write failing tests** (1–8). Confirm red.
2. Extend generic OAuth session store to carry `connectionId`. Check `src/lib/oauth/utils/server.js` for what session stores exist — keep the change additive (a new optional field).
3. Modify `generateAuthData` to pass `connectionId` into the session at create time. Authorize URL surface stays standard OAuth (state random).
4. In `[provider]/[action]/route.js POST exchange`:
   ```js
   const session = state ? getOAuthSession(state) : null;
   const reauthConnectionId = session?.connectionId;
   const tokenData = await exchangeTokens(provider, code, redirectUri, codeVerifier, state);

   if (reauthConnectionId) {
     const existing = await getProviderConnectionById(reauthConnectionId);
     if (!existing) return NextResponse.json({ error: "connection not found" }, { status: 404 });
     if (existing.provider !== provider) return NextResponse.json({ error: "provider mismatch" }, { status: 400 });
     await updateProviderConnection(reauthConnectionId, {
       accessToken: tokenData.accessToken,
       refreshToken: tokenData.refreshToken,
       expiresAt: tokenData.expiresIn
         ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
         : null,
       testStatus: "active",
       lastError: null,
       lastErrorAt: null,
       errorCode: null,
       lastErrorType: null,
     });
     await clearNeedsReauth(reauthConnectionId);
     if (provider === "antigravity" || provider === "gemini-cli") {
       _refreshProjectId(provider, reauthConnectionId, tokenData.accessToken);
     }
     return NextResponse.json({ id: reauthConnectionId, updated: true });
   }
   // existing create-new path
   ```
5. Apply analogous branching to the device-code `poll` path, xAI manual exchange, `cursor/import`, `kiro/import`, `kiro/social-exchange`.
6. Verify `_refreshProjectId` is exported from `tokenRefresh.js` (it is — line 121 of `src/sse/services/tokenRefresh.js`).
7. Wire UI Phase 6: when authorize URL is built from "Reconnect" button, append `&connectionId=<id>` to `/api/oauth/<provider>/authorize`.
8. Run tests — green.
9. Manual smoke: kill a connection's refresh token to force `needsReauth=true`, open the notification deep-link, complete OAuth in the browser, confirm the SAME connection row is updated and `needsReauth` is gone.

## Success Criteria

- [ ] All 8 tests pass.
- [ ] OAuth re-auth for an existing connection updates the row in place — verified by `id` and `createdAt` unchanged.
- [ ] `needsReauth` is reset on every code path (exchange, poll, cursor/import, kiro/import, kiro/social-exchange).
- [ ] Project ID re-fetched for antigravity/gemini-cli.
- [ ] Cross-provider hijack attempt is rejected.

## Risk Assessment

| Risk | Mitigation |
| ---- | ---------- |
| OAuth `state` leak allows an attacker to bind their token to victim's `connectionId` | `state` already random per OAuth spec + we check `existing.provider === provider`. Also dashboard auth cookie is required to reach `/api/oauth/.../exchange`. |
| User does "Reconnect" on connection A but logs into IdP account B → row updated with stranger's tokens | Acceptable — same connection slot reuse. To prevent silent identity swap, check `existing.email === tokenData.email` if both present, warn in UI when mismatched (out of scope this phase, log only). |
| Cursor/Kiro import endpoints accept `connectionId` from POST body (not OAuth state) — easier to spoof from JS | Both endpoints already require dashboard auth cookie. Same defense-in-depth provider check applies. |
| `_refreshProjectId` failing silently | Already logged at `debug` level. Acceptable — user can re-test. |

## Next Steps

Phase 8 wires the full end-to-end smoke, updates CHANGELOG, README, and the docs index.

## Red Team Adjustments — 2026-05-24

Findings **F3, F4** accepted. Major rework — Architecture section superseded.

### F3 — Generic OAuth session store doesn't exist for 9/12 providers (CRITICAL)

Plan claims `src/lib/oauth/utils/server.js` has a "generic OAuth session store" extensible with `connectionId`. **False.** Only Codex (`pendingExchanges` at line 125) and xAI (`xaiPendingExchanges` at line 287) have server-side maps — both tied to fixed-port proxy servers for device-code flows. For Claude / GitHub / Cursor / Antigravity / Kilocode / Cline / Kiro / Qwen / iFlow (9 of the active 8 + free-tier providers), `generateAuthData` at `providers.js:1309-1336` returns `state` + `codeVerifier` directly to the CLIENT, which holds them in React state and POSTs back to `/exchange`. NO server-side `state → connectionId` mapping exists.

If implementor builds Phase 7 as-written, `session = state ? getOAuthSession(state) : null` returns `null` for 9 providers → falls through to `createProviderConnection` → every reconnect creates a duplicate row → original `needsReauth=true` row is never cleared → notification fires forever.

**Replacement design — signed-state JWT (chosen for security):**

1. **Encode `connectionId` into the OAuth `state` parameter** using an HMAC-signed token. State must round-trip through the IdP unchanged.

2. **New helper** in `src/lib/oauth/utils/server.js` (secret source LOCKED in Validation Session 1 → reuse `JWT_SECRET` resolver from `src/lib/auth/dashboardSession.js`; do NOT introduce `OAUTH_STATE_SECRET`). Prep step: in `src/lib/auth/dashboardSession.js:7`, add `export` to `loadJwtSecret` (currently private — verified). Then:
   ```js
   import crypto from "node:crypto";
   import { loadJwtSecret } from "@/lib/auth/dashboardSession.js"; // env JWT_SECRET || DATA_DIR/jwt-secret (auto-generated 32-byte hex on first run)
   const SECRET = loadJwtSecret();
   
   export function signOAuthState({ connectionId, nonce = crypto.randomBytes(16).toString("hex") }) {
     const payload = `${connectionId || ""}|${nonce}|${Date.now()}`;
     const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
     return `${Buffer.from(payload).toString("base64url")}.${sig}`;
   }
   
   export function verifyOAuthState(state, { maxAgeMs = 10 * 60 * 1000 } = {}) {
     if (!state || typeof state !== "string" || !state.includes(".")) return null;
     const [payloadB64, sig] = state.split(".");
     const expected = crypto.createHmac("sha256", SECRET).update(Buffer.from(payloadB64, "base64url")).digest("base64url");
     if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
     const [connectionId, nonce, tsStr] = Buffer.from(payloadB64, "base64url").toString().split("|");
     const ts = Number(tsStr);
     if (!ts || Date.now() - ts > maxAgeMs) return null;
     return { connectionId: connectionId || null, nonce, ts };
   }
   ```

3. **`generateAuthData(provider, redirectUri, { connectionId })`** — instead of `state = crypto.randomBytes(...)`, set `state = signOAuthState({ connectionId })`. Client passes it through the IdP unchanged. Existing OAuth flow already preserves state.

4. **POST `exchange` (and `poll`, `xai/exchange`)**: replace `getOAuthSession(state)` with `verifyOAuthState(state)`. Recover `connectionId`. Apply existing provider-match defense at `existing.provider === provider`.

5. **Cursor / Kiro / GitLab PAT / iFlow** do NOT use OAuth state — they accept tokens directly in POST body. Per Phase 6 F9, these get the `manual_reimport_needed` UX track. Plan must explicitly add `connectionId` to their POST body schema with `verifySession()` checking the user's dashboard JWT cookie owns the target row (single-tenant 9router → all rows owned by the cookie, so a presence check suffices).

6. **Drop the false claim** at line 121 "_refreshProjectId is exported, line 121" — see F4.

**Effort revision:** 3-4h → 6-8h.

### F4 — `_refreshProjectId` is NOT exported (CRITICAL)

`grep "^export" src/sse/services/tokenRefresh.js` shows 17 exports, none named `_refreshProjectId` or `refreshProjectId`. Plan step 6 (line 121) "Verify `_refreshProjectId` is exported (it is — line 121)" — **false**.

**Fix:**
1. In `src/sse/services/tokenRefresh.js`, change `function _refreshProjectId(...)` to `export async function refreshProjectId(...)` (drop the leading underscore; the convention "underscore = private" is moot now that it's a public export).
2. Update all in-file callers to the new name.
3. Phase 7 step 4 import:
   ```js
   import { refreshProjectId } from "@/sse/services/tokenRefresh.js";
   ```
4. Drop the misleading "line 121" verification comment.

### F13 cont. — `lastErrorType` cleared in exchange path

Phase 7 step 4 already lists `lastErrorType: null` in the update payload (line 110). Confirm via F13 in Phase 1 that the field is whitelisted in `OPTIONAL_FIELDS`; otherwise the cleanup silently strips it.

### Revised TDD additions

- #9 — `verifyOAuthState` rejects an expired (>10min old) state.
- #10 — `verifyOAuthState` rejects a forged signature.
- #11 — POST `exchange` without `state` (legacy clients) → falls through to `createProviderConnection` (preserve back-compat).
- #12 — POST `exchange` with `state` signed for `connectionId="X"` but Cursor `POST import` from a different tab → cross-flow attempt rejected (provider mismatch at the `existing.provider === provider` guard).

**Validation Session 1 — locks (2026-05-24):**

- **Test #4 disposition (D-V2):** `state.connectionId` pointing to a NON-existent row → return `404 { error: "connection not found" }`. Do NOT fall through to `createProviderConnection`. Prevents orphan-row creation when the user intentionally deleted the connection between notify and reconnect.
- **Secret source (D-V3):** signed-state HMAC uses `getJwtSecret()` from `src/lib/auth/dashboardSession.js` (env `JWT_SECRET` || `DATA_DIR/jwt-secret`). No new env var.
