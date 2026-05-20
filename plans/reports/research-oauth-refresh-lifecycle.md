# OAuth Refresh-Token Lifecycle & Invalid_Grant Semantics
## Research Report for 9Router Provider Auto-Reauth Feature

**Date:** 2026-05-24  
**Scope:** 11 OAuth providers used in 9Router  
**Purpose:** Ground truth for refresh-token death detection feature planning  

---

## Provider Summaries

### 1. Anthropic Claude Code
**Expiry:** Access token 8h, refresh token expires after inactivity (undocumented limit). **Error:** `invalid_grant` on refresh failure. **Refresh:** NO — refresh tokens never work in practice; users must manually re-login every 8h or use API key. **Gotcha:** Refresh token stored but never used by official Claude Code CLI; docs recommend API keys for automation.

Source: [GitHub Issue #12447](https://github.com/anthropics/claude-code/issues/12447), [GitHub Issue #31095](https://github.com/anthropics/claude-code/issues/31095)

### 2. OpenAI Codex
**Expiry:** Access token lifecycle unknown; refresh token is single-use. **Error:** `refresh_token_reused` (HTTP 401), `invalid_grant` on reuse or expiration. **Refresh:** NO — token persists not working; refreshed tokens not saved to disk, causing reuse of exhausted token. **Gotcha:** CRITICAL — Google-style family rotation: reusing a single-use refresh token blacklists the whole token family. Race condition: concurrent refresh attempts fail after first succeeds.

Source: [GitHub Issue #57399](https://github.com/openclaw/openclaw/issues/57399), [zooclaw.ai blog](https://zooclaw.ai/help/en/2026-04-07/openai-codex-refresh-token-reuse/)

### 3. GitHub OAuth
**Expiry:** Access token 8h, refresh token 6 months, auto-revoke after 1 year of no use. **Error:** `invalid_grant` on token expiration; revoked tokens return error_description mentioning revocation. **Refresh:** YES — refresh endpoint works (RFC 6749 compliant); new access + refresh returned; old tokens blacklisted immediately. **Gotcha:** Single-use refresh token — must persist new token after refresh or next call fails.

Source: [GitHub Docs: Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)

### 4. Google (Gemini CLI / Antigravity)
**Expiry:** Access token lifecycle ~1h; refresh token 6 months idle = auto-revoke. Max 100 refresh tokens per account/client = auto-revoke oldest. **Error:** `invalid_grant` + `error_description: "Token has been expired or revoked"`. **Refresh:** YES but complex. Max 100 token limit per (account, client_id) pair — exceeding limit silently revokes oldest. **Gotcha:** Test mode (publishing status = Testing) revokes all tokens after 7 days. Family rotation: if you hit 100-token limit, your oldest token dies without warning.

Source: [Nango blog: Google OAuth invalid_grant](https://nango.dev/blog/google-oauth-invalid-grant-token-has-been-expired-or-revoked/)

### 5. Cursor IDE
**Expiry:** MCP OAuth tokens typically expire 15-60 min; refresh token lifetime unknown. **Error:** 401 Unauthorized on expired access token; Cursor marks MCP "Logged out". **Refresh:** NO — Cursor MCP layer does not invoke refresh token; OAuth tokens expire and MCP fails silently. **Gotcha:** Known bug: Cursor ignores refresh_token from PKCE flow, forcing daily re-auth on OAuth MCPs even if refresh token present.

Source: [Cursor forum: Missing Refresh Token logic](https://forum.cursor.com/t/missing-refresh-token-logic-for-mcp-oauth/130765)

### 6. Kiro AI (AWS Builder ID)
**Expiry:** Access token 1h TTL; refresh token (`aor` = AWS Org Refresh) lifetime not documented. **Error:** `invalid_grant` on failed refresh; "Token refresh failed — provider returned no new token". **Refresh:** PARTIAL — kiro-cli refreshes but does not persist to SQLite; external tools read stale token from DB. **Gotcha:** Enterprise IAM Identity Center policies can force re-auth multiple times daily due to strict session limits.

Source: [GitHub Issue #2467](https://github.com/diegosouzapw/OmniRoute/issues/2467), [GitHub Issue #4847](https://github.com/kirodotdev/Kiro/issues/4847)

### 7. Qwen Code
**Expiry:** Not documented in official sources; discontinued free OAuth tier 2026-04-15. **Error:** Likely `invalid_grant` per OAuth spec, but no Qwen-specific docs found. **Refresh:** UNKNOWN — no public docs on token refresh flow. **Gotcha:** Free tier fully discontinued as of 2026-04-15; not recommended for new integrations.

Source: README.md note (verified via 9Router docs)

### 8. iFlow
**Expiry:** Token lifetime not documented; SAP enterprise-specific. **Error:** `invalid_grant` + `"Invalid refresh token"` (HTTP 400); `"iflow token: missing access token in response"` on refresh failure. **Refresh:** UNKNOWN — generic SAP OAuth flow, likely works but undocumented. **Gotcha:** Enterprise integration — SAP Knowledge Base articles require login; exact behavior opaque.

Source: [GitHub Issue #1551](https://github.com/router-for-me/CLIProxyAPI/issues/1551)

### 9. xAI (Grok OAuth)
**Expiry:** Not explicitly documented; Hermes implementation refreshes on 401 or before expiration. **Error:** Likely `invalid_grant`, but no public spec. **Refresh:** PARTIAL — Hermes refreshes in background before expiration and reactively on 401. xAI OpenID configuration available at `https://auth.x.ai/.well-known/openid-configuration`. **Gotcha:** Must check OpenID metadata for TTLs; no public lifetime docs.

Source: [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth), [GitHub: opencode-grok-auth](https://github.com/ysnock404/opencode-grok-auth)

### 10. GitLab
**Expiry:** Access token has expiration (v15.0+); refresh token: NO auto-expiry in current docs (permanent bearer after OAuth grant). Proposed: instance-level `max_oauth_token_lifetime` config (filed Apr 2026). **Error:** `invalid_grant` + generic message on failed refresh; race condition revokes previous token if multiple refresh requests simultaneous. **Refresh:** YES per OAuth spec; race condition: multiple concurrent refreshes cause token mismatch. **Gotcha:** No built-in refresh token family rotation; race condition: webhook storms revoke tokens; must implement token refresh lock.

Source: [GitLab Forum: Can refresh tokens expire](https://forum.gitlab.com/t/can-refresh-tokens-expire-for-gitlab-oauth/64886), [GitLab Issue #595536](https://gitlab.com/gitlab-org/gitlab/-/work_items/595536)

### 11. Qoder (Not found)
No public OAuth documentation found for "Qoder" — unclear if this is a real provider or internal 9Router alias. Recommend clarifying provider name or removing from scope.

---

## Synthesis: Refresh-Token Death Patterns

| Pattern | Providers | Detection Signal | Mitigation |
|---------|-----------|-----------------|-----------|
| **Expiry after inactivity** | Google (6mo), GitHub (1y) | 401, `invalid_grant`, `"revoked"` | Background refresh job to touch token every 30d |
| **Hard expiry** | Anthropic (undoc), Cursor (15m-1h) | 401, silent failure | Pre-emptive refresh before known expiry; hourly refresh for Cursor |
| **Single-use refresh** | GitHub, OpenAI Codex | `refresh_token_reused` (HTTP 401) | Atomic read-modify-write; fail-fast if reuse detected |
| **Family rotation + revoke** | Google (100-token limit), OpenAI Codex (implicit) | `invalid_grant` after hitting limit | Detect family revocation; notify user to re-auth (no silent recovery) |
| **Persistence not saved** | Kiro (SQLite mismatch), OpenAI Codex | Token mismatch on retry; 401 | Synchronous write to DB immediately after refresh |
| **Race condition** | GitLab, OpenAI Codex (concurrent refresh) | First refresh succeeds, 2nd/3rd fail | Implement mutual exclusion; return cached token under lock |
| **Test mode expiry** | Google (Testing status = 7d TTL) | `invalid_grant` after 7d | Warn users in docs not to use Testing mode clients in prod |
| **Missing refresh logic** | Cursor, Anthropic | Silent 401, tool failure | Explicit API to force re-login (no silent refresh) |

---

## HTTP Status & Error Body Signatures

### Standard `invalid_grant` (RFC 6749 §5.2)
```
HTTP 400 Bad Request
{
  "error": "invalid_grant",
  "error_description": "The provided authorization grant is invalid, expired, revoked..."
}
```

### Google-specific
```
HTTP 400 Bad Request
{
  "error": "invalid_grant",
  "error_description": "Token has been expired or revoked.",
  "error_uri": "https://developer.google.com/identity/protocols/oauth2/service-account#authorizingapi"
}
```

### GitHub-specific
```
HTTP 401 Unauthorized
{
  "error": "invalid_grant",
  "error_description": "The authorization code or refresh token has expired."
}
```

### OpenAI Codex-specific (family revocation)
```
HTTP 401 Unauthorized
{
  "error": "refresh_token_reused",
  "error_description": "Refresh token has already been used"
}
```
(Implies entire token family is revoked; no recovery without re-auth.)

### GitLab race condition
```
HTTP 400 Bad Request
{
  "error": "invalid_grant",
  "error_description": "The provided authorization grant is invalid..."
}
```
(First concurrent request wins; others fail silently.)

---

## Critical Gotchas for Feature Planning

1. **No silent recovery for family rotation.** OpenAI Codex and Google reuse detection invalidates the entire token family. Detect via `error: refresh_token_reused` or `error: invalid_grant` post-100-token-limit, then **require re-login**. Do NOT retry refresh.

2. **Persistence is responsibility of caller.** Kiro, GitHub, Google: after refresh succeeds, YOU must atomically save the new access + refresh token to DB. If refresh response is not persisted, the next refresh attempt fails (single-use refresh token already consumed).

3. **Race condition: mutual exclusion required.** GitLab, OpenAI Codex: if two requests hit token-refresh simultaneously, first wins, second gets 401. Implement per-connection refresh lock (e.g., mutex by providerConnectionId).

4. **Test mode expires in 7 days.** Google: if user's OAuth app is in "Testing" mode with "External" users, all tokens revoked after 7 days. Warn users in docs; 9Router should reject "testing" status in config validation.

5. **100-token limit is silent.** Google: hitting the 100-token-per-account limit silently revokes the *oldest* token without error message. Older 9Router instances may hit this on startup if they never delete dead tokens. Consider a cleanup job.

6. **Cursor doesn't use refresh tokens.** MCP OAuth layer bug. Access tokens expire ~15-60 min, and Cursor doesn't refresh. Only solution: force user to re-login or disable Cursor MCP in fallback chain.

7. **Anthropic stores but never uses refresh tokens.** Claude Code CLI stores refreshToken in Keychain but ignores it. Refresh tokens appear to expire on inactivity. Only reliable solution: API key auth for 9Router.

---

## Open Questions

1. **iFlow token lifetime:** What is the default refresh token expiration for iFlow's generic OAuth implementation? Requires SAP Knowledge Base access (paywalled).

2. **Qoder provider:** Is "Qoder" a real provider name? No public documentation found. Recommend clarifying or removing from scope.

3. **xAI token lifetime:** What is the exact access token and refresh token TTL for xAI Grok? OpenID metadata must be fetched from `https://auth.x.ai/.well-known/openid-configuration`.

4. **Cursor MCP fix timeline:** When will Cursor implement refresh token logic for MCP OAuth? Check Cursor forum and GitHub for issue status.

5. **Qwen discontinuation scope:** Does 9Router's Qwen integration use OAuth or API key? README says free OAuth tier discontinued, but need to confirm if free API tier also gone or just OAuth.

6. **GitLab instance-level cap:** Does the user's GitLab instance have `max_oauth_token_lifetime` configured? If yes, tokens expire sooner than doc-default (no explicit expiry).

---

## Recommendations for Feature Design

### Phase 1: Foundation
- Add `needs_reauth` boolean flag to provider connection schema.
- Detect `invalid_grant` in token refresh response; set flag = true.
- Do NOT retry refresh if error is `refresh_token_reused` (family rotation detected).

### Phase 2: Notifier
- On `needs_reauth = true`, emit event to notifier service.
- Notifier queues UI alert: "Provider X requires re-login. [Click to reconnect]".

### Phase 3: Fallback + UI
- Fallback chain skips providers with `needs_reauth = true`.
- UI deep-link: `dashboard://reconnect?provider=X&connectionId=Y` → OAuth callback clears flag.

### Phase 4: Edge Cases
- Atomic refresh + persist: use transaction or dual-write to ensure token saved.
- Per-connection mutex: prevent race condition on concurrent refresh.
- Google 100-token cleanup: add cron job to revoke oldest token on startup if hitting limit.

---

**Status:** DONE

**Summary:** Refresh-token lifecycle varies widely across 11 providers. Patterns emerge: inactivity revocation (Google, GitHub), single-use tokens (GitHub, Codex), family rotation (Google, Codex), race conditions (GitLab, Codex), and missing refresh logic (Cursor, Anthropic). Primary signals for death detection: `invalid_grant` (all), `refresh_token_reused` (Codex), 401 on retry. No silent recovery possible for family rotation; require explicit re-login flow.

**Concerns:** Anthropic and Cursor have broken refresh logic (by design or bugs) — API key + explicit re-login may be only viable paths. Qoder provider name unclear; iFlow/xAI documentation gaps require external validation.
