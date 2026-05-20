import { describe, it, expect } from "vitest";
import {
  getEffectiveStatus,
  isHealthyStatus,
  isErrorStatus,
} from "@/shared/utils/get-effective-status.js";

describe("getEffectiveStatus", () => {
  it("needsReauth wins over every other status", () => {
    expect(
      getEffectiveStatus({ needsReauth: true, testStatus: "active" }),
    ).toBe("needs_reauth");
    expect(
      getEffectiveStatus({ needsReauth: true, testStatus: "error" }),
    ).toBe("needs_reauth");
    expect(
      getEffectiveStatus({
        needsReauth: true,
        testStatus: "unavailable",
        modelLock_x: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe("needs_reauth");
  });

  it("active modelLock keeps testStatus when not needsReauth", () => {
    expect(
      getEffectiveStatus({
        testStatus: "unavailable",
        modelLock_x: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe("unavailable");
  });

  it("expired modelLock + unavailable testStatus promotes to active", () => {
    expect(
      getEffectiveStatus({
        testStatus: "unavailable",
        modelLock_x: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).toBe("active");
  });

  it("expired explicit status passes through", () => {
    expect(getEffectiveStatus({ testStatus: "expired" })).toBe("expired");
  });

  it("active passes through", () => {
    expect(getEffectiveStatus({ testStatus: "active" })).toBe("active");
  });

  it("null/undefined returns unknown", () => {
    expect(getEffectiveStatus(null)).toBe("unknown");
    expect(getEffectiveStatus(undefined)).toBe("unknown");
  });
});

describe("isHealthyStatus / isErrorStatus", () => {
  it("active and success are healthy", () => {
    expect(isHealthyStatus("active")).toBe(true);
    expect(isHealthyStatus("success")).toBe(true);
    expect(isHealthyStatus("needs_reauth")).toBe(false);
  });

  it("error / expired / unavailable are error statuses", () => {
    expect(isErrorStatus("error")).toBe(true);
    expect(isErrorStatus("expired")).toBe(true);
    expect(isErrorStatus("unavailable")).toBe(true);
    expect(isErrorStatus("needs_reauth")).toBe(false);
  });
});
