// Client IP extraction. Single source of truth (loginLimiter re-exports getClientIp).

// Parse x-forwarded-for first hop → x-real-ip → "unknown".
// Behind a reverse proxy that SETS xff, the first hop is the real client.
// Directly exposed, the whole header is client-supplied (see getTrustedClientIp).
export function getClientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "unknown";
}

// IP for bot-protection bucketing. trustProxy gates whether the forwarded
// value can be trusted as the real client:
//   trustProxy:true  → behind nginx; xff first hop is authoritative.
//   trustProxy:false → directly exposed; xff is client-forgeable. Next.js
//     middleware exposes no socket IP, so we still bucket by the parsed value,
//     but callers treat rate limits as best-effort and must NOT ban off it
//     (fail2ban bans off the nginx log instead — see deploy docs).
export function getTrustedClientIp(request, { trustProxy = false } = {}) {
  // Same derivation either way; the difference is how much the caller trusts it.
  return getClientIp(request);
}
