/**
 * Cost-fit tierer — buckets combo models into cheap vs capable by provider
 * AUTH TYPE, not sticker price.
 *
 * Why auth-type: 9router's headline providers are OAuth/subscription/free
 * (cc, cx, gc, gh, cu...). A model the user pays $0 to use via subscription
 * still reports a high API sticker price ($30 for Opus), which would invert the
 * cost tier and push simple traffic onto metered API keys. Set-membership in
 * the free/OAuth/web-cookie provider groups reflects the real per-request cost
 * to the user. Pure function: no state, no I/O.
 */

import {
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  OAUTH_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
} from "@/shared/constants/providers";
import { parseModel } from "../model.js";

// Providers that cost the user ≈$0 per request (subscription / OAuth session /
// free tier / web-cookie). Everything else (metered API keys) → "capable".
// FREE_TIER providers are intentionally cheap: they carry a real free quota the
// user is expected to consume first. Once that quota is exhausted they bill
// metered — accepted trade-off; "use the free allowance first" is the goal.
const CHEAP_PROVIDER_IDS = new Set([
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(WEB_COOKIE_PROVIDERS),
]);

/**
 * @param {string} modelStr - combo entry, e.g. "cc/claude-opus-4-6"
 * @returns {boolean} true if the resolved provider is in a cheap auth group.
 *   Unknown / unresolved provider → false (treated as capable, never cheap) so
 *   simple traffic is never routed to an unrecognized (possibly metered) model.
 */
export function isCheapProvider(modelStr) {
  const { provider } = parseModel(modelStr); // resolves alias → provider id
  if (!provider) return false;
  return CHEAP_PROVIDER_IDS.has(provider);
}

/**
 * Tier combo models, preserving original relative order within each tier.
 * @param {string[]} models
 * @param {"simple"|"complex"} complexity
 * @returns {{ first: string[], second: string[] }}
 *   simple  → { first: cheap,   second: capable }
 *   complex → { first: capable, second: cheap }
 */
export function costFit(models, complexity) {
  const cheap = [];
  const capable = [];
  for (const m of models) (isCheapProvider(m) ? cheap : capable).push(m);
  return complexity === "simple"
    ? { first: cheap, second: capable }
    : { first: capable, second: cheap };
}
