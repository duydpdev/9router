import { describe, it, expect, beforeEach } from "vitest";
import {
  recordResult,
  healthScore,
  resetHealthState,
  getHealthSnapshot,
  MIN_SAMPLES,
  NEUTRAL,
  WINDOW,
  MAX_TRACKED,
} from "open-sse/services/smartRouter/healthScore.js";

const record = (model, ok, n = 1) => {
  for (let i = 0; i < n; i++) recordResult(model, { ok });
};

describe("healthScore (windowed success-rate)", () => {
  beforeEach(() => resetHealthState());

  it("unseen model → NEUTRAL", () => {
    expect(healthScore("x/never-seen")).toBe(NEUTRAL);
  });

  it("under-sampled (< MIN_SAMPLES) → NEUTRAL", () => {
    record("x/m", true, MIN_SAMPLES - 1);
    expect(healthScore("x/m")).toBe(NEUTRAL);
  });

  it("all-success → 1.0", () => {
    record("x/m", true, MIN_SAMPLES);
    expect(healthScore("x/m")).toBe(1);
  });

  it("all-fail → 0.0", () => {
    record("x/m", false, MIN_SAMPLES);
    expect(healthScore("x/m")).toBe(0);
  });

  it("mixed → exact windowed ratio", () => {
    record("x/m", true, 6);
    record("x/m", false, 4);
    expect(healthScore("x/m")).toBeCloseTo(0.6, 5);
  });

  it("failure burst then WINDOW successes → recovers to 1.0 (bounded, no decay)", () => {
    record("x/m", false, 20);
    expect(healthScore("x/m")).toBe(0);
    record("x/m", true, WINDOW); // full window of good results
    expect(healthScore("x/m")).toBe(1);
  });

  it("window never exceeds WINDOW outcomes (old results roll off)", () => {
    record("x/m", false, WINDOW); // fill with failures
    record("x/m", true, WINDOW); // overwrite all with successes
    expect(healthScore("x/m")).toBe(1);
    const snap = getHealthSnapshot().find((s) => s.model === "x/m");
    expect(snap.count).toBe(WINDOW); // count caps at WINDOW
  });

  it("Map evicts oldest key when exceeding MAX_TRACKED", () => {
    for (let i = 0; i < MAX_TRACKED + 10; i++) record(`m/${i}`, true, MIN_SAMPLES);
    expect(getHealthSnapshot().length).toBe(MAX_TRACKED);
    // earliest keys evicted → back to NEUTRAL
    expect(healthScore("m/0")).toBe(NEUTRAL);
    // most-recent key retained
    expect(healthScore(`m/${MAX_TRACKED + 9}`)).toBe(1);
  });

  it("touching a key refreshes its LRU position (not evicted)", () => {
    for (let i = 0; i < MAX_TRACKED; i++) record(`m/${i}`, true, MIN_SAMPLES);
    record("m/0", true); // touch oldest → moves to MRU
    record("m/new", true, MIN_SAMPLES); // forces one eviction
    expect(healthScore("m/0")).toBe(1); // survived
    expect(healthScore("m/1")).toBe(NEUTRAL); // m/1 evicted instead
  });

  it("score is deterministic with no wall-clock dependency", () => {
    record("x/m", true, 3);
    record("x/m", false, 2);
    const a = healthScore("x/m");
    const b = healthScore("x/m");
    expect(a).toBe(b);
    expect(a).toBeCloseTo(0.6, 5);
  });

  it("resetHealthState(model) clears one; resetHealthState() clears all", () => {
    record("x/a", true, MIN_SAMPLES);
    record("x/b", true, MIN_SAMPLES);
    resetHealthState("x/a");
    expect(healthScore("x/a")).toBe(NEUTRAL);
    expect(healthScore("x/b")).toBe(1);
    resetHealthState();
    expect(healthScore("x/b")).toBe(NEUTRAL);
  });
});
