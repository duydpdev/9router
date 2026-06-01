import { describe, it, expect } from "vitest";
import { isStaticAsset, classifyRequest } from "@/lib/security/botRules";

const ALL_ON = { blockProbePaths: true, blockBadUA: true, blockAiCrawlers: true };

describe("isStaticAsset", () => {
  it("true for asset extensions and sw.js", () => {
    expect(isStaticAsset("/providers/foo.png")).toBe(true);
    expect(isStaticAsset("/styles/app.css")).toBe(true);
    expect(isStaticAsset("/fonts/x.woff2")).toBe(true);
    expect(isStaticAsset("/sw.js")).toBe(true);
  });

  it("false for .json, page routes, and api paths", () => {
    expect(isStaticAsset("/config.json")).toBe(false);
    expect(isStaticAsset("/dashboard")).toBe(false);
    expect(isStaticAsset("/v1/chat/completions")).toBe(false);
  });
});

describe("classifyRequest — probe paths", () => {
  it("blocks anchored probe path when enabled", () => {
    expect(classifyRequest({ pathname: "/.env", userAgent: "Mozilla", opts: ALL_ON }))
      .toMatchObject({ block: true, kind: "probe" });
    expect(classifyRequest({ pathname: "/wp-login.php", userAgent: "Mozilla", opts: ALL_ON }).block).toBe(true);
  });

  it("over-match guard: /api/vendors does NOT match /vendor", () => {
    expect(classifyRequest({ pathname: "/api/vendors", userAgent: "Mozilla", opts: ALL_ON }).block).toBe(false);
  });

  it("/config.json is not a probe (removed)", () => {
    expect(classifyRequest({ pathname: "/config.json", userAgent: "Mozilla", opts: ALL_ON }).block).toBe(false);
  });

  it("does not block probe when toggle off", () => {
    expect(classifyRequest({ pathname: "/.env", userAgent: "Mozilla", opts: { ...ALL_ON, blockProbePaths: false } }).block).toBe(false);
  });
});

describe("classifyRequest — bad UA", () => {
  it("blocks empty/missing UA when enabled", () => {
    expect(classifyRequest({ pathname: "/", userAgent: "", opts: ALL_ON }))
      .toMatchObject({ block: true, kind: "bad-ua" });
    expect(classifyRequest({ pathname: "/", userAgent: null, opts: ALL_ON }).kind).toBe("bad-ua");
  });

  it("blocks known scanner UAs", () => {
    expect(classifyRequest({ pathname: "/", userAgent: "sqlmap/1.7", opts: ALL_ON }).kind).toBe("bad-ua");
    expect(classifyRequest({ pathname: "/", userAgent: "Nikto/2.1", opts: ALL_ON }).kind).toBe("bad-ua");
  });

  it("does NOT block generic clients (curl, python-requests)", () => {
    expect(classifyRequest({ pathname: "/", userAgent: "curl/8.4.0", opts: ALL_ON }).block).toBe(false);
    expect(classifyRequest({ pathname: "/", userAgent: "python-requests/2.31", opts: ALL_ON }).block).toBe(false);
  });
});

describe("classifyRequest — AI crawlers", () => {
  it("blocks AI crawler UA when enabled, passes when off", () => {
    expect(classifyRequest({ pathname: "/", userAgent: "GPTBot/1.0", opts: ALL_ON }).kind).toBe("ai-crawler");
    expect(classifyRequest({ pathname: "/", userAgent: "GPTBot/1.0", opts: { ...ALL_ON, blockAiCrawlers: false } }).block).toBe(false);
  });
});

describe("classifyRequest — all toggles off never blocks", () => {
  it("returns block:false for probe + bad-ua + crawler", () => {
    const off = { blockProbePaths: false, blockBadUA: false, blockAiCrawlers: false };
    expect(classifyRequest({ pathname: "/.env", userAgent: "sqlmap", opts: off }).block).toBe(false);
    expect(classifyRequest({ pathname: "/", userAgent: "GPTBot", opts: off }).block).toBe(false);
  });
});
