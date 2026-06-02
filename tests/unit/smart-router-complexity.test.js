import { describe, it, expect } from "vitest";
import {
  classifyComplexity,
  extractLastUserText,
  SCAN_CHAR_CAP,
  DEFAULT_THRESHOLD,
} from "open-sse/services/smartRouter/complexity.js";

describe("classifyComplexity", () => {
  it("short plain prompt → simple", () => {
    const body = { messages: [{ role: "user", content: "hi there" }] };
    expect(classifyComplexity(body)).toBe("simple");
  });

  it("request carrying tools → complex", () => {
    const body = {
      messages: [{ role: "user", content: "ok" }],
      tools: [{ type: "function", function: { name: "f" } }],
    };
    expect(classifyComplexity(body)).toBe("complex");
  });

  it("code fence in last user message → complex", () => {
    const body = { messages: [{ role: "user", content: "fix this ```js\nx=1\n```" }] };
    expect(classifyComplexity(body)).toBe("complex");
  });

  it("very long prompt (> threshold tokens) → complex", () => {
    const long = "word ".repeat(2000); // ~10k chars → ~2500 approx tokens > 1500
    const body = { messages: [{ role: "user", content: long }] };
    expect(classifyComplexity(body)).toBe("complex");
  });

  it("body.input[] (Responses API) is read, not silently simple", () => {
    const body = {
      input: [{ role: "user", content: [{ type: "text", text: "build a class with import => fn" }] }],
    };
    // contains code signals → complex; proves input[] was extracted
    expect(classifyComplexity(body)).toBe("complex");
  });

  it("body.input as bare string is read", () => {
    const body = { input: "function foo() {}" };
    expect(classifyComplexity(body)).toBe("complex");
  });

  it("Gemini contents shape is read", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "class Foo {}" }] }] };
    expect(classifyComplexity(body)).toBe("complex");
  });

  it("invalid threshold (0, NaN, string) clamps to default — does not flip to simple", () => {
    const long = "x".repeat((DEFAULT_THRESHOLD + 500) * 4); // > default token cutoff
    const body = { messages: [{ role: "user", content: long }] };
    expect(classifyComplexity(body, 0)).toBe("complex");
    expect(classifyComplexity(body, NaN)).toBe("complex");
    expect(classifyComplexity(body, "x")).toBe("complex");
  });

  it("empty / unknown body shape → complex (safe default)", () => {
    expect(classifyComplexity({})).toBe("complex");
    expect(classifyComplexity(null)).toBe("complex");
    expect(classifyComplexity({ weird: true })).toBe("complex");
  });

  it("oversized last message is scanned bounded (<= SCAN_CHAR_CAP)", () => {
    const huge = "a".repeat(SCAN_CHAR_CAP * 4); // 4x the cap
    const extracted = extractLastUserText({ messages: [{ role: "user", content: huge }] });
    // Extraction is bounded at the source — never materializes more than the cap
    // (DoS guard: combo requests can carry MB of context).
    expect(extracted.length).toBeLessThanOrEqual(SCAN_CHAR_CAP);
    expect(classifyComplexity({ messages: [{ role: "user", content: huge }] })).toBe("complex");
  });

  it("array-content with many parts is bounded during concatenation", () => {
    const parts = Array.from({ length: 10000 }, () => ({ type: "text", text: "abc " }));
    const extracted = extractLastUserText({ messages: [{ role: "user", content: parts }] });
    expect(extracted.length).toBeLessThanOrEqual(SCAN_CHAR_CAP); // breaks early, no full join
  });

  it("extracts only the LAST user turn, not full history", () => {
    const body = {
      messages: [
        { role: "user", content: "first turn with class keyword" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "thanks" },
      ],
    };
    expect(extractLastUserText(body)).toBe("thanks");
    expect(classifyComplexity(body)).toBe("simple"); // last turn is short + clean
  });
});
