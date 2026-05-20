import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const originalEnv = { ...process.env };
let tempDir;
let connectionsRepo;
let reauthState;
let notifier;
let reauthAlert;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reauth-alert-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  connectionsRepo = await import("@/lib/db/repos/connectionsRepo.js");
  reauthState = await import("@/lib/oauth/reauth-state.js");
  notifier = await import("@/lib/warmup/notifier.js");
  reauthAlert = await import("@/lib/notifier/reauth-alert.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
});

async function seedConnection() {
  return connectionsRepo.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: `seed-${Math.random().toString(36).slice(2, 8)}@x`,
    accessToken: "at",
    refreshToken: "rt",
  });
}

function withConfig(overrides) {
  notifier.__resetForTests(overrides);
}

beforeEach(() => {
  // Default — no channels configured
  withConfig({});
});

describe("reauth-alert.notifyReauthRequired", () => {
  it("dedupes a second call within the same (connectionId, reauthAt)", async () => {
    withConfig({ discordUrl: "https://discord.com/api/webhooks/12345678901234567890/aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm" });
    const sendDiscord = vi.spyOn(notifier, "sendDiscord").mockResolvedValue({ ok: true, statusCode: 200 });
    const conn = await seedConnection();
    const reauthAt = "2026-05-24T03:00:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });

    const a = await reauthAlert.notifyReauthRequired({ connection: conn, reason: "invalid_grant", reauthAt });
    const b = await reauthAlert.notifyReauthRequired({ connection: conn, reason: "invalid_grant", reauthAt });

    expect(a).toMatchObject({ notified: true, delivered: 1 });
    expect(b).toMatchObject({ deduped: true });
    expect(sendDiscord).toHaveBeenCalledTimes(1);
    sendDiscord.mockRestore();
  });

  it("returns disabled when WARMUP_NOTIFY_ENABLED is false (config disabled)", async () => {
    notifier.__resetForTests({}); // default enabled=true via __resetForTests
    // Manually override enabled=false by simulating real env read
    const cfg = notifier.getNotifierConfig();
    const stub = vi.spyOn(notifier, "getNotifierConfig").mockReturnValue({ ...cfg, enabled: false });
    const conn = await seedConnection();
    const reauthAt = "2026-05-24T03:01:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });
    const res = await reauthAlert.notifyReauthRequired({ connection: conn, reason: "invalid_grant", reauthAt });
    expect(res).toMatchObject({ notified: false, disabled: true });
    stub.mockRestore();
  });

  it("rolls back the CAS claim when no channel is configured", async () => {
    withConfig({}); // no channels
    const conn = await seedConnection();
    const reauthAt = "2026-05-24T03:02:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });
    const res = await reauthAlert.notifyReauthRequired({ connection: conn, reason: "invalid_grant", reauthAt });
    expect(res).toMatchObject({ notified: false, channels: 0, rolledBack: true });

    // Next call must reclaim the slot (rollback releases it)
    const row = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(row.reauthNotifiedAt ?? null).toBeNull();
  });

  it("rolls back the CAS claim when every channel rejects", async () => {
    withConfig({ discordUrl: "https://discord.com/api/webhooks/12345678901234567890/aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm" });
    const sendDiscord = vi.spyOn(notifier, "sendDiscord").mockResolvedValue({ ok: false, statusCode: 500, reason: "http_500" });
    const conn = await seedConnection();
    const reauthAt = "2026-05-24T03:03:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });

    const res = await reauthAlert.notifyReauthRequired({ connection: conn, reason: "invalid_grant", reauthAt });
    expect(res).toMatchObject({ notified: false, rolledBack: true, delivered: 0 });
    const row = await connectionsRepo.getProviderConnectionById(conn.id);
    expect(row.reauthNotifiedAt ?? null).toBeNull();
    sendDiscord.mockRestore();
  });

  it("builds Discord payload with [REAUTH] prefix, deep-link URL, and disarmed mentions", async () => {
    withConfig({ discordUrl: "https://discord.com/api/webhooks/12345678901234567890/aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm" });
    process.env.PUBLIC_BASE_URL = "https://example.test";
    let captured = null;
    const sendDiscord = vi.spyOn(notifier, "sendDiscord").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });

    const conn = await seedConnection();
    await connectionsRepo.updateProviderConnection(conn.id, { name: "@everyone hack" });
    const fresh = await connectionsRepo.getProviderConnectionById(conn.id);
    const reauthAt = "2026-05-24T03:04:00.000Z";
    await reauthState.markNeedsReauth(fresh.id, { reason: "invalid_grant", reauthAt });

    await reauthAlert.notifyReauthRequired({ connection: fresh, reason: "invalid_grant", reauthAt });

    expect(captured).toBeTruthy();
    expect(captured.content).toContain("[REAUTH]");
    expect(captured.content).not.toContain("@everyone");
    expect(captured.embeds[0].url).toBe(`https://example.test/dashboard/providers/${fresh.provider}?reconnect=${fresh.id}`);
    expect(captured.allowed_mentions).toEqual({ parse: [] });
    sendDiscord.mockRestore();
    delete process.env.PUBLIC_BASE_URL;
  });

  it("builds Telegram MarkdownV2 with reconnect link", async () => {
    withConfig({
      telegramToken: "1234567890:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR",
      telegramChatId: "987654",
    });
    let captured = null;
    const sendTelegram = vi.spyOn(notifier, "sendTelegram").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });

    const conn = await seedConnection();
    const reauthAt = "2026-05-24T03:05:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });
    await reauthAlert.notifyReauthRequired({ connection: conn, reason: "invalid_grant", reauthAt });

    expect(captured).toBeTruthy();
    expect(captured.parse_mode).toBe("MarkdownV2");
    // [REAUTH] gets MarkdownV2-escaped on the prefix line
    expect(captured.text).toContain("\\[REAUTH\\]");
    // Raw URL must NOT be escaped (only label inside the parens)
    expect(captured.text).toMatch(/\[Reconnect\]\(.+reconnect=/);
    sendTelegram.mockRestore();
  });

  it("emits a generic webhook payload with reauth-event shape", async () => {
    withConfig({ genericUrl: "https://relay.example.com/hooks/reauth" });
    let captured = null;
    const sendGeneric = vi.spyOn(notifier, "sendGeneric").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });

    const conn = await seedConnection();
    const reauthAt = "2026-05-24T03:06:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });
    await reauthAlert.notifyReauthRequired({ connection: conn, reason: "invalid_grant", reauthAt });

    expect(captured).toMatchObject({
      event: "provider.reauth_required",
      kind: "reauth",
      fields: { reason: "invalid_grant", reauthAt },
    });
    expect(captured.deepLinkUrl).toContain(`reconnect=${conn.id}`);
    sendGeneric.mockRestore();
  });

  it("path-only deep-link when no base URL env is set", async () => {
    withConfig({ genericUrl: "https://relay.example.com/hooks/reauth" });
    let captured = null;
    const sendGeneric = vi.spyOn(notifier, "sendGeneric").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;

    const conn = await seedConnection();
    const reauthAt = "2026-05-24T03:07:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "invalid_grant", reauthAt });
    await reauthAlert.notifyReauthRequired({ connection: conn, reason: "invalid_grant", reauthAt });
    expect(captured.deepLinkUrl).toMatch(/^\/dashboard\/providers\//);
    sendGeneric.mockRestore();
  });

  it("manual_reimport_needed kind emits a different prefix and label", async () => {
    withConfig({ genericUrl: "https://relay.example.com/hooks/reauth" });
    let captured = null;
    const sendGeneric = vi.spyOn(notifier, "sendGeneric").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });
    const conn = await seedConnection();
    const reauthAt = "2026-05-24T03:08:00.000Z";
    await reauthState.markNeedsReauth(conn.id, { reason: "refresh_unknown", reauthAt });
    await reauthAlert.notifyReauthRequired({
      connection: conn, reason: "refresh_unknown", reauthAt, kind: "manual_reimport_needed",
    });
    expect(captured.event).toBe("provider.manual_reimport_needed");
    expect(captured.kind).toBe("manual_reimport_needed");
    sendGeneric.mockRestore();
  });
});
