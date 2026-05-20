# Token State Surfaces Scout Report

## 1. Data JSON Blob Read/Write (connectionsRepo.js)

OPTIONAL_FIELDS whitelist for `data` JSON:
- src/lib/db/repos/connectionsRepo.js:5–11 — `OPTIONAL_FIELDS` array
  - accessToken, refreshToken, expiresAt, tokenType
  - scope, projectId, apiKey, testStatus
  - lastTested, lastError, lastErrorAt, rateLimitedUntil, expiresIn, errorCode
  - consecutiveUseCount
  - displayName, email, globalPriority, defaultModel

Write surfaces:
- src/lib/db/repos/connectionsRepo.js:30–43 — `connToRow()` converts conn obj to row, serializes all OPTIONAL_FIELDS into `data` JSON blob
- src/lib/db/repos/connectionsRepo.js:46–57 — `upsert()` writes to DB via INSERT…ON CONFLICT
- src/lib/db/repos/connectionsRepo.js:91–154 — `createProviderConnection()` — merges data + OPTIONAL_FIELDS, calls `upsert()`
- src/lib/db/repos/connectionsRepo.js:157–170 — `updateProviderConnection()` — merges update fields, calls `upsert()`

Read surfaces:
- src/lib/db/repos/connectionsRepo.js:13–28 — `rowToConn()` parses `data` JSON blob back to conn object
- src/lib/db/repos/connectionsRepo.js:59–70 — `getProviderConnections()` reads rows, maps to conn objects
- src/lib/db/repos/connectionsRepo.js:72–76 — `getProviderConnectionById()` reads single row, maps to conn object

## 2. Token Refresh & Credential Functions

### getProviderCredentials() — primary auth selector

- src/sse/services/auth.js:18–187 — exports function, filters by excludeSet, checks modelLock_*, handles round-robin/fill-first fallback, returns merged credentials with proxy info
- src/sse/services/auth.js:55–61 — reads isActive=true connections
- src/sse/services/auth.js:64–78 — filters by excludeSet + isModelLockActive()
- src/sse/services/auth.js:159–182 — builds return object, includes accessToken, refreshToken, testStatus, lastError, _connection

### checkAndRefreshToken() — proactive refresh on expiry

- src/sse/services/tokenRefresh.js:204–280 — checks expiresAt vs now + refreshLead, calls getAccessToken(), persists via updateProviderCredentials()
- src/sse/services/tokenRefresh.js:208–247 — token expiry check + refresh
- src/sse/services/tokenRefresh.js:250–277 — GitHub Copilot token refresh + persist

### refreshTokenByProvider() + getAccessToken()

- src/sse/services/tokenRefresh.js:58–59 — re-exports from open-sse with local logger
- src/sse/services/tokenRefresh.js:61–62 — re-exports refreshTokenByProvider from open-sse
- open-sse/services/tokenRefresh.js:19–20, 60–62 — wrappers around `_getAccessToken`, `_refreshTokenByProvider` from open-sse

### updateProviderCredentials() — persist token updates

- src/sse/services/tokenRefresh.js:155–192 — normalizes expiresAt/expiresIn, extracts providerSpecificData, calls updateProviderConnection()
- src/sse/services/tokenRefresh.js:159–177 — constructs updates object
- src/sse/services/tokenRefresh.js:179 — calls DB updateProviderConnection()

## 3. Call Sites of checkAndRefreshToken, getAccessToken, refreshTokenByProvider

### In SSE handlers (all in src/sse/handlers/):

- chat.js:192–269 — defines lastError local var, calls getProviderCredentials() (line 199), calls checkAndRefreshToken() on credentials (line 202), loops on fallback
- imageGeneration.js:90–135 — same pattern: getProviderCredentials() (line 99), checkAndRefreshToken() (line 103)
- embeddings.js:84–135 — same pattern
- search.js:148–199 — same pattern
- fetch.js:149–206 — same pattern
- stt.js:57–82 — same pattern: getProviderCredentials() (line 65), checkAndRefreshToken() (line 68)
- tts.js:83–108 — same pattern: getProviderCredentials() (line 91), checkAndRefreshToken() (line 94)

### In open-sse (token refresh internals):

- open-sse/handlers/chatCore.js:209–228 — 401/403 retry: calls refreshWithRetry() on executor.refreshCredentials() (line 211), updates credentials in-place (line 214), calls onCredentialsRefreshed() callback

### In API routes:

- src/app/api/translator/send/route.js — imports refreshTokenByProvider, uses it in error path

## 4. getProviderCredentials Return Signature

