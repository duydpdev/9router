// Classifier — maps a refresh-failure shape to one of:
//   "invalid_grant"            — refresh token rejected (RFC 6749 fatal)
//   "refresh_family_revoked"   — Auth0/Codex family rotation invalidated
//   "refresh_http_error"       — HTTP 4xx with no recognizable body, post-retry
//   null                       — transient / unknown; do NOT mark needsReauth
//
// Used by `checkAndRefreshToken` and `forceRefresh` to drive Case-B detection.
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh.js";

const FATAL_GRANT_PATTERNS = [
  /invalid_grant/i,
  /invalid_request/i,
  /token_expired/i,
  /expired_token/i,
  /unauthorized_client/i,
];

const FAMILY_ROTATION_PATTERNS = [
  /refresh_token_reused/i,
  /token has been used/i,
];

// Body matches that signal a TRANSIENT outage — must NOT be classified fatal.
const TRANSIENT_PATTERNS = [
  /temporarily_unavailable/i,
  /service_unavailable/i,
  /secondary_rate_limit/i,
  /slow_down/i,
  /try_again/i,
];

function matchAny(patterns, haystack) {
  if (haystack == null) return false;
  const s = String(haystack);
  return patterns.some((re) => re.test(s));
}

export function isFatalRefreshFailure(input) {
  if (input == null) return null;

  // 1) Plain string — pattern match
  if (typeof input === "string") {
    if (matchAny(TRANSIENT_PATTERNS, input)) return null;
    if (matchAny(FAMILY_ROTATION_PATTERNS, input)) return "refresh_family_revoked";
    if (matchAny(FATAL_GRANT_PATTERNS, input)) return "invalid_grant";
    return null;
  }

  // 2) Codex tagged shape
  if (input.error === "unrecoverable_refresh_error") {
    if (input.code === "refresh_token_reused") return "refresh_family_revoked";
    return "invalid_grant";
  }

  // 3) Reuse the existing detector for { error: "invalid_grant" | ... }
  if (isUnrecoverableRefreshError(input)) return "invalid_grant";

  // 4) Tagged refresh_failed shape from refactored refresh primitives —
  //    inspect status + body. Transient body short-circuits to null.
  const body = String(input.body ?? "");
  if (matchAny(TRANSIENT_PATTERNS, body)) return null;
  if (matchAny(FAMILY_ROTATION_PATTERNS, body)) return "refresh_family_revoked";
  if (matchAny(FATAL_GRANT_PATTERNS, body)) return "invalid_grant";

  // 5) Generic Error object — sniff message / error / error_description
  const sources = [input.message, input.error, input.error_description];
  for (const s of sources) {
    if (matchAny(TRANSIENT_PATTERNS, s)) return null;
    if (matchAny(FAMILY_ROTATION_PATTERNS, s)) return "refresh_family_revoked";
    if (matchAny(FATAL_GRANT_PATTERNS, s)) return "invalid_grant";
  }

  // HTTP 4xx without body match — DO NOT auto-classify fatal (per F8).
  return null;
}
