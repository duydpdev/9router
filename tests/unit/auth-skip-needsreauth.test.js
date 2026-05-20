import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let connectionsRepo;
let auth;
let reauthState;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-auth-skip-reauth-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  reauthState = await import("@/lib/oauth/reauth-state.js");
  auth = await import("@/sse/services/auth.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function seed({ needsReauth = false, reason } = {}) {
  const conn = await connectionsRepo.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: `seed-${Math.random().toString(36).slice(2, 8)}@x`,
    accessToken: "at",
    refreshToken: "rt",
  });
  if (needsReauth) {
    await reauthState.markNeedsReauth(conn.id, { reason: reason ?? "invalid_grant" });
  }
  return conn.id;
}

async function deleteAll() {
  await connectionsRepo.deleteProviderConnectionsByProvider("claude");
}

describe("getProviderCredentials — skip needsReauth", () => {
  it("returns the healthy connection when another is needsReauth=true", async () => {
    await deleteAll();
    const reauthId = await seed({ needsReauth: true });
    const healthyId = await seed();
    const creds = await auth.getProviderCredentials("claude");
    expect(creds?.connectionId).toBe(healthyId);
    expect(creds?.connectionId).not.toBe(reauthId);
  });

  it("returns allNeedReauth:true when ALL connections need reauth", async () => {
    await deleteAll();
    await seed({ needsReauth: true });
    await seed({ needsReauth: true });
    const result = await auth.getProviderCredentials("claude");
    expect(result).toMatchObject({ allNeedReauth: true });
    expect(result.lastError).toContain("Reconnect");
  });

  it("returns null (not allNeedReauth) when there are NO active connections", async () => {
    await deleteAll();
    const result = await auth.getProviderCredentials("claude");
    expect(result).toBeNull();
  });

  it("does NOT classify allNeedReauth when excludeSet covers a healthy connection", async () => {
    await deleteAll();
    const reauthId = await seed({ needsReauth: true });
    const healthyId = await seed();
    // exclude the healthy → only reauth one remains eligible → allNeedReauth
    const result = await auth.getProviderCredentials("claude", new Set([healthyId]));
    expect(result).toMatchObject({ allNeedReauth: true });
    expect(reauthId).toBeTruthy();
  });

  it("excludeSet covers the reauth one → returns healthy connection (no allNeedReauth)", async () => {
    await deleteAll();
    const reauthId = await seed({ needsReauth: true });
    const healthyId = await seed();
    const result = await auth.getProviderCredentials("claude", new Set([reauthId]));
    expect(result?.connectionId).toBe(healthyId);
  });

  it("after clearNeedsReauth, connection is selectable again", async () => {
    await deleteAll();
    const reauthId = await seed({ needsReauth: true });
    await reauthState.clearNeedsReauth(reauthId);
    const creds = await auth.getProviderCredentials("claude");
    expect(creds?.connectionId).toBe(reauthId);
  });
});
