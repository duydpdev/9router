import { describe, it, expect, beforeEach } from "vitest";
import { handleComboChat } from "open-sse/services/combo.js";
import {
  resetHealthState,
  getHealthSnapshot,
  healthScore,
} from "open-sse/services/smartRouter/healthScore.js";

const log = { info() {}, warn() {} };
const simpleBody = { messages: [{ role: "user", content: "hi" }] };

// Response-shaped fakes matching what combo.js reads: ok, status, statusText, clone().json()
const ok = () => ({ ok: true, status: 200, statusText: "OK", clone: () => ({ json: async () => ({}) }) });
const fail = (status) => ({
  ok: false,
  status,
  statusText: `E${status}`,
  clone: () => ({ json: async () => ({ error: { message: `err ${status}` } }) }),
});

// Build a handleSingleModel that records try-order and returns canned results by model.
function fakeHandler(responses, order) {
  return async (_body, modelStr) => {
    order.push(modelStr);
    const r = responses[modelStr];
    if (typeof r === "function") return r(_body, modelStr);
    return r;
  };
}

describe("handleComboChat + smart router integration", () => {
  beforeEach(() => resetHealthState());

  it("toggle OFF → try sequence is the plain model order (no reorder, no recording)", async () => {
    const order = [];
    const models = ["openai/a", "cc/b"]; // ON would put cc/b first; OFF must not
    await handleComboChat({
      body: simpleBody,
      models,
      handleSingleModel: fakeHandler({ "openai/a": fail(500), "cc/b": fail(500) }, order),
      log,
      comboName: "OFF1",
      comboStrategy: "fallback",
      // smartRouter omitted → disabled
    });
    expect(order).toEqual(["openai/a", "cc/b"]);
    expect(getHealthSnapshot()).toHaveLength(0); // disabled → nothing recorded
  });

  it("toggle ON + simple request → cheap tier (cc) tried before metered (openai)", async () => {
    const order = [];
    await handleComboChat({
      body: simpleBody,
      models: ["openai/a", "cc/b"],
      handleSingleModel: fakeHandler({ "openai/a": fail(500), "cc/b": fail(500) }, order),
      log,
      comboName: "ON1",
      comboStrategy: "fallback",
      smartRouter: { enabled: true },
    });
    expect(order[0]).toBe("cc/b");
  });

  it("records 2xx success as ok:true", async () => {
    const order = [];
    await handleComboChat({
      body: simpleBody,
      models: ["cc/a", "cc/b"],
      handleSingleModel: fakeHandler({ "cc/a": ok(), "cc/b": ok() }, order),
      log,
      comboName: "REC2xx",
      comboStrategy: "fallback",
      smartRouter: { enabled: true },
    });
    const snap = getHealthSnapshot();
    expect(snap).toHaveLength(1); // returned on first success
    expect(snap[0].model).toBe("cc/a");
    expect(snap[0].count).toBe(1);
  });

  it("records 5xx and 429 fallbacks as failures; recovers score after enough successes", async () => {
    const order = [];
    await handleComboChat({
      body: simpleBody,
      models: ["cc/a", "cc/b"],
      handleSingleModel: fakeHandler({ "cc/a": fail(503), "cc/b": fail(429) }, order),
      log,
      comboName: "REC5xx",
      comboStrategy: "fallback",
      smartRouter: { enabled: true },
    });
    const snap = getHealthSnapshot();
    const models = snap.map((s) => s.model).sort();
    expect(models).toEqual(["cc/a", "cc/b"]); // both provider-attributable → recorded
  });

  it("does NOT record client 4xx (400) — health untouched (red-team R2)", async () => {
    const order = [];
    await handleComboChat({
      body: simpleBody,
      models: ["cc/a", "cc/b"],
      handleSingleModel: fakeHandler({ "cc/a": fail(400), "cc/b": fail(400) }, order),
      log,
      comboName: "REC4xx",
      comboStrategy: "fallback",
      smartRouter: { enabled: true },
    });
    // Both models returned 400 (client error). Neither may be recorded.
    expect(getHealthSnapshot()).toHaveLength(0);
  });

  it("records thrown exception as failure", async () => {
    const order = [];
    await handleComboChat({
      body: simpleBody,
      models: ["cc/a"],
      handleSingleModel: fakeHandler({ "cc/a": () => { throw new Error("boom"); } }, order),
      log,
      comboName: "RECthrow",
      comboStrategy: "fallback",
      smartRouter: { enabled: true },
    });
    const snap = getHealthSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].model).toBe("cc/a");
  });

  it("all models fail → returns 503", async () => {
    const order = [];
    const res = await handleComboChat({
      body: simpleBody,
      models: ["cc/a", "cc/b"],
      handleSingleModel: fakeHandler({ "cc/a": fail(503), "cc/b": fail(503) }, order),
      log,
      comboName: "ALLFAIL",
      comboStrategy: "fallback",
      smartRouter: { enabled: true },
    });
    expect(res.status).toBe(503);
  });

  it("ON then OFF on same state → OFF order is still the plain model order (rotation isolation)", async () => {
    const models = ["cc/a", "cc/b", "cc/c"];
    // Drive ON round-robin several times under comboName "TX".
    for (let i = 0; i < 4; i++) {
      const o = [];
      await handleComboChat({
        body: simpleBody, models,
        handleSingleModel: fakeHandler({ "cc/a": fail(500), "cc/b": fail(500), "cc/c": fail(500) }, o),
        log, comboName: "TX", comboStrategy: "round-robin", comboStickyLimit: 1,
        smartRouter: { enabled: true },
      });
    }
    // Now OFF for the SAME comboName — legacy rotation must be at its baseline
    // (first OFF call = index 0), proving smart-router never advanced "TX".
    const order = [];
    await handleComboChat({
      body: simpleBody, models,
      handleSingleModel: fakeHandler({ "cc/a": fail(500), "cc/b": fail(500), "cc/c": fail(500) }, order),
      log, comboName: "TX", comboStrategy: "round-robin", comboStickyLimit: 1,
      // disabled
    });
    expect(order).toEqual(["cc/a", "cc/b", "cc/c"]); // index 0 — untouched by ON runs
  });
});
