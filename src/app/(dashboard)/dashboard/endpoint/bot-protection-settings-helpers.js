// Pure input/display helpers for BotProtectionSettings. Kept in a plain (no-JSX)
// module so they can be unit-tested without a JSX/DOM render harness.

export function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// warnAtPercent must stay in 1-100 — a value >100 makes the warn tier
// unreachable (it would only trip at/after the 100% "over" tier).
export function clampPercent(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, n));
}

// Budget alerts reuse the warmup notifier and fire only when a channel is live.
// Warn the operator when budgets are on but no channel is configured, else the
// alerts are silently dropped.
export function shouldShowChannelWarning(budgetEnabled, notifierEnabled) {
  return budgetEnabled === true && notifierEnabled !== true;
}
