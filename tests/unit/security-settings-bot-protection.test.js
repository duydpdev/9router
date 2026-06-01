import { describe, it, expect } from "vitest";
import { __test__ } from "@/lib/db/repos/settingsRepo";

const { mergeWithDefaults } = __test__;

describe("botProtection settings merge", () => {
  it("empty raw → botProtection fully populated with defaults", () => {
    const m = mergeWithDefaults({});
    expect(m.botProtection).toBeDefined();
    expect(m.botProtection.enabled).toBe(true);
    expect(m.botProtection.trustProxy).toBe(false);
    expect(m.botProtection.blockProbePaths).toBe(true);
    expect(m.botProtection.rateLimit.limit).toBeGreaterThan(0);
    expect(m.botProtection.llmRateLimit.keyLimit).toBeGreaterThan(0);
  });

  it("partial override keeps sibling sub-defaults (nested merge)", () => {
    const m = mergeWithDefaults({ botProtection: { enabled: false } });
    expect(m.botProtection.enabled).toBe(false);          // user override honored
    expect(m.botProtection.blockProbePaths).toBe(true);   // sibling default preserved
    expect(m.botProtection.rateLimit.limit).toBeGreaterThan(0); // nested object preserved
  });

  it("nested rateLimit partial override preserves the rest", () => {
    const m = mergeWithDefaults({ botProtection: { rateLimit: { limit: 999 } } });
    expect(m.botProtection.rateLimit.limit).toBe(999);
    expect(m.botProtection.rateLimit.windowMs).toBeGreaterThan(0); // preserved
    expect(m.botProtection.rateLimit.enabled).toBe(true);          // preserved
  });

  it("existing flat key override still works (no regression)", () => {
    const m = mergeWithDefaults({ rtkEnabled: false });
    expect(m.rtkEnabled).toBe(false);
    expect(m.cavemanLevel).toBe("full"); // other defaults intact
  });
});
