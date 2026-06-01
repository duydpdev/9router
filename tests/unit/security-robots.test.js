import { describe, it, expect } from "vitest";
import robots from "@/app/robots";

describe("robots metadata route", () => {
  it("disallows private surfaces, allows root", () => {
    const { rules } = robots();
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toBe("/");
    expect(rule.disallow).toContain("/dashboard");
    expect(rule.disallow).toContain("/api");
    expect(rule.disallow).toContain("/login");
  });
});
