import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const originalEnv = { ...process.env };
let tempDir;
let connectionsRepo;
let reauthState;
let tokenRefresh;
let openSseTokenRefresh;
let reauthAlertModule;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-token-refresh-fatal-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  reauthState = await import("@/lib/oauth/reauth-state.js");
  reauthAlertModule = await import("@/lib/notifier/reauth-alert.js");
  openSseTokenRefresh = await import("open-sse/services/tokenRefresh.js");
  tokenRefresh = await import("@/sse/services/tokenRefresh.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
});

async function seedConn() {
  return connectionsRepo.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: `seed-${Math.random().toString(36).slice(2, 8)}@x`,
    accessToken: "old-at",
    refreshToken: "old-rt",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("checkAndRefreshToken → handleFatalRefresh path", () => {
  it("Codex { error: unrecoverable_refresh_error, code: refresh_token_reused } → markNeedsReauth(refresh_family_revoked)", async () => {
    const conn = await seedConn();
    vi.spyOn(openSseTokenRefresh, "getAccessToken").mockResolvedValue({
      error: "unrecoverable_refresh_error",
      code: "refresh_token_reused",
    });
    const notify = vi.spyOn(reauthAlertModule, "notifyReauthRequired").mockResolvedValue({ notified: true });

    const result = await tokenRefresh.checkAndRefreshToken("claude", {
      connectionId: conn.id,
      connectionName: conn.name,
      email: conn.email,
      authType: "oauth",
      refreshToken: "old-rt",
      accessToken: "old-at",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(result.accessToken).toBe("old-at"); // unchanged
    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.needsReauth).toBe(true);
    expect(fresh.reauthReason).toBe("refresh_family_revoked");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("refactored primitive returns { error: refresh_failed, body: invalid_grant } → invalid_grant", async () => {
    const conn = await seedConn();
    vi.spyOn(openSseTokenRefresh, "getAccessToken").mockResolvedValue({
      error: "refresh_failed",
      status: 400,
      body: '{"error":"invalid_grant","error_description":"refresh token revoked"}',
    });
    const notify = vi.spyOn(reauthAlertModule, "notifyReauthRequired").mockResolvedValue({ notified: true });

    await tokenRefresh.checkAndRefreshToken("claude", {
      connectionId: conn.id,
      authType: "oauth",
      refreshToken: "old-rt",
      accessToken: "old-at",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.needsReauth).toBe(true);
    expect(fresh.reauthReason).toBe("invalid_grant");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("getAccessToken throws transient error (ECONNRESET) → no needsReauth, returns original creds", async () => {
    const conn = await seedConn();
    vi.spyOn(openSseTokenRefresh, "getAccessToken").mockRejectedValue(new Error("ECONNRESET"));
    const notify = vi.spyOn(reauthAlertModule, "notifyReauthRequired").mockResolvedValue({ notified: true });

    const result = await tokenRefresh.checkAndRefreshToken("claude", {
      connectionId: conn.id,
      authType: "oauth",
      refreshToken: "old-rt",
      accessToken: "old-at",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(result.accessToken).toBe("old-at");
    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.needsReauth ?? false).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("refactored primitive body 'temporarily_unavailable' → transient → no needsReauth", async () => {
    const conn = await seedConn();
    vi.spyOn(openSseTokenRefresh, "getAccessToken").mockResolvedValue({
      error: "refresh_failed",
      status: 400,
      body: '{"error":"temporarily_unavailable"}',
    });
    const notify = vi.spyOn(reauthAlertModule, "notifyReauthRequired").mockResolvedValue({ notified: true });

    await tokenRefresh.checkAndRefreshToken("claude", {
      connectionId: conn.id,
      authType: "oauth",
      refreshToken: "old-rt",
      accessToken: "old-at",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.needsReauth ?? false).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifier rejection does not throw to caller (fire-and-forget bounded)", async () => {
    const conn = await seedConn();
    vi.spyOn(openSseTokenRefresh, "getAccessToken").mockResolvedValue({ error: "invalid_grant" });
    vi.spyOn(reauthAlertModule, "notifyReauthRequired").mockRejectedValue(new Error("webhook 500"));

    const result = await tokenRefresh.checkAndRefreshToken("claude", {
      connectionId: conn.id,
      authType: "oauth",
      refreshToken: "old-rt",
      accessToken: "old-at",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(result.accessToken).toBe("old-at");
    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.needsReauth).toBe(true);
  });
});
