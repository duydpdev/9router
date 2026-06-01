import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PromptCache, hashKey, getPromptCache } from "@/sse/services/prompt-cache.js";

describe("PromptCache foundation", () => {
  it("get on missing key returns null", () => {
    expect(new PromptCache({ maxBytes: 1000 }).get("nope")).toBeNull();
  });

  it("set then get returns body", () => {
    const c = new PromptCache({ maxBytes: 1000 });
    c.set("k", { hello: "world" }, 60);
    expect(c.get("k")).toEqual({ hello: "world" });
  });

  it("get returns a clone, not the stored reference (no caller mutation)", () => {
    const c = new PromptCache({ maxBytes: 1000 });
    c.set("k", { nested: { v: 1 } }, 60);
    const first = c.get("k");
    first.nested.v = 999;
    expect(c.get("k")).toEqual({ nested: { v: 1 } });
  });

  it("stats track hits/misses", () => {
    const c = new PromptCache({ maxBytes: 1000 });
    c.set("k", { x: 1 }, 60);
    c.get("k");
    c.get("k");
    c.get("missing");
    expect(c.stats()).toMatchObject({ hits: 2, misses: 1 });
  });

  it("clear() empties entries, bytes, and stats", () => {
    const c = new PromptCache({ maxBytes: 1000 });
    c.set("k", { x: 1 }, 60);
    c.get("k");
    c.clear();
    expect(c.get("k")).toBeNull();
    const s = c.stats();
    expect(s.entryCount).toBe(0);
    expect(s.currentBytes).toBe(0);
    expect(s.hits).toBe(0);
  });
});

describe("hashKey stability + sensitivity", () => {
  const base = { model: "claude-3", input: "hi", temperature: 0 };

  it("identical params → identical hash", () => {
    expect(hashKey(base)).toBe(hashKey({ ...base }));
  });

  it("undefined vs missing field treated same", () => {
    expect(hashKey({ model: "m", input: "x" })).toBe(
      hashKey({ model: "m", input: "x", dimensions: undefined }),
    );
  });

  it("different model → different hash", () => {
    expect(hashKey(base)).not.toBe(hashKey({ ...base, model: "gpt-4" }));
  });

  it("different input → different hash", () => {
    expect(hashKey(base)).not.toBe(hashKey({ ...base, input: "bye" }));
  });

  it("different encoding_format → different hash", () => {
    expect(hashKey({ model: "m", input: "x", encoding_format: "float" })).not.toBe(
      hashKey({ model: "m", input: "x", encoding_format: "base64" }),
    );
  });

  it("different dimensions → different hash", () => {
    expect(hashKey({ model: "m", input: "x", dimensions: 256 })).not.toBe(
      hashKey({ model: "m", input: "x", dimensions: 512 }),
    );
  });

  it("provider field changes hash", () => {
    expect(hashKey({ model: "m", input: "x", provider: "a" })).not.toBe(
      hashKey({ model: "m", input: "x", provider: "b" }),
    );
  });

  it("returns 64-char hex (sha256)", () => {
    expect(hashKey(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("LRU eviction", () => {
  it("evicts least-recently-used when over byte budget", () => {
    // each entry serializes to {"v":"<40 chars>"} = 48 bytes; budget fits 2.
    const c = new PromptCache({ maxBytes: 100 });
    c.set("a", { v: "x".repeat(40) }, 60); // 48 bytes
    c.set("b", { v: "y".repeat(40) }, 60); // 96 bytes
    c.set("c", { v: "z".repeat(40) }, 60); // pushes over → evict oldest "a"
    expect(c.get("a")).toBeNull();
    expect(c.get("b")).not.toBeNull();
    expect(c.get("c")).not.toBeNull();
    expect(c.stats().evictions).toBeGreaterThan(0);
  });

  it("get() promotes entry so it survives next eviction", () => {
    const c = new PromptCache({ maxBytes: 100 });
    c.set("a", { v: "x".repeat(40) }, 60);
    c.set("b", { v: "y".repeat(40) }, 60);
    c.get("a"); // promote a → b now oldest
    c.set("c", { v: "z".repeat(40) }, 60);
    expect(c.get("a")).not.toBeNull();
    expect(c.get("b")).toBeNull();
  });

  it("single entry larger than budget is skipped, never cached, no infinite loop", () => {
    const c = new PromptCache({ maxBytes: 50 });
    c.set("big", { v: "x".repeat(1000) }, 60);
    expect(c.get("big")).toBeNull();
    expect(c.stats().entryCount).toBe(0);
    expect(c.stats().currentBytes).toBe(0);
  });
});

describe("TTL lazy expiry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns body before TTL elapses", () => {
    const c = new PromptCache({ maxBytes: 1000 });
    c.set("k", { v: 1 }, 60);
    vi.advanceTimersByTime(59_000);
    expect(c.get("k")).not.toBeNull();
  });

  it("returns null after TTL elapses, increments expirations + frees bytes", () => {
    const c = new PromptCache({ maxBytes: 1000 });
    c.set("k", { v: 1 }, 60);
    vi.advanceTimersByTime(61_000);
    expect(c.get("k")).toBeNull();
    expect(c.stats().expirations).toBeGreaterThan(0);
    expect(c.stats().currentBytes).toBe(0);
  });
});

describe("singleton", () => {
  it("getPromptCache() returns the same instance", () => {
    expect(getPromptCache()).toBe(getPromptCache());
  });
});