src/sse/services/auth.js:161–183 returns object with:
- `authType` — 'oauth', 'apikey', 'access_token'
- `apiKey` — if authType=apikey
- `accessToken` — token string
- `refreshToken` — refresh token string or null
- `projectId` — for providers needing Google project ID
- `connectionName` — display name
- `copilotToken` — GitHub Copilot token
- `providerSpecificData` — object with connection proxy, relay info
- `connectionId` — connection record ID
- `testStatus` — 'active', 'unavailable', 'error', 'success'
- `lastError` — error message string
- `_connection` — full connection record for modelLock_* key reads

## 5. UI Connection Status Surfaces

### Providers List Page (page.js, line counts ~1316)

- src/app/(dashboard)/dashboard/providers/page.js:30–50 — `getStatusDisplay()` renders Connected/Error badges
- src/app/(dashboard)/dashboard/providers/page.js:52–91 — `getConnectionErrorTag()` extracts error tag from lastErrorType, errorCode, or lastError message
  - Lines 58–69: checks lastErrorType (runtime_error, upstream_auth_error, token_refresh_failed, token_expired, upstream_rate_limited, upstream_unavailable, network_error)
  - Lines 71–76: falls back to errorCode numeric parsing
  - Lines 78–87: falls back to error message text parsing
- src/app/(dashboard)/dashboard/providers/page.js:180–204 — status aggregation: maps connections to getEffectiveStatus(), counts connected/error, extracts latestError
- src/app/(dashboard)/dashboard/providers/page.js:230–250 — `handleBatchTest()` sends test request to `/api/providers/test`, updates testResults state
- src/app/(dashboard)/dashboard/providers/page.js:391–407 — Test All OAuth button, calls handleBatchTest("oauth")
- src/app/(dashboard)/dashboard/providers/page.js:433–449 — Test All Free button, calls handleBatchTest("free")

### ConnectionsCard Component (ConnectionsCard.js, line count 497)

- src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js:32–197 — `ConnectionRow()` component (nested inside ConnectionsCard)
  - Lines 70–76: computes modelLockUntil from modelLock_* keys
  - Lines 78–91: useEffect to refresh isCooldown state every 1s
  - Lines 93–94: effectiveStatus logic: unavailable without cooldown → active
  - Lines 95–100: getStatusVariant() badge color (success if active, error if unavailable/error/expired)
  - Lines 127–135: displays status badge + proxy badge + cooldown timer + lastError text
  - Line 166: Delete button onClick → onDelete callback
- src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js:361–365 — `handleDelete()` sends DELETE request, removes connection

### ConnectionRow Component in Provider Detail Page (ConnectionRow.js, line count 13149)

- src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js:1–150 (excerpt)
  - Lines 7–123: same status/cooldown logic as ConnectionsCard
  - Line 87–100: useEffect for cooldown timer
  - Lines 102–105: effectiveStatus + getStatusVariant()
  - Line 143: Display name + status badge + cooldown timer + error message + priority

(Note: full file extends to 400+ lines with proxy handling, edit/delete buttons, one-by-one test UI)

## 6. OAuth Token Callback Flows — Token Write Points

### Generic OAuth Exchange (route.js, line count 333)

- src/app/api/oauth/[provider]/[action]/route.js:188–262 — POST /api/oauth/[provider]/exchange
  - Lines 213–231: Raw JWT access_token (eye... base64), decodes and creates connection
    - Line 213–220: calls createProviderConnection() with authType='access_token', testStatus='active'
  - Lines 240–251: Normal OAuth exchange via exchangeTokens(), creates connection
    - Line 243–250: calls createProviderConnection() with authType='oauth', expiresAt computed, testStatus='active'
  - Lines 287–297: Poll (device code) success → createProviderConnection()
    - Line 289–296: calls createProviderConnection() with authType='oauth', expiresAt, testStatus='active'

- src/app/api/oauth/[provider]/[action]/route.js:23–60 — xAI manual code exchange
  - Line 38–46: calls createProviderConnection() with authType='oauth', testStatus='active'

### Cursor Import (cursor/import/route.js, line count 101)

- src/app/api/oauth/cursor/import/route.js:42–57 — POST /api/oauth/cursor/import
  - Line 43–57: calls createProviderConnection() with accessToken, expiresAt, testStatus='active'

### Kiro Import (kiro/import/route.js, line count 57)

- src/app/api/oauth/kiro/import/route.js:29–42 — POST /api/oauth/kiro/import
  - Line 29–42: calls createProviderConnection() with accessToken, refreshToken, expiresAt, testStatus='active'

### Kiro Social Exchange (kiro/social-exchange/route.js, line count 68)

