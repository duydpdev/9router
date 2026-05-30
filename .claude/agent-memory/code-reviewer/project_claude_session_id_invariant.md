---
name: claude-session-id-invariant
description: Claude OAuth fingerprint invariant — body metadata.user_id.session_id must match the X-Claude-Code-Session-Id header
metadata:
  type: project
---

For Claude provider OAuth traffic (`sk-ant-oat` tokens), there is a documented fingerprint-consistency invariant: the request body `metadata.user_id.session_id` MUST equal the outgoing `x-claude-code-session-id` header value.

Where it lives:
- Body side: `open-sse/translator/helpers/claudeHelper.js` `prepareClaudeRequest` → `applyCloaking` (`open-sse/utils/claudeCloaking.js` `generateFakeUserID`), session_id sourced from `deriveSessionId(connectionId)` (binary-style `UUID + Date.now()`, store `runtimeSessionStore`).
- Header side: `open-sse/executors/default.js` `case "claude"` injects `x-claude-code-session-id` from `deriveClaudeSessionId(connectionId)` (plain `randomUUID()`, separate store `claudeSessionStore`).

**Why:** Anthropic-side fingerprinting may cross-check header vs body session_id. A mismatch can flag synthetic/warmup traffic. The two derive functions use different formats AND different Maps, so they never coincide — any code that sets only one side breaks the invariant.

**How to apply:** When reviewing changes that touch either the header injection or the body cloaking session_id, verify both sides resolve to the SAME value for the same connectionId. The comments at claudeHelper.js:208 and claudeCloaking.js:108/135 assert this coupling but nothing enforces it in code.
