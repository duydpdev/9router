import { describe, it, expect } from "vitest";
import { parseCacheDirective, isTokenInput } from "@/sse/services/cache-directive.js";

// Production uses the Web Headers object (case-insensitive). Tests must too —
// using a plain Map would mask case-sensitivity bugs (red-team finding #15).
const mkReq = (headers = {}) => ({ headers: new Headers(headers) });
const mkBody = (over = {}) => ({ model: "text-embedding-3-small", input: "hello", ...over });

describe("parseCacheDirective — header parsing (embeddings)", () => {
  it("no header → disabled", () => {
    const d = parseCacheDirective(mkReq(), mkBody(), "embeddings");
    expect(d.enabled).toBe(false);
  });

  it("ttl=300 → enabled, ttl=300", () => {
    const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=300" }), mkBody(), "embeddings");
    expect(d).toMatchObject({ enabled: true, ttl: 300 });
  });

  it("case-insensitive header name (X-Router-Cache)", () => {
    const d = parseCacheDirective(mkReq({ "X-Router-Cache": "ttl=300" }), mkBody(), "embeddings");
    expect(d.enabled).toBe(true);
  });

  it("no-store → disabled even with ttl", () => {
    const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=300, no-store" }), mkBody(), "embeddings");
    expect(d.enabled).toBe(false);
    expect(d.bypassReason).toBe("explicit_no_store");
  });

  it("ttl=foo → disabled (malformed)", () => {
    const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=foo" }), mkBody(), "embeddings");
    expect(d.enabled).toBe(false);
  });

  it("ttl clamped to 86400 max", () => {
    const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=999999" }), mkBody(), "embeddings");
    expect(d.ttl).toBeLessThanOrEqual(86400);
    expect(d.enabled).toBe(true);
  });

  it("ttl=0 → disabled (must be >= 1)", () => {
    const d = parseCacheDirective(mkReq({ "x-router-cache": "ttl=0" }), mkBody(), "embeddings");
    expect(d.enabled).toBe(false);
  });
});

describe("parseCacheDirective — embeddings input bypass", () => {
  it("tokenized input number[] → bypass", () => {
    const d = parseCacheDirective(
      mkReq({ "x-router-cache": "ttl=300" }),
      mkBody({ input: [1, 2, 3] }),
      "embeddings",
    );
    expect(d.enabled).toBe(false);
    expect(d.bypassReason).toBe("tokenized_input");
  });

  it("tokenized input number[][] → bypass", () => {
    const d = parseCacheDirective(
      mkReq({ "x-router-cache": "ttl=300" }),
      mkBody({ input: [[1, 2], [3, 4]] }),
      "embeddings",
    );
    expect(d.enabled).toBe(false);
    expect(d.bypassReason).toBe("tokenized_input");
  });

  it("string[] input (normal) → enabled", () => {
    const d = parseCacheDirective(
      mkReq({ "x-router-cache": "ttl=300" }),
      mkBody({ input: ["a", "b"] }),
      "embeddings",
    );
    expect(d.enabled).toBe(true);
  });

  it("oversize input > 100KB → bypass", () => {
    const d = parseCacheDirective(
      mkReq({ "x-router-cache": "ttl=300" }),
      mkBody({ input: "x".repeat(100_001) }),
      "embeddings",
    );
    expect(d.enabled).toBe(false);
    expect(d.bypassReason).toBe("oversize_input");
  });
});

describe("isTokenInput", () => {
  it("number[] → true", () => expect(isTokenInput([1, 2, 3])).toBe(true));
  it("number[][] → true", () => expect(isTokenInput([[1, 2]])).toBe(true));
  it("string → false", () => expect(isTokenInput("hello")).toBe(false));
  it("string[] → false", () => expect(isTokenInput(["a", "b"])).toBe(false));
  it("empty array → false", () => expect(isTokenInput([])).toBe(false));
});
