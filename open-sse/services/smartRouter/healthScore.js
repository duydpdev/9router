/**
 * Per-model windowed success-rate — the single health signal for the smart
 * router. Records each combo attempt's outcome into a sliding window and
 * exposes a 0..1 score used to order models within a cost tier.
 *
 * Design:
 *  - Windowed (not lifetime): a recovered provider climbs back to healthy after
 *    WINDOW good results — past outages are forgotten, no decay math (KISS).
 *  - LRU-bounded Map: config churn can churn model keys; cap bounds the state.
 *  - No latency factor, no recent-error penalty: latency at the combo layer is
 *    TTFT/orchestration not provider speed, and a time penalty would duplicate
 *    and fight the account-layer cooldown. Success-rate only.
 *  - Score has NO wall-clock branch → deterministic given recorded outcomes.
 */

const MIN_SAMPLES = 5; // below this → neutral (avoid low-traffic skew)
const NEUTRAL = 0.7; // unseen / under-sampled score
const WINDOW = 50; // sliding window of recent outcomes per model
const MAX_TRACKED = 256; // LRU cap on distinct model keys

// Insertion-ordered Map doubles as LRU: delete+set on touch moves a key to the
// MRU end; the oldest key is keys().next() when evicting.
// Map<modelStr, { outcomes: boolean[], idx: number, count: number, lastTouch: number }>
const state = new Map();

/**
 * Record one attempt outcome for a model.
 * @param {string} modelStr - combo entry key (e.g. "claude/claude-sonnet-4-6")
 * @param {{ ok: boolean }} result
 * @param {number} [now] - injectable clock for lastTouch determinism in tests
 */
export function recordResult(modelStr, { ok }, now = Date.now()) {
  let s = state.get(modelStr);
  if (s) state.delete(modelStr); // re-insert → move to MRU end
  else s = { outcomes: new Array(WINDOW), idx: 0, count: 0 };
  s.outcomes[s.idx % WINDOW] = !!ok;
  s.idx++;
  s.count = Math.min(s.count + 1, WINDOW);
  s.lastTouch = now;
  state.set(modelStr, s);
  if (state.size > MAX_TRACKED) state.delete(state.keys().next().value); // evict LRU
}

/**
 * Windowed success-rate in [0,1]. Unseen / under-sampled → NEUTRAL.
 * @param {string} modelStr
 * @returns {number}
 */
export function healthScore(modelStr) {
  const s = state.get(modelStr);
  if (!s || s.count < MIN_SAMPLES) return NEUTRAL;
  let ok = 0;
  for (let i = 0; i < s.count; i++) if (s.outcomes[i]) ok++;
  return ok / s.count;
}

/**
 * Clear health state — one model or all. Exists for tests + future manual
 * escape; intentionally NOT auto-wired into combo/settings routes (health is
 * model-scoped and independent of combo membership).
 * @param {string} [modelStr] - omit to clear everything
 */
export function resetHealthState(modelStr) {
  if (modelStr) state.delete(modelStr);
  else state.clear();
}

/**
 * Read-only snapshot for tests / future observability.
 * @returns {Array<{ model: string, score: number, count: number, lastTouch: number }>}
 */
export function getHealthSnapshot() {
  const out = [];
  for (const [model, s] of state) {
    out.push({ model, score: healthScore(model), count: s.count, lastTouch: s.lastTouch });
  }
  return out;
}

// Exported for unit tests (window/cap boundary assertions).
export { MIN_SAMPLES, NEUTRAL, WINDOW, MAX_TRACKED };
