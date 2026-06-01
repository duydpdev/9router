import { describe, it, expect } from "vitest";
import { evaluateBudget } from "@/lib/security/keyBudget";

const BUDGET = { tokenPerDay: 1000, requestPerDay: 100, warnAtPercent: 80 };

describe("evaluateBudget", () => {
  it("tier null below warn threshold", () => {
    const r = evaluateBudget({ tokens: 700, requests: 0 }, BUDGET); // 70%
    expect(r.tier).toBeNull();
    expect(r.pct).toBeCloseTo(70);
  });

  it("tier 'warn' exactly at warnAtPercent", () => {
    const r = evaluateBudget({ tokens: 800, requests: 0 }, BUDGET); // 80%
    expect(r.tier).toBe("warn");
    expect(r.pct).toBeCloseTo(80);
  });

  it("tier 'over' at >= 100%", () => {
    const r = evaluateBudget({ tokens: 1000, requests: 0 }, BUDGET);
    expect(r.tier).toBe("over");
    expect(r.pct).toBeGreaterThanOrEqual(100);
  });

  it("token-only over trips even when requests = 0", () => {
    const r = evaluateBudget({ tokens: 5000, requests: 0 }, BUDGET);
    expect(r.tier).toBe("over");
  });

  it("request-only over trips even when tokens = 0", () => {
    const r = evaluateBudget({ tokens: 0, requests: 150 }, BUDGET); // 150% of requests
    expect(r.tier).toBe("over");
    expect(r.pct).toBeCloseTo(150);
  });

  it("pct is the max of the two axes (whichever crosses first)", () => {
    const r = evaluateBudget({ tokens: 100, requests: 90 }, BUDGET); // tok 10%, req 90%
    expect(r.pct).toBeCloseTo(90);
    expect(r.tier).toBe("warn");
  });

  it("tokenPerDay = 0 → token axis ignored, no div-by-zero", () => {
    const r = evaluateBudget({ tokens: 99999, requests: 50 }, { tokenPerDay: 0, requestPerDay: 100, warnAtPercent: 80 });
    expect(r.pct).toBeCloseTo(50); // only request axis counts
    expect(r.tier).toBeNull();
  });

  it("requestPerDay = 0 → request axis ignored", () => {
    const r = evaluateBudget({ tokens: 900, requests: 99999 }, { tokenPerDay: 1000, requestPerDay: 0, warnAtPercent: 80 });
    expect(r.pct).toBeCloseTo(90);
    expect(r.tier).toBe("warn");
  });
});
