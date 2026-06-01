import { describe, it, expect, beforeEach, vi } from "vitest";

// End-to-end through the real route + cache + directive modules; only the
// upstream handler is mocked (raw Response, matching production return shape).
let upstreamCalls = 0;
vi.mock("@/sse/handlers/embeddings.js", () => ({
  handleEmbeddings: vi.fn(async () => {
    upstreamCalls++;
    return new Response(
      JSON.stringify({ object: "list", data: [{ embedding: [0.1] }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }),
}));

import { POST } from "@/app/api/v1/embeddings/route.js";
import { getPromptCache } from "@/sse/services/prompt-cache.js";

const mkReq = (headers, body) =>
  new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("prompt cache e2e (embeddings only)", () => {
  beforeEach(() => {
    upstreamCalls = 0;
    getPromptCache().clear();
    vi.useRealTimers();
  });

  it("1000 identical embeddings → 1 upstream call, 999 hits", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    const body = { model: "m", input: "warm prompt" };
    for (let i = 0; i < 1000; i++) await POST(mkReq(headers, body));
    expect(upstreamCalls).toBe(1);
    expect(getPromptCache().stats().hits).toBe(999);
  });

  it("token-array input → bypass (upstream every call)", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    const body = { model: "m", input: [1, 2, 3, 4] };
    await POST(mkReq(headers, body));
    await POST(mkReq(headers, body));
    expect(upstreamCalls).toBe(2);
  });

  it("input > 100KB → bypass", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    const body = { model: "m", input: "x".repeat(100_001) };
    await POST(mkReq(headers, body));
    await POST(mkReq(headers, body));
    expect(upstreamCalls).toBe(2);
  });

  it("upstream error → not cached", async () => {
    const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
    handleEmbeddings.mockImplementationOnce(async () => {
      upstreamCalls++;
      return new Response("err", { status: 503 });
    });
    const headers = { "x-router-cache": "ttl=300" };
    const body = { model: "m", input: "y" };
    await POST(mkReq(headers, body));
    const r2 = await POST(mkReq(headers, body));
    expect(r2.headers.get("x-router-cache-hit")).toBe("false");
    expect(upstreamCalls).toBe(2);
  });

  it("ttl expiry triggers refetch", async () => {
    vi.useFakeTimers();
    const headers = { "x-router-cache": "ttl=1" };
    const body = { model: "m", input: "expiring" };
    await POST(mkReq(headers, body)); // miss → upstream
    await POST(mkReq(headers, body)); // hit
    expect(upstreamCalls).toBe(1);
    vi.advanceTimersByTime(2000); // past 1s ttl
    await POST(mkReq(headers, body)); // expired → upstream again
    expect(upstreamCalls).toBe(2);
  });
});
