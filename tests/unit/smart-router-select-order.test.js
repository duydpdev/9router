import { describe, it, expect, beforeEach } from "vitest";
import { selectModelOrder } from "open-sse/services/smartRouter/index.js";
import { recordResult, resetHealthState, MIN_SAMPLES } from "open-sse/services/smartRouter/healthScore.js";
import { getRotatedModels } from "open-sse/services/combo.js";

const simpleBody = { messages: [{ role: "user", content: "hi" }] };
const complexBody = { messages: [{ role: "user", content: "ok" }], tools: [{ type: "function" }] };
const fill = (model, ok) => { for (let i = 0; i < MIN_SAMPLES; i++) recordResult(model, { ok }); };

describe("selectModelOrder", () => {
  beforeEach(() => resetHealthState());

  it("models.length <= 1 → returned unchanged", () => {
    expect(selectModelOrder({ models: ["cc/a"], body: simpleBody, comboName: "C" })).toEqual(["cc/a"]);
    expect(selectModelOrder({ models: [], body: simpleBody, comboName: "C" })).toEqual([]);
  });

  it("simple request → cheap (OAuth/free) tier first", () => {
    const out = selectModelOrder({
      models: ["openai/gpt-4o-mini", "cc/claude-opus"],
      body: simpleBody,
      comboName: "C",
    });
    expect(out[0]).toBe("cc/claude-opus");
  });

  it("complex request → capable (metered API) tier first", () => {
    const out = selectModelOrder({
      models: ["cc/claude-opus", "openai/gpt-4o-mini"],
      body: complexBody,
      comboName: "C",
    });
    expect(out[0]).toBe("openai/gpt-4o-mini");
  });

  it("within preferred tier, healthier model ordered ahead after samples", () => {
    fill("cc/healthy", true);
    fill("cc/sick", false);
    const out = selectModelOrder({
      models: ["cc/sick", "cc/healthy"],
      body: simpleBody,
      comboName: "C",
    });
    expect(out).toEqual(["cc/healthy", "cc/sick"]);
  });

  it("cold start (all-neutral) → cost-tier order preserved (stable sort), no crash", () => {
    const out = selectModelOrder({
      models: ["cc/a", "cc/b", "openai/c"],
      body: simpleBody,
      comboName: "C",
    });
    expect(out).toEqual(["cc/a", "cc/b", "openai/c"]); // cheap tier keeps input order
  });

  it("round-robin rotates within preferred tier and does NOT mutate comboRotationState", () => {
    const models = ["cc/a", "cc/b", "cc/c"];
    // Baseline: legacy rotation for comboName "C" starts at index 0.
    const before = getRotatedModels(models, "C", "round-robin", 1);
    // Drive smart-router round-robin many times under the same comboName.
    for (let i = 0; i < 5; i++) {
      selectModelOrder({ models, body: simpleBody, comboName: "C", comboStrategy: "round-robin", comboStickyLimit: 1 });
    }
    // Legacy rotation for "C" must be unaffected by smart-router (tier-scoped key).
    // before advanced "C" by exactly 1 step; the next legacy call should be the
    // step after `before`, with NO extra advances injected by selectModelOrder.
    const after = getRotatedModels(models, "C", "round-robin", 1);
    expect(after).not.toEqual(before); // legacy advanced by its own 1 call only
    // Re-deriving the expected sequence proves smart-router never touched "C":
    expect(before).toEqual(["cc/a", "cc/b", "cc/c"]);
    expect(after).toEqual(["cc/b", "cc/c", "cc/a"]);
  });

  it("round-robin keeps rotating even when tier members have differing health (stable tier key)", () => {
    const models = ["cc/a", "cc/b", "cc/c"];
    // Give the tier non-uniform, DIFFERING health so the health-sorted order is
    // a fixed permutation — the rotation key must key on stable tier membership,
    // not the sorted order, or the index resets every call and never advances.
    fill("cc/a", true); // 1.0
    fill("cc/b", false); // 0.0
    recordResult("cc/c", { ok: true });
    recordResult("cc/c", { ok: true });
    recordResult("cc/c", { ok: true });
    recordResult("cc/c", { ok: false });
    recordResult("cc/c", { ok: false }); // 0.6
    const seq = [];
    for (let i = 0; i < 3; i++) {
      seq.push(
        selectModelOrder({
          models, body: simpleBody, comboName: "RR2",
          comboStrategy: "round-robin", comboStickyLimit: 1,
        })[0]
      );
    }
    // Health order is fixed [cc/a(1.0), cc/c(0.6), cc/b(0.0)]; rotation must walk
    // the head across calls rather than returning the same model every time.
    expect(new Set(seq).size).toBeGreaterThan(1);
  });
});