- src/app/api/oauth/kiro/social-exchange/route.js:40–53 — POST /api/oauth/kiro/social-exchange
  - Line 40–53: calls createProviderConnection() with accessToken, refreshToken, expiresAt, testStatus='active'

(Note: kiro/auto-import/route.js reads from file system, doesn't write to connections)

## 7. lastError, lastErrorType, lastErrorCode, lastErrorAt Write Surfaces

### markAccountUnavailable() — primary error writer

- src/sse/services/auth.js:199–237 — main error marking function
  - Lines 219–226: calls updateProviderConnection() with:
    - `...lockUpdate` (modelLock_${model} or modelLock___all)
    - `testStatus: 'unavailable'`
    - `lastError: reason` (truncated errorText)
    - `errorCode: status` (HTTP status)
    - `lastErrorAt: new Date().toISOString()`
    - `backoffLevel: newBackoffLevel`

### clearAccountError() — error reset on success

- src/sse/services/auth.js:248–281 — clears errors after request succeeds
  - Lines 273–280: calls updateProviderConnection() with:
    - `...clearObj` (sets modelLock_* keys to null)
    - `testStatus: 'active'`
    - `lastError: null`
    - `lastErrorAt: null`
    - `backoffLevel: 0`

### Test API Route (/api/providers/[id]/test/)

- src/app/api/providers/[id]/test/testUtils.js:623–624 — on proxy error
  - Line 623–624: sets lastError, lastErrorAt in result
- src/app/api/providers/[id]/test/testUtils.js:643–644 — on auth test fail
  - Line 643–644: sets lastError, lastErrorAt in result

- src/app/api/providers/[id]/route.js:99–128 — PATCH endpoint
  - Lines 99–100: destructures lastError, lastErrorAt from body
  - Lines 127–128: if lastError/lastErrorAt defined, adds to updateData
  - Calls updateProviderConnection() with updateData

### Fallback Handler (accountFallback.js)

- open-sse/services/accountFallback.js:147–150 — buildModelLockUpdate() returns { modelLock_${model}: expiryTimestamp }
  - Used by src/sse/services/auth.js:217 in markAccountUnavailable()

## 8. isActive Flag — DB Writes Only

- src/lib/db/repos/connectionsRepo.js:24 — read: `isActive: row.isActive === 1 || row.isActive === true`
- src/lib/db/repos/connectionsRepo.js:39 — write: `isActive: isActive === false ? 0 : 1`
- src/lib/db/repos/connectionsRepo.js:49–56 — upsert keeps isActive in INSERT…ON CONFLICT
- src/lib/db/repos/connectionsRepo.js:64 — filter: `isActive = ?` in WHERE clause
- src/lib/db/repos/connectionsRepo.js:136 — createProviderConnection: `isActive: data.isActive !== undefined ? data.isActive : true`
- src/lib/db/repos/connectionsRepo.js:157–170 — updateProviderConnection merges isActive field

UI disables connections via ConnectionRow Delete button → calls onDelete → sends DELETE request (not a flag flip).

## 9. accountFallback.js — Availability Skips & Conditions

- open-sse/services/accountFallback.js:16–50 — `checkFallbackError()` — matches ERROR_RULES top-to-bottom
  - Returns { shouldFallback: bool, cooldownMs, newBackoffLevel? }
  - Skips account if: text rule matches in error message OR status code matches
  - Exponential backoff on 429 (rate limit)
  - Transient cooldown (5s) for unmatched errors

- open-sse/services/accountFallback.js:120–125 — `isModelLockActive()` — reads modelLock_${model} or modelLock___all
  - Skips if expiry > now

- open-sse/services/accountFallback.js:131–142 — `getEarliestModelLockUntil()` — finds earliest active lock
  - Scans all modelLock_* keys, returns earliest future timestamp

- open-sse/services/accountFallback.js:147–150 — `buildModelLockUpdate()` — builds lock object for given model + cooldownMs

- open-sse/services/accountFallback.js:155–161 — `buildClearModelLocksUpdate()` — clears all modelLock_* keys

- open-sse/services/accountFallback.js:166–176 — `filterAvailableAccounts()` — filters out unavailable (rateLimitedUntil not expired)
  - Legacy field, not used in src/ handlers

src/sse/services/auth.js:66–68 uses `isModelLockActive()` to skip connections

## 10. Stream Handlers — 401/403 Retry Loop Status

### chat.js (open-sse/handlers/chatCore.js:209–228)

- **HAS** 401/403 retry: calls refreshWithRetry() on executor.refreshCredentials()
- Does NOT call markAccountUnavailable() on 401/403; skips to upstream error handling
- **MISSING:** No explicit error lock if refresh fails

### imageGeneration.js (src/sse/handlers/imageGeneration.js)

- No explicit 401/403 handling in SSE layer
- Falls back to lastError in getProviderCredentials() return

### embeddings.js (src/sse/handlers/embeddings.js)

- No explicit 401/403 handling in SSE layer
- Falls back to lastError

### search.js (src/sse/handlers/search.js)

- No explicit 401/403 handling in SSE layer
- Falls back to lastError

### fetch.js (src/sse/handlers/fetch.js)

- No explicit 401/403 handling in SSE layer
- Falls back to lastError

### stt.js (src/sse/handlers/stt.js)

- No explicit 401/403 handling in SSE layer
- Falls back to lastError

### tts.js (src/sse/handlers/tts.js)

- No explicit 401/403 handling in SSE layer
- Falls back to lastError

**Summary:** Only chatCore.js has built-in 401/403 refresh. Others rely on getProviderCredentials() returning lastError + lastErrorCode, then handler returns 503/SERVICE_UNAVAILABLE to client.

## 11. Notifier Public API & Scheduler Call Sites

### src/lib/warmup/notifier.js — Public API

- **Functions:**
  - Line 115–118: `getNotifierConfig()` — returns frozen config object
  - Line 120–122: `isValidDiscordWebhook(url)` — regex validation
  - Line 124–126: `isValidTelegramToken(token)` — regex validation
  - Line 130–145: `isValidPublicHttpUrl(url)` — SSRF-safe validation
  - Line 197–205: `recordFailure(connectionId, dedupeKey)` — tracks failure for recovery detection
  - Line 207–214: `recordSuccess(connectionId)` — clears failure state, emits recovery flag if threshold met
  - Line 217–223: `tryReserveFailureSlot()` — rate limit check (failures/hour)
  - Line 221–223: `tryReserveRecoverySlot()` — rate limit check (recovery/hour)
  - Line 267–297: `buildDiscordPayload(kind, ctx)` — builds Discord message
  - Line 300–333: `buildTelegramPayload(kind, ctx, chatId)` — builds Telegram message
  - Line 335–363: `buildGenericPayload(kind, ctx)` — builds generic webhook JSON
  - Line 366–412: `buildDigestPayload(channel, batch)` — builds catch-up digest
  - **Line 582–604: `notifyWarmupFailure(ctx)` — main export, checks config, reserves slot, calls fanOut()**
  - **Line 606–628: `notifyWarmupRecovery(ctx)` — main export, checks config, reserves slot, calls fanOut()**
  - **Line 630–652: `notifyWarmupDigest({ batch })` — main export, checks config, reserves slot, calls fanOutDigest()**

### src/lib/warmup/runner.js — Scheduler Call Sites

- **Line 70–82:** On connection success
  - Line 70: loads notifier async
  - Line 73: calls `notifyWarmupRecovery()` with { schedule, connection, run, distinctFails }

- **Line 120–135:** On connection failure
  - Line 120: loads notifier async
  - Line 125: calls `notifyWarmupFailure()` with { schedule, connection, run, error }

- **Line 185–186:** On outage end (digest)
  - Line 185: loads notifier async
  - Line 186: calls `notifyWarmupDigest()` with { batch: digestBatch }

Notifier context object:
```javascript
{
  schedule: { id, name, timezone },
  connection: { id, name, provider },
  run: { localDate, localTime, scheduledForUtc, dedupeKey, error },
  distinctFails: number
}
```

---

## Summary Table

| Category | Count | Key Files |
|----------|-------|-----------|
| DB read/write surfaces | 6 | connectionsRepo.js (upsert, rowToConn, connToRow) |
| Token credential functions | 3 | auth.js (getProviderCredentials), tokenRefresh.js (checkAndRefreshToken, updateProviderCredentials) |
| SSE handler call sites | 7 | chat.js, imageGeneration.js, embeddings.js, search.js, fetch.js, stt.js, tts.js |
| UI status display surfaces | 7 | page.js (Providers list), ConnectionsCard.js, ConnectionRow.js (2 versions) |
| OAuth callback token writes | 5 | [provider]/[action]/route.js, cursor/import, kiro/import, kiro/social-exchange, xAI manual |
| Error state writers | 3 | markAccountUnavailable(), clearAccountError(), testUtils.js |
| Stream handlers with 401/403 retry | 1 | chatCore.js (open-sse) |
| Notifier public exports | 3 | notifyWarmupFailure, notifyWarmupRecovery, notifyWarmupDigest |
