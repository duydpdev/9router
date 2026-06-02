import { describe, it, expect } from "vitest";
import { costFit, isCheapProvider } from "open-sse/services/smartRouter/costFit.js";

describe("isCheapProvider (auth-type tiering)", () => {
  it("OAuth provider (cc → claude) is cheap", () => {
    expect(isCheapProvider("cc/claude-opus-4-6")).toBe(true);
  });

  it("free provider (gc → gemini-cli) is cheap", () => {
    expect(isCheapProvider("gc/gemini-2.5-pro")).toBe(true);
  });

  it("free-tier provider (gemini) is cheap", () => {
    expect(isCheapProvider("gemini/gemini-2.5-flash")).toBe(true);
  });

  it("web-cookie provider (gw → grok-web) is cheap", () => {
    expect(isCheapProvider("gw/grok-4")).toBe(true);
  });

  it("metered API-key provider (openai) is capable, not cheap", () => {
    expect(isCheapProvider("openai/gpt-4o-mini")).toBe(false);
  });

  it("metered API-key provider (glm) is capable", () => {
    expect(isCheapProvider("glm/glm-4.6")).toBe(false);
  });

  it("bare alias / unknown provider → not cheap, no throw", () => {
    expect(isCheapProvider("just-a-model-name")).toBe(false);
    expect(isCheapProvider("")).toBe(false);
    expect(() => isCheapProvider("nonsense/x")).not.toThrow();
  });
});

describe("costFit", () => {
  const models = ["cc/claude-opus-4-6", "openai/gpt-4o-mini"];

  it("simple → cheap tier first", () => {
    const { first, second } = costFit(models, "simple");
    expect(first).toEqual(["cc/claude-opus-4-6"]);
    expect(second).toEqual(["openai/gpt-4o-mini"]);
  });

  it("complex → capable tier first", () => {
    const { first, second } = costFit(models, "complex");
    expect(first).toEqual(["openai/gpt-4o-mini"]);
    expect(second).toEqual(["cc/claude-opus-4-6"]);
  });

  it("preserves original relative order within a tier", () => {
    const m = ["cc/a", "gc/b", "openai/c", "glm/d"];
    const { first, second } = costFit(m, "simple");
    expect(first).toEqual(["cc/a", "gc/b"]); // cheap, original order
    expect(second).toEqual(["openai/c", "glm/d"]); // capable, original order
  });

  it("single-provider-class combo → one tier empty, sane result", () => {
    const { first, second } = costFit(["cc/a", "gc/b"], "simple");
    expect(first).toEqual(["cc/a", "gc/b"]);
    expect(second).toEqual([]);
  });
});
