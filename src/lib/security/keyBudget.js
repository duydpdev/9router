// Per-key daily budget monitor. The evaluator (evaluateBudget) is pure; the
// monitor subscribes to the post-completion usage event, reads today's per-key
// totals, evaluates the tier, and fires a de-duplicated alert. Alert-only —
// nothing here ever blocks or disables a key.
import { statsEmitter, getTodayUsageForKey } from "../db/repos/usageRepo.js";
import { getCachedBotSettings } from "./botSettingsCache.js";
import { keyHash } from "./keyHash.js";
import { notifyKeyBudget } from "../notifier/key-budget-alert.js";

export const TIER_WARN = "warn";
export const TIER_OVER = "over";

const TIER_RANK = { warn: 1, over: 2 };

// keyHash → { dateKey, tier, lastSentMs }. Bounded like rateLimiter: insertion-
// order eviction at MAX_KEYS + a sweep() that drops stale-day entries. Restart
// resets it, which costs at most one extra re-alert after restart (acceptable).
const sentState = new Map();
const MAX_KEYS = 50_000;

let _monitorRegistered = false;

// Decide the budget tier for one key's today-usage against its budget.
// tier ∈ null | "warn" | "over". pct = the higher of the token/request axes,
// so token OR request (whichever crosses first) drives the alert. A zero or
// missing per-day limit disables that axis (contributes 0%, no div-by-zero).
export function evaluateBudget({ tokens = 0, requests = 0 } = {}, { tokenPerDay = 0, requestPerDay = 0, warnAtPercent = 80 } = {}) {
  const tokPct = tokenPerDay > 0 ? (tokens / tokenPerDay) * 100 : 0;
  const reqPct = requestPerDay > 0 ? (requests / requestPerDay) * 100 : 0;
  const pct = Math.max(tokPct, reqPct);
  if (pct >= 100) return { tier: TIER_OVER, pct };
  if (pct >= warnAtPercent) return { tier: TIER_WARN, pct };
  return { tier: null, pct };
}

// Local-day key, same shape the usageDaily write side uses. Dedup only needs to
// know when the calendar day rolls over; matching the write-side derivation
// keeps "today" consistent between the reader and the dedup window.
function getLocalDateKey(now = Date.now) {
  const d = new Date(now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Decide whether to send given the prior send-state. Fires on: first sighting,
// a new day, a tier escalation (warn→over), or a re-alert interval elapsing
// while still "over". Pure — no side effects.
function shouldSend(prev, tier, dateKey, nowMs, reAlertMs) {
  if (!prev || prev.dateKey !== dateKey) return true;
  if (TIER_RANK[tier] > TIER_RANK[prev.tier]) return true;
  if (tier === TIER_OVER && nowMs - prev.lastSentMs >= reAlertMs) return true;
  return false;
}

// Default settings reader: the cached botProtection block; returns the keyBudget
// config only when both bot protection and the budget monitor are enabled.
async function defaultGetBudget() {
  const bp = await getCachedBotSettings();
  if (!bp || bp.enabled === false) return null;
  const kb = bp.keyBudget;
  if (!kb || kb.enabled === false) return null;
  return kb;
}

// Evaluate one key's today-usage and fire a de-duplicated alert if it crosses a
// tier. Off the /v1 hot path (runs from the post-completion usage event). Never
// throws — best-effort, must never affect request flow. Deps are injectable for
// deterministic tests.
export async function checkKeyBudget(apiKey, deps = {}) {
  const {
    now = Date.now,
    getBudget = defaultGetBudget,
    getUsage = getTodayUsageForKey,
    notify = notifyKeyBudget,
  } = deps;
  try {
    if (!apiKey) return { sent: false, reason: "no_key" };
    const budget = await getBudget();
    if (!budget) return { sent: false, reason: "disabled" };

    const usage = await getUsage(apiKey);
    const { tier, pct } = evaluateBudget(usage, budget);
    if (!tier) return { sent: false, reason: "under" };

    const nowMs = now();
    const dateKey = getLocalDateKey(now);
    const hash = keyHash(apiKey);
    const reAlertMs = (budget.reAlertHours > 0 ? budget.reAlertHours : 4) * 60 * 60 * 1000;

    const prev = sentState.get(hash);
    if (!shouldSend(prev, tier, dateKey, nowMs, reAlertMs)) {
      return { sent: false, reason: "deduped" };
    }

    // Claim synchronously BEFORE awaiting the notifier so concurrent events for
    // the same key see the claim and bail — exactly one send under fan-in.
    claimSlot(hash, { dateKey, tier, lastSentMs: nowMs });

    await notify({ apiKey, keyHash: hash, tier, pct, usage, budget }, nowMs);
    return { sent: true, tier, pct };
  } catch (error) {
    return { sent: false, error: String(error?.message || error) };
  }
}

// Insert/update with insertion-order eviction at capacity (mirror rateLimiter).
function claimSlot(hash, value) {
  if (!sentState.has(hash) && sentState.size >= MAX_KEYS) {
    sentState.delete(sentState.keys().next().value);
  }
  sentState.set(hash, value);
}

// Drop entries from a previous day. Periodic backstop; mirrors rateLimiter.sweep.
export function sweep(now = Date.now) {
  const today = getLocalDateKey(now);
  for (const [hash, v] of sentState) {
    if (v.dateKey !== today) sentState.delete(hash);
  }
}

// Subscribe the monitor to the post-completion usage event. Idempotent — guarded
// so HMR / re-import does not double-register. The handler is fire-and-forget
// off a microtask, with both async and synchronous throws swallowed so a bad
// alert can never escape into the emitter or the request path.
export function initKeyBudgetMonitor() {
  if (_monitorRegistered) return;
  _monitorRegistered = true;
  statsEmitter.on("usage", ({ apiKey } = {}) => {
    if (!apiKey) return; // keyless / CLI-token path is out of budget scope
    queueMicrotask(() => {
      try {
        void checkKeyBudget(apiKey).catch(() => {});
      } catch {
        /* never let a monitor error touch the emitter */
      }
    });
  });
}

export const __test__ = {
  reset: () => {
    sentState.clear();
    _monitorRegistered = false;
  },
  size: () => sentState.size,
  MAX_KEYS,
};
