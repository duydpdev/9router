// Pure classifier mapping a normalized quota object + poll outcome to a
// session-window verdict. No I/O. The only clock use is a single past/future
// check on the reset timestamp (no tolerance math, no clock-skew dependency).

const SESSION_PROVIDERS = new Set(["claude", "codex"]);

// `v` is an ISO string (or null) already normalized upstream by parseResetTime
// (usage.js) — epoch handling is NOT reimplemented here. Validate with one
// finite Date.parse check; return the string as-is on success, else null.
export function normalizeResetAt(v) {
  if (typeof v !== "string" || !v) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

// `v` is `quota.used` — the % USED on the normalized quota object (claude
// createQuotaObject.used = utilization; codex formatCodexWindow.used). Finite
// number clamped to [0,100]; negative or non-finite → null. 0 is a valid value.
export function normalizeUtil(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.min(100, n);
}

/**
 * @param {object} args
 * @param {string} args.provider        provider id
 * @param {object|null} args.quota       the NORMALIZED quota object {used, resetAt, ...}
 * @param {boolean} args.usageOk         whether the usage poll yielded quotas
 * @param {boolean} args.authoritative   true only for the primary/OAuth usage shape
 * @returns {{sessionState: string, resetsAt: string|null, utilization: number|null}}
 */
export function classifyWarmupSession({ provider, quota, usageOk, authoritative }) {
  if (!SESSION_PROVIDERS.has(provider)) {
    return { sessionState: "n/a", resetsAt: null, utilization: null };
  }
  if (!usageOk) {
    return { sessionState: "unknown", resetsAt: null, utilization: null };
  }

  const resetsAt = normalizeResetAt(quota?.resetAt);
  const utilization = normalizeUtil(quota?.used);

  // A valid future reset means an active 5h window exists — whether this warmup
  // opened it or it was already open. Both are healthy; we do not distinguish.
  if (resetsAt && Date.parse(resetsAt) > Date.now()) {
    return { sessionState: "active", resetsAt, utilization };
  }

  // No usable future reset. Only call it not-registered for an AUTHORITATIVE
  // response that genuinely lacks the window. A non-authoritative/ambiguous
  // response (e.g. Claude legacy fallback returning quotas without a session
  // key) is `unknown`, not a false alarm.
  return { sessionState: authoritative ? "not-registered" : "unknown", resetsAt: null, utilization };
}
