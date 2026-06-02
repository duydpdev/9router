import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Phase 2: real handler behavior for the 3 read-only control-plane tools.
// Tools are exercised by resolving the registered handler directly (the SDK
// client path is covered by the Phase 5 e2e test).

let createMcpServer, connRepo, usageRepo, server, cleanup;

// Resolve a registered tool handler by name and invoke it like the SDK would.
async function callTool(name, args = {}) {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler(args, {});
}

beforeAll(async () => {
  const { setupIsolatedDb } = await import("../helpers/isolated-db.mjs");
  ({ cleanup } = setupIsolatedDb()); // SYNC: sets DATA_DIR, returns { dir, cleanup }
  const db = await import("@/lib/db/index.js");
  await db.initDb(); // init AFTER DATA_DIR is set
  connRepo = await import("@/lib/db/repos/connectionsRepo.js");
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
  ({ createMcpServer } = await import("@/lib/mcp/server.js"));
  server = createMcpServer();
});

afterAll(() => cleanup?.());

describe("router.list_providers", () => {
  it("returns active connections by default with a valid status", async () => {
    await connRepo.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      email: "a@x.com",
    });
    const res = await callTool("router.list_providers", {});
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    const claude = body.find((c) => c.provider === "claude");
    expect(claude).toMatchObject({ provider: "claude", authType: "oauth", email: "a@x.com" });
    expect(typeof claude.connectionId).toBe("string");
    expect(typeof claude.status).toBe("string");
  });

  it("never leaks credential fields", async () => {
    const res = await callTool("router.list_providers", {});
    const body = JSON.parse(res.content[0].text);
    for (const c of body) {
      expect(c).not.toHaveProperty("accessToken");
      expect(c).not.toHaveProperty("refreshToken");
      expect(c).not.toHaveProperty("apiKey");
    }
  });

  it("rejects invalid input type", async () => {
    const res = await callTool("router.list_providers", { includeInactive: "yes" });
    expect(res.isError).toBe(true);
  });
});

describe("router.get_quota_status", () => {
  it("returns a per-provider array without error", async () => {
    const res = await callTool("router.get_quota_status", {});
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(Array.isArray(body)).toBe(true);
    for (const row of body) {
      expect(typeof row.provider).toBe("string");
      expect(typeof row.dailyTokens).toBe("number");
      expect(typeof row.dailyRequests).toBe("number");
    }
  });

  it("filters by provider when given", async () => {
    const res = await callTool("router.get_quota_status", { provider: "claude" });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    for (const row of body) expect(row.provider).toBe("claude");
  });

  it("rejects invalid input type", async () => {
    const res = await callTool("router.get_quota_status", { provider: 123 });
    expect(res.isError).toBe(true);
  });

  it("surfaces a future rateLimitedUntil as resetAt", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await connRepo.createProviderConnection({
      provider: "ratelimited-prov",
      authType: "apikey",
      name: "rl-key",
      rateLimitedUntil: future,
    });
    // provider must appear in usage stats to be listed; seed one request
    await usageRepo.saveRequestUsage({
      provider: "ratelimited-prov",
      model: "m",
      connectionId: undefined,
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      promptTokens: 1,
      completionTokens: 1,
      status: "ok",
    });
    const res = await callTool("router.get_quota_status", { provider: "ratelimited-prov" });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    const row = body.find((r) => r.provider === "ratelimited-prov");
    // Must appear even though it has no usage today — resetAt is the point.
    expect(row).toBeDefined();
    expect(row.quotaRemaining).toBeNull();
    expect(row.resetAt).toBe(future);
  });
});

describe("router.get_usage_today", () => {
  it("returns totals with tokens + requests", async () => {
    const res = await callTool("router.get_usage_today", {});
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(typeof body.totals.tokens).toBe("number");
    expect(typeof body.totals.requests).toBe("number");
    expect(Array.isArray(body.breakdown)).toBe(true);
  });

  it("supports groupBy=model", async () => {
    const res = await callTool("router.get_usage_today", { groupBy: "model" });
    expect(res.isError).toBeFalsy();
  });

  it("rejects invalid groupBy", async () => {
    const res = await callTool("router.get_usage_today", { groupBy: "galaxy" });
    expect(res.isError).toBe(true);
  });
});
