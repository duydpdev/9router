import { describe, it, expect } from "vitest";
import {
  clampPercent,
  toPositiveInt,
  shouldShowChannelWarning,
} from "@/app/(dashboard)/dashboard/endpoint/bot-protection-settings-helpers";

describe("BotProtectionSettings — clampPercent (warnAtPercent input)", () => {
  it("clamps above 100 down to 100", () => {
    expect(clampPercent("150", 80)).toBe(100);
  });
  it("clamps 0 / negative up to 1", () => {
    expect(clampPercent("0", 80)).toBe(1);
    expect(clampPercent("-5", 80)).toBe(1);
  });
  it("passes through an in-range value", () => {
    expect(clampPercent("80", 80)).toBe(80);
    expect(clampPercent("1", 80)).toBe(1);
    expect(clampPercent("100", 80)).toBe(100);
  });
  it("falls back on non-numeric input", () => {
    expect(clampPercent("", 80)).toBe(80);
    expect(clampPercent("abc", 42)).toBe(42);
  });
});

describe("BotProtectionSettings — toPositiveInt (*PerDay / *Hours inputs)", () => {
  it("accepts positive ints", () => {
    expect(toPositiveInt("5000", 1)).toBe(5000);
  });
  it("falls back on zero / negative / non-numeric", () => {
    expect(toPositiveInt("0", 4)).toBe(4);
    expect(toPositiveInt("-1", 4)).toBe(4);
    expect(toPositiveInt("x", 4)).toBe(4);
  });
});

describe("BotProtectionSettings — channel-status warning visibility", () => {
  it("shows warning when budgets ON and notifier has no live channel", () => {
    expect(shouldShowChannelWarning(true, false)).toBe(true);
  });
  it("hides warning when a notifier channel is live", () => {
    expect(shouldShowChannelWarning(true, true)).toBe(false);
  });
  it("hides warning when budgets are OFF (regardless of notifier)", () => {
    expect(shouldShowChannelWarning(false, false)).toBe(false);
    expect(shouldShowChannelWarning(false, true)).toBe(false);
  });
});
