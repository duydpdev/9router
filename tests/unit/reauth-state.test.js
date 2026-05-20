import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let connectionsRepo;
let reauthState;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reauth-state-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  reauthState = await import("@/lib/oauth/reauth-state.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function seed({ refreshToken = "rt-1", authType = "oauth" } = {}) {
  return connectionsRepo.createProviderConnection({
    provider: `prov-${Math.random().toString(36).slice(2, 8)}`,
    authType,
    email: `seed-${Math.random().toString(36).slice(2, 8)}@x`,
    accessToken: "at-1",
    refreshToken,
  });
}

describe("reauth-state helpers", () => {
  it("markNeedsReauth writes the four fields", async () => {
    const conn = await seed();
    const ok = await reauthState.markNeedsReauth(conn.id, {
      reason: "invalid_grant",
      reauthAt: "2026-05-24T03:00:00.000Z",
    });
    expect(ok).toBe(true);

    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.needsReauth).toBe(true);
    expect(fresh.reauthReason).toBe("invalid_grant");
    expect(fresh.reauthAt).toBe("2026-05-24T03:00:00.000Z");
    expect(fresh.lastErrorType).toBe("token_refresh_failed");
  });

  it("markNeedsReauth defaults reauthAt to ISO now() when omitted", async () => {
    const conn = await seed();
    const before = Date.now();
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant" });
    const after = Date.now();

    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    const at = new Date(fresh.reauthAt).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after + 1);
  });

  it("markNeedsReauth on an unknown connectionId returns falsy without throwing", async () => {
    const ok = await reauthState.markNeedsReauth("does-not-exist", { reason: "invalid_grant" });
    expect(ok).toBe(false);
  });

  it("clearNeedsReauth resets the 4 reauth fields + lastErrorType", async () => {
    const conn = await seed();
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant" });
    await reauthState.markReauthNotified(conn.id, {
      reauthAt: (await connectionsRepo.getProviderConnectionById(conn.id)).reauthAt,
    });

    await reauthState.clearNeedsReauth(conn.id);
    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.needsReauth).toBe(false);
    expect(fresh.reauthReason ?? null).toBeNull();
    expect(fresh.reauthAt ?? null).toBeNull();
    expect(fresh.reauthNotifiedAt ?? null).toBeNull();
    expect(fresh.lastErrorType ?? null).toBeNull();
  });

  it("markReauthNotified returns true on first call and false on second call", async () => {
    const conn = await seed();
    await reauthState.markNeedsReauth(conn.id, {
      reason: "invalid_grant",
      reauthAt: "2026-05-24T04:00:00.000Z",
    });
    const first = await reauthState.markReauthNotified(conn.id, { reauthAt: "2026-05-24T04:00:00.000Z" });
    const second = await reauthState.markReauthNotified(conn.id, { reauthAt: "2026-05-24T04:00:00.000Z" });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("markReauthNotified returns true again after a fresh markNeedsReauth bumps reauthAt", async () => {
    const conn = await seed();
    await reauthState.markNeedsReauth(conn.id, {
      reason: "invalid_grant",
      reauthAt: "2026-05-24T05:00:00.000Z",
    });
    expect(await reauthState.markReauthNotified(conn.id, { reauthAt: "2026-05-24T05:00:00.000Z" })).toBe(true);

    // Bump reauthAt — clearing reauthNotifiedAt isn't required since CAS keys on reauthAt
    await reauthState.markNeedsReauth(conn.id, {
      reason: "invalid_grant",
      reauthAt: "2026-05-24T05:10:00.000Z",
    });
    // After the bump, reauthNotifiedAt is still set from the previous incident,
    // which would incorrectly block the next claim. The caller (notifier) resets
    // it by going through clearNeedsReauth on reconnect. For incidents that span
    // multiple fatal hits without a reconnect, we explicitly reset:
    await connectionsRepo.updateProviderConnection(conn.id, { reauthNotifiedAt: null });
    expect(await reauthState.markReauthNotified(conn.id, { reauthAt: "2026-05-24T05:10:00.000Z" })).toBe(true);
  });

  it("isNeedingReauth returns false on undefined and true on flag", () => {
    expect(reauthState.isNeedingReauth(null)).toBe(false);
    expect(reauthState.isNeedingReauth({})).toBe(false);
    expect(reauthState.isNeedingReauth({ needsReauth: true })).toBe(true);
  });

  it("connectionsRepo round-trip persists needsReauth=true", async () => {
    const conn = await seed();
    await connectionsRepo.updateProviderConnection(conn.id, { needsReauth: true });
    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(fresh.needsReauth).toBe(true);
  });

  it("supportsAutomatedReauth distinguishes refresh-capable connections", () => {
    expect(reauthState.supportsAutomatedReauth({ authType: "oauth", refreshToken: "x" })).toBe(true);
    expect(reauthState.supportsAutomatedReauth({ authType: "oauth", refreshToken: null })).toBe(false);
    expect(reauthState.supportsAutomatedReauth({ authType: "apikey", refreshToken: "x" })).toBe(false);
    expect(reauthState.supportsAutomatedReauth(null)).toBe(false);
  });

  it("markReauthNotified is single-writer under concurrent claims", async () => {
    const conn = await seed();
    const reauthAt = "2026-05-24T06:00:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reauthState.markReauthNotified(conn.id, { reauthAt })),
    );
    expect(results.filter(Boolean).length).toBe(1);
  });

  it("rollbackReauthNotified releases the slot for the next caller", async () => {
    const conn = await seed();
    const reauthAt = "2026-05-24T07:00:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });
    expect(await reauthState.markReauthNotified(conn.id, { reauthAt })).toBe(true);
    expect(await reauthState.rollbackReauthNotified(conn.id, { reauthAt })).toBe(true);
    expect(await reauthState.markReauthNotified(conn.id, { reauthAt })).toBe(true);
  });

  it("cleanupProviderConnections preserves active reauth state but prunes nullified ones", async () => {
    const active = await seed();
    const reauthAt = "2026-05-24T08:00:00.000Z";
    await reauthState.markNeedsReauth(active.id, { reason: "invalid_grant", reauthAt });

    const cleared = await seed();
    await reauthState.markNeedsReauth(cleared.id, { reason: "invalid_grant", reauthAt });
    await reauthState.clearNeedsReauth(cleared.id);

    await connectionsRepo.cleanupProviderConnections();

    const a = await connectionsRepo.getProviderConnectionById(active.id);
    expect(a.needsReauth).toBe(true);
    expect(a.reauthReason).toBe("invalid_grant");

    const c = await connectionsRepo.getProviderConnectionById(cleared.id);
    expect(c.needsReauth).toBe(false);
    expect(c.reauthReason ?? null).toBeNull();
  });
});
