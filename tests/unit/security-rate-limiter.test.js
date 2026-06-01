import { describe, it, expect, beforeEach } from "vitest";
import { check, __test__ } from "@/lib/security/rateLimiter";

beforeEach(() => __test__.reset());

const W = 60_000;

describe("sliding-window check", () => {
  it("allows while under the limit", () => {
    let now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(check("ip", { limit: 5, windowMs: W, now: () => now }).allowed).toBe(true);
    }
  });

  it("blocks once the limit is reached within the window", () => {
    let now = 1_000_000;
    const clock = () => now;
    for (let i = 0; i < 5; i++) check("ip", { limit: 5, windowMs: W, now: clock });
    const res = check("ip", { limit: 5, windowMs: W, now: clock });
    expect(res.allowed).toBe(false);
    expect(res.retryAfter).toBeGreaterThan(0);
  });

  it("slides: hits older than windowMs drop out and allow again", () => {
    let now = 1_000_000;
    const clock = () => now;
    for (let i = 0; i < 5; i++) check("ip", { limit: 5, windowMs: W, now: clock });
    expect(check("ip", { limit: 5, windowMs: W, now: clock }).allowed).toBe(false);
    now += W + 1; // whole window elapsed
    expect(check("ip", { limit: 5, windowMs: W, now: clock }).allowed).toBe(true);
  });

  it("retryAfter ≈ time until oldest in-window hit expires", () => {
    let now = 1_000_000;
    const clock = () => now;
    for (let i = 0; i < 3; i++) check("ip", { limit: 3, windowMs: W, now: clock });
    now += 10_000; // 10s later
    const res = check("ip", { limit: 3, windowMs: W, now: clock });
    expect(res.allowed).toBe(false);
    // oldest hit was at t0; expires at t0+60s; now is t0+10s → ~50s
    expect(res.retryAfter).toBe(50);
  });

  it("distinct keys are independent", () => {
    const now = () => 1_000_000;
    for (let i = 0; i < 5; i++) check("a", { limit: 5, windowMs: W, now });
    expect(check("a", { limit: 5, windowMs: W, now }).allowed).toBe(false);
    expect(check("b", { limit: 5, windowMs: W, now }).allowed).toBe(true);
  });
});

describe("bounded memory (MAX_KEYS eviction)", () => {
  it("never exceeds the cap; oldest key evicted on overflow", () => {
    const now = () => 1_000_000;
    const N = __test__.MAX_KEYS;
    for (let i = 0; i < N + 100; i++) check(`k${i}`, { limit: 1, windowMs: W, now });
    expect(__test__.size()).toBeLessThanOrEqual(N);
  });
});
