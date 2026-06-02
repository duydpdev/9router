/**
 * Smart router selection — combines cost tier (Phase 1) + health (Phase 2) into
 * a single ordered combo model list. Opt-in: callers only use this when
 * settings.smartRouter.enabled is true; the OFF path stays on getRotatedModels.
 */

import { classifyComplexity } from "./complexity.js";
import { costFit } from "./costFit.js";
import { healthScore } from "./healthScore.js";
import { getRotatedModels } from "../combo.js"; // reuse rotation impl only

/**
 * Order combo models: classify request → split into cost tiers → within each
 * tier sort by health desc → flatten (preferred tier first).
 *
 * @param {object} args
 * @param {string[]} args.models
 * @param {object} args.body - request body (any supported shape)
 * @param {string} args.comboName
 * @param {string} [args.comboStrategy] - "fallback" | "round-robin"
 * @param {number|string} [args.comboStickyLimit]
 * @returns {string[]} reordered model list
 */
export function selectModelOrder({ models, body, comboName, comboStrategy, comboStickyLimit }) {
  if (!models || models.length <= 1) return models;

  const complexity = classifyComplexity(body);
  const { first, second } = costFit(models, complexity);

  // Stable sort: equal scores (e.g. cold-start all-neutral) preserve cost-tier order.
  const sortByHealth = (arr) => [...arr].sort((a, b) => healthScore(b) - healthScore(a));

  let preferred = sortByHealth(first);

  // Round-robin spreads load within the preferred tier — but keyed by a
  // TIER-SCOPED key, never comboName. Feeding getRotatedModels a variable-length
  // tier under comboName would corrupt the shared comboRotationState that the
  // OFF path reads, breaking the byte-identical OFF guarantee. A distinct key
  // isolates smart-router rotation from legacy state entirely.
  //
  // Key is built from `first` (the cost tier in STABLE costFit order), NOT the
  // health-sorted `preferred`: health scores shift between requests, so keying on
  // the sorted order would mint a fresh rotation entry every request — the index
  // would reset to 0 each time (no real rotation) and comboRotationState would
  // grow unbounded. Stable tier membership → one rotation entry per (combo,
  // complexity, tier) that advances coherently.
  if (comboStrategy === "round-robin" && preferred.length > 1) {
    const tierKey = `${comboName}::sr::${complexity}::${first.join(",")}`;
    preferred = getRotatedModels(preferred, tierKey, comboStrategy, comboStickyLimit);
  }

  return [...preferred, ...sortByHealth(second)];
}
