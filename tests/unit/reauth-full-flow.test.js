// End-to-end smoke for the provider auto-reauth flow.
// Stubs upstream OAuth refresh + the warmup notifier transport and walks
// through: Case-B detection → markNeedsReauth → notify → fallback skip →
// OAuth re-exchange with signed state → clearNeedsReauth + back in rotation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeTokens: vi.fn(),
  refreshProjectId: vi.fn(),
}));

vi.mock("@/lib/oauth/providers", async () => {
  const actual = await vi.importActual("@/lib/oauth/providers");
  return { ...actual, exchangeTokens: mocks.exchangeTokens };
});

vi.mock("@/sse/services/tokenRefresh", async () => {
  const actual = await vi.importActual("@/sse/services/tokenRefresh");
  return { ...actual, refreshProjectId: mocks.refreshProjectId };
});

const originalEnv = { ...process.env };
let tempDir;
let webhookRequests = [];

let connectionsRepo;
let reauthState;
let tokenRefresh;
let openSseTokenRefresh;
let auth;
let server;
let routeMod;
let notifierModule;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reauth-e2e-"));
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = "test-secret-for-e2e-state-1234567890abcdefg";
  process.env.PUBLIC_BASE_URL = "https://example.test";

  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  reauthState = await import("@/lib/oauth/reauth-state.js");
  openSseTokenRefresh = await import("open-sse/services/tokenRefresh.js");
  tokenRefresh = await import("@/sse/services/tokenRefresh.js");
  auth = await import("@/sse/services/auth.js");
  server = await import("@/lib/oauth/utils/server.js");
  notifierModule = await import("@/lib/warmup/notifier.js");
  // Configure notifier with a public-looking generic webhook URL so the cfg
  // gate passes; transport itself is stubbed below.
  notifierModule.__resetForTests({ genericUrl: "https://relay.example.test/hooks/reauth" });
  vi.spyOn(notifierModule, "sendGeneric").mockImplementation(async (payload, url) => {
    webhookRequests.push({ url, body: payload });
    return { ok: true, statusCode: 200 };
  });
  routeMod = await import("@/app/api/oauth/[provider]/[action]/route.js");
});

afterAll(async () => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
});

async function seedHealthy(provider = "claude") {
  return connectionsRepo.createProviderConnection({
    provider,
    authType: "oauth",
    email: `seed-${Math.random().toString(36).slice(2, 8)}@x`,
    accessToken: "old-at",
    refreshToken: "old-rt",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    testStatus: "active",
  });
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("provider auto-reauth — end-to-end flow", () => {
  it("walks the full Case-B path: detect → notify → fallback → reconnect", async () => {
    webhookRequests = [];

    const connA = await seedHealthy("claude");
    const connB = await seedHealthy("claude");

    // 1) Simulate Case-B: upstream returns invalid_grant for connA
    const stubGetAccessToken = vi.spyOn(openSseTokenRefresh, "getAccessToken")
      .mockImplementation(async (_provider, creds) => {
        if (creds.connectionId === connA.id) {
          return { error: "refresh_failed", status: 400, body: '{"error":"invalid_grant"}' };
        }
        return null;
      });

    await tokenRefresh.checkAndRefreshToken("claude", {
      connectionId: connA.id,
      connectionName: connA.name,
      email: connA.email,
      authType: "oauth",
      refreshToken: "old-rt",
      accessToken: "old-at",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // 2) DB row for A is flagged
    const aAfter = await connectionsRepo.getProviderConnectionById(connA.id);
    expect(aAfter.needsReauth).toBe(true);
    expect(aAfter.reauthReason).toBe("invalid_grant");

    // 3) Webhook fired exactly once with deep-link
    await waitFor(() => webhookRequests.length >= 1);
    expect(webhookRequests.length).toBe(1);
    expect(webhookRequests[0].body).toMatchObject({ event: "provider.reauth_required", kind: "reauth" });
    expect(webhookRequests[0].body.deepLinkUrl).toContain(`reconnect=${connA.id}`);

    // 4) Repeating the failure → no second webhook (dedup)
    await tokenRefresh.checkAndRefreshToken("claude", {
      connectionId: connA.id,
      authType: "oauth",
      refreshToken: "old-rt",
      accessToken: "old-at",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(webhookRequests.length).toBe(1);

    // 5) Combo fallback skips A → returns B
    const creds = await auth.getProviderCredentials("claude");
    expect(creds?.connectionId).toBe(connB.id);

    // 6) User opens deep-link → OAuth exchange with signed state targeting A
    mocks.exchangeTokens.mockResolvedValue({
      accessToken: "new-fresh-at",
      refreshToken: "new-fresh-rt",
      expiresIn: 3600,
    });
    const signed = server.signOAuthState({ connectionId: connA.id });
    const res = await routeMod.POST(
      { json: async () => ({ code: "abc", redirectUri: "http://x", codeVerifier: "cv", state: signed }) },
      { params: Promise.resolve({ provider: "claude", action: "exchange" }) },
    );
    const json = await res.json();
    expect(json).toMatchObject({ success: true, updated: true });

    // 7) A is back in rotation, needsReauth cleared
    const aFinal = await connectionsRepo.getProviderConnectionById(connA.id);
    expect(aFinal.needsReauth).toBe(false);
    expect(aFinal.accessToken).toBe("new-fresh-at");
    expect(aFinal.reauthReason ?? null).toBeNull();

    // 8) Selection picks A again (priority 1)
    const credsAgain = await auth.getProviderCredentials("claude");
    expect([connA.id, connB.id]).toContain(credsAgain?.connectionId);

    stubGetAccessToken.mockRestore();
  }, 10_000);
});
