import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeTokens: vi.fn(),
  generateAuthData: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
  refreshProjectId: vi.fn(),
}));

vi.mock("@/lib/oauth/providers", async () => {
  const actual = await vi.importActual("@/lib/oauth/providers");
  return {
    ...actual,
    exchangeTokens: mocks.exchangeTokens,
    generateAuthData: mocks.generateAuthData,
    requestDeviceCode: mocks.requestDeviceCode,
    pollForToken: mocks.pollForToken,
  };
});

vi.mock("@/sse/services/tokenRefresh", async () => {
  const actual = await vi.importActual("@/sse/services/tokenRefresh");
  return { ...actual, refreshProjectId: mocks.refreshProjectId };
});

const originalEnv = { ...process.env };
let tempDir;
let connectionsRepo;
let reauthState;
let routeMod;
let server;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-oauth-callback-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-secret-for-oauth-state-tests-1234567890ab";
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  reauthState = await import("@/lib/oauth/reauth-state.js");
  server = await import("@/lib/oauth/utils/server.js");
  routeMod = await import("@/app/api/oauth/[provider]/[action]/route.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exchangeTokens.mockResolvedValue({
    accessToken: "new-at",
    refreshToken: "new-rt",
    expiresIn: 3600,
  });
});

async function seedReauth(provider = "claude") {
  const conn = await connectionsRepo.createProviderConnection({
    provider,
    authType: "oauth",
    email: `seed-${Math.random().toString(36).slice(2, 8)}@x`,
    accessToken: "old-at",
    refreshToken: "old-rt",
  });
  await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant" });
  return connectionsRepo.getProviderConnectionById(conn.id);
}

function makePostRequest(body) {
  return {
    json: async () => body,
  };
}

describe("POST /api/oauth/[provider]/exchange — reauth flow", () => {
  it("updates the existing row when signed state carries the connectionId", async () => {
    const conn = await seedReauth();
    const state = server.signOAuthState({ connectionId: conn.id });
    const res = await routeMod.POST(
      makePostRequest({ code: "abc", redirectUri: "http://x", codeVerifier: "cv", state }),
      { params: Promise.resolve({ provider: "claude", action: "exchange" }) },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true, updated: true });
    expect(json.connection.id).toBe(conn.id);

    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.accessToken).toBe("new-at");
    expect(fresh.refreshToken).toBe("new-rt");
    expect(fresh.needsReauth).toBe(false);
    expect(fresh.reauthReason ?? null).toBeNull();
    expect(fresh.lastErrorType ?? null).toBeNull();
  });

  it("creates a new row when state has no signed connectionId (back-compat)", async () => {
    const before = await connectionsRepo.getProviderConnections({ provider: "claude" });
    const beforeCount = before.length;
    const res = await routeMod.POST(
      makePostRequest({ code: "abc", redirectUri: "http://x", codeVerifier: "cv", state: "random-unsigned-state" }),
      { params: Promise.resolve({ provider: "claude", action: "exchange" }) },
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.updated).toBeUndefined();
    const after = await connectionsRepo.getProviderConnections({ provider: "claude" });
    expect(after.length).toBe(beforeCount + 1);
  });

  it("returns 404 when signed connectionId no longer exists (D-V2)", async () => {
    const state = server.signOAuthState({ connectionId: "does-not-exist" });
    const res = await routeMod.POST(
      makePostRequest({ code: "abc", redirectUri: "http://x", codeVerifier: "cv", state }),
      { params: Promise.resolve({ provider: "claude", action: "exchange" }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("connection not found");
  });

  it("returns 400 when state's connectionId belongs to a different provider", async () => {
    const conn = await seedReauth("claude");
    const state = server.signOAuthState({ connectionId: conn.id });
    const res = await routeMod.POST(
      makePostRequest({ code: "abc", redirectUri: "http://x", codeVerifier: "cv", state }),
      { params: Promise.resolve({ provider: "github", action: "exchange" }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("provider mismatch");
  });

  it("calls refreshProjectId for antigravity reauth", async () => {
    const conn = await seedReauth("antigravity");
    const state = server.signOAuthState({ connectionId: conn.id });
    await routeMod.POST(
      makePostRequest({ code: "abc", redirectUri: "http://x", codeVerifier: "cv", state }),
      { params: Promise.resolve({ provider: "antigravity", action: "exchange" }) },
    );
    expect(mocks.refreshProjectId).toHaveBeenCalledWith("antigravity", conn.id, "new-at");
  });
});

describe("signOAuthState / verifyOAuthState", () => {
  it("round-trips connectionId via HMAC", () => {
    const s = server.signOAuthState({ connectionId: "abc-123" });
    const v = server.verifyOAuthState(s);
    expect(v?.connectionId).toBe("abc-123");
  });

  it("rejects a forged signature", () => {
    const s = server.signOAuthState({ connectionId: "abc-123" });
    const tampered = s.slice(0, -4) + "AAAA";
    expect(server.verifyOAuthState(tampered)).toBeNull();
  });

  it("rejects an expired state", async () => {
    const s = server.signOAuthState({ connectionId: "abc-123" });
    // any negative max-age is unconditionally expired
    expect(server.verifyOAuthState(s, { maxAgeMs: -1 })).toBeNull();
  });

  it("returns null for malformed inputs", () => {
    expect(server.verifyOAuthState(null)).toBeNull();
    expect(server.verifyOAuthState("no-dot")).toBeNull();
    expect(server.verifyOAuthState("")).toBeNull();
  });
});
