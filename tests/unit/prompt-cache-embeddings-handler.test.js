import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the OUTER handler. It returns a RAW Response (see embeddings.js:135 +
// error paths) — NOT { success, response }. Returning the envelope here would
// re-introduce the test/prod divergence red-team finding #15 warns about.
let upstreamCalls = 0;
vi.mock("@/sse/handlers/embeddings.js", () => ({
  handleEmbeddings: vi.fn(async () => {
    upstreamCalls++;
    return new Response(
      JSON.stringify({ object: "list", data: [{ embedding: [0.1, 0.2, 0.3] }] }),
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

describe("embeddings route cache wiring", () => {
  beforeEach(() => {
    upstreamCalls = 0;
    getPromptCache().clear();
  });

  it("no header → no cache touch, upstream every call", async () => {
    const body = { model: "m", input: "hello" };
    await POST(mkReq({}, body));
    await POST(mkReq({}, body));
    expect(upstreamCalls).toBe(2);
  });

  it("same input → second call is a cache hit", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    const body = { model: "text-embedding-3-small", input: ["hello", "world"] };
    const r1 = await POST(mkReq(headers, body));
    const r2 = await POST(mkReq(headers, body));
    expect(r1.headers.get("x-router-cache-hit")).toBe("false");
    expect(r2.headers.get("x-router-cache-hit")).toBe("true");
    expect(upstreamCalls).toBe(1);
    // body identical between miss and hit
    expect(await r1.clone().json()).toEqual(await r2.clone().json());
  });

  it("different input order → cache miss (strict array)", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    await POST(mkReq(headers, { model: "m", input: ["a", "b"] }));
    const r2 = await POST(mkReq(headers, { model: "m", input: ["b", "a"] }));
    expect(r2.headers.get("x-router-cache-hit")).toBe("false");
    expect(upstreamCalls).toBe(2);
  });

  it("different encoding_format → cache miss", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    await POST(mkReq(headers, { model: "m", input: "x", encoding_format: "float" }));
    const r = await POST(mkReq(headers, { model: "m", input: "x", encoding_format: "base64" }));
    expect(r.headers.get("x-router-cache-hit")).toBe("false");
  });

  it("tokenized input → bypass, no cache", async () => {
    const headers = { "x-router-cache": "ttl=300" };
    const body = { model: "m", input: [1, 2, 3] };
    await POST(mkReq(headers, body));
    await POST(mkReq(headers, body));
    expect(upstreamCalls).toBe(2);
  });

  it("upstream non-200 → not cached", async () => {
    const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
    handleEmbeddings.mockImplementationOnce(async () => {
      upstreamCalls++;
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    });
    const headers = { "x-router-cache": "ttl=300" };
    const body = { model: "m", input: "x" };
    const r1 = await POST(mkReq(headers, body));
    expect(r1.status).toBe(500);
    const r2 = await POST(mkReq(headers, body));
    expect(r2.headers.get("x-router-cache-hit")).toBe("false");
    expect(upstreamCalls).toBe(2);
  });
});
