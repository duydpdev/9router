import { describe, it, expect } from "vitest";
import { __test__ } from "@/lib/db/repos/settingsRepo";

const { mergeWithDefaults } = __test__;

describe("botProtection.keyBudget settings merge", () => {
  it("empty raw → keyBudget fully populated with 5 defaults", () => {
    const m = mergeWithDefaults({});
    const kb = m.botProtection.keyBudget;
    expect(kb).toBeDefined();
    expect(typeof kb.enabled).toBe("boolean");
    expect(kb.tokenPerDay).toBeGreaterThan(0);
    expect(kb.requestPerDay).toBeGreaterThan(0);
    expect(kb.warnAtPercent).toBeGreaterThan(0);
    expect(kb.warnAtPercent).toBeLessThanOrEqual(100);
    expect(kb.reAlertHours).toBeGreaterThan(0);
  });

  it("partial keyBudget override preserves the other 4 keys AND botProtection siblings", () => {
    const m = mergeWithDefaults({ botProtection: { keyBudget: { tokenPerDay: 99 } } });
    const kb = m.botProtection.keyBudget;
    expect(kb.tokenPerDay).toBe(99); // user override honored
    // other 4 keyBudget defaults preserved
    expect(typeof kb.enabled).toBe("boolean");
    expect(kb.requestPerDay).toBeGreaterThan(0);
    expect(kb.warnAtPercent).toBeGreaterThan(0);
    expect(kb.reAlertHours).toBeGreaterThan(0);
    // sibling botProtection sub-objects preserved
    expect(m.botProtection.rateLimit.limit).toBeGreaterThan(0);
    expect(m.botProtection.llmRateLimit.keyLimit).toBeGreaterThan(0);
    expect(m.botProtection.enabled).toBe(true);
  });

  it("does not clobber top-level siblings (no regression)", () => {
    const m = mergeWithDefaults({ botProtection: { keyBudget: { requestPerDay: 1 } } });
    expect(m.cavemanLevel).toBe("full");
    expect(m.rtkEnabled).toBe(true);
  });
});
