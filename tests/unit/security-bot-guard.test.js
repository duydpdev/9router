import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Mocks: isolate botGuard from DB + auth + filesystem audit ---
let SETTINGS;
let VALID_KEYS;
let AUTHED;
let LOOPBACK;

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init.status ?? 200,
      body,
      headers: { get: (k) => (init.headers || {})[k] ?? null },
    }),
  },
}));

let GET_SETTINGS_THROWS = false;
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => {
    if (GET_SETTINGS_THROWS) throw new Error("SQLITE_BUSY");
    return { botProtection: SETTINGS };
  },
  validateApiKey: async (k) => VALID_KEYS.has(k),
}));

vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: () => LOOPBACK,
  hasValidCliToken: async () => false,
  isAuthenticated: async () => AUTHED,
  isPublicLlmApi: (p) => p.startsWith("/v1"),
  extractApiKey: (req) => {
    const a = req.headers.get("authorization");
    if (a?.startsWith("Bearer ")) return a.slice(7);
    return req.headers.get("x-api-key");
  },
}));

const auditCalls = [];
vi.mock("@/lib/security/auditLog", () => ({
  logBlocked: (e) => auditCalls.push(e),
}));

const { botGuard, __test__ } = await import("@/lib/security/botGuard");
const { __test__: rl } = await import("@/lib/security/rateLimiter");

function req({ path = "/", method = "GET", ua = "Mozilla", headers = {} } = {}) {
  const h = { "user-agent": ua, ...headers };
  const low = {};
  for (const [k, v] of Object.entries(h)) low[k.toLowerCase()] = v;
  return { nextUrl: { pathname: path }, method, headers: { get: (k) => low[k.toLowerCase()] ?? null } };
}

function defaults() {
  return {
    enabled: true,
    trustProxy: true,
    blockProbePaths: true,
    blockBadUA: true,
    blockAiCrawlers: true,
    rateLimit: { enabled: true, limit: 300, windowMs: 60000 },
    llmRateLimit: { enabled: true, limit: 3, windowMs: 60000, keyLimit: 100, keyWindowMs: 60000 },
  };
}

beforeEach(() => {
  SETTINGS = defaults();
  VALID_KEYS = new Set(["good-key"]);
  AUTHED = false;
  LOOPBACK = false;
  GET_SETTINGS_THROWS = false;
  auditCalls.length = 0;
  __test__.resetCache();
  rl.reset();
});

describe("botGuard fail-open", () => {
  it("DB/settings error → pass through (null), never throws", async () => {
    GET_SETTINGS_THROWS = true;
    await expect(botGuard(req({ path: "/.env" }))).resolves.toBeNull();
  });
});

describe("botGuard exemptions", () => {
  it("static asset passes without rate counting", async () => {
    expect(await botGuard(req({ path: "/providers/x.png" }))).toBeNull();
  });

  it("OPTIONS preflight passes", async () => {
    expect(await botGuard(req({ method: "OPTIONS", path: "/v1/chat" }))).toBeNull();
  });

  it("disabled setting passes", async () => {
    SETTINGS.enabled = false;
    expect(await botGuard(req({ path: "/.env" }))).toBeNull();
  });

  it("loopback passes even for probe path", async () => {
    LOOPBACK = true;
    expect(await botGuard(req({ path: "/.env" }))).toBeNull();
  });
});

describe("botGuard blocks", () => {
  it("probe path → 403 + audit", async () => {
    const res = await botGuard(req({ path: "/.env" }));
    expect(res.status).toBe(403);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].kind).toBe("probe");
  });

  it("bad-UA no key → 403; with valid key → pass", async () => {
    expect((await botGuard(req({ path: "/dashboard", ua: "sqlmap" }))).status).toBe(403);
    auditCalls.length = 0;
    const ok = await botGuard(req({ path: "/dashboard", ua: "sqlmap", headers: { authorization: "Bearer good-key" } }));
    expect(ok).toBeNull();
  });

  it("ai-crawler → 403; toggle off → pass", async () => {
    expect((await botGuard(req({ ua: "GPTBot/1.0" }))).status).toBe(403);
    SETTINGS.blockAiCrawlers = false;
    __test__.resetCache();
    expect(await botGuard(req({ ua: "GPTBot/1.0" }))).toBeNull();
  });
});

describe("botGuard rate limiting", () => {
  it("/v1 keyless trips at limit with 429 + Retry-After + SSE envelope", async () => {
    let res;
    for (let i = 0; i < 4; i++) res = await botGuard(req({ path: "/v1/chat" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("/v1 per-key bucket independent from another key", async () => {
    VALID_KEYS = new Set(["k1", "k2"]);
    SETTINGS.llmRateLimit.keyLimit = 2;
    __test__.resetCache();
    const k1 = { authorization: "Bearer k1" };
    const k2 = { authorization: "Bearer k2" };
    await botGuard(req({ path: "/v1/x", headers: k1 }));
    await botGuard(req({ path: "/v1/x", headers: k1 }));
    expect((await botGuard(req({ path: "/v1/x", headers: k1 }))).status).toBe(429); // k1 exhausted
    expect(await botGuard(req({ path: "/v1/x", headers: k2 }))).toBeNull();          // k2 fresh
  });

  it("authed browser exempt from global limit", async () => {
    AUTHED = true;
    SETTINGS.rateLimit.limit = 1;
    __test__.resetCache();
    for (let i = 0; i < 5; i++) {
      expect(await botGuard(req({ path: "/dashboard" }))).toBeNull();
    }
  });
});
