import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

let keyBudget;
let notifier;
let keyBudgetAlert;
let apiKeysRepo;
let tempDir;
const originalEnv = { ...process.env };

const BUDGET = { enabled: true, tokenPerDay: 1000, requestPerDay: 100, warnAtPercent: 80, reAlertHours: 4 };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-budget-alert-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  keyBudget = await import("@/lib/security/keyBudget.js");
  notifier = await import("@/lib/warmup/notifier.js");
  keyBudgetAlert = await import("@/lib/notifier/key-budget-alert.js");
  apiKeysRepo = await import("@/lib/db/repos/apiKeysRepo.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
});

beforeEach(() => {
  keyBudget.__test__.reset();
  keyBudgetAlert.__test__.resetWindow();
});

// ── checkKeyBudget: dedup / re-alert / concurrency / errors (DI, no network) ──
describe("checkKeyBudget dedup + re-alert", () => {
  const overUsage = { tokens: 2000, requests: 0 }; // 200% → over
  const warnUsage = { tokens: 850, requests: 0 }; // 85% → warn
  const deps = (notify, getUsage, nowMs) => ({
    now: () => nowMs,
    getBudget: async () => BUDGET,
    getUsage: async () => getUsage,
    notify,
  });

  it("two 'over' events same key/day → notify once", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const t0 = DAY * 100;
    await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0));
    const second = await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0 + 1000));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(second.reason).toBe("deduped");
  });

  it("warn then over → notify twice (tier escalation)", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const t0 = DAY * 100;
    await keyBudget.checkKeyBudget("keyA", deps(notify, warnUsage, t0));
    await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0 + 1000));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("new day resets dedup → notify again", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const t0 = DAY * 100;
    await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0));
    await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0 + DAY)); // next day
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("re-alert only after reAlertHours while still over", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const t0 = DAY * 100;
    await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0));
    // before window elapses → no re-alert
    await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0 + 4 * HOUR - 1000));
    expect(notify).toHaveBeenCalledTimes(1);
    // at/after window → re-alert
    await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0 + 4 * HOUR));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("N concurrent 'over' events for one key → exactly one send (sync claim)", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const t0 = DAY * 100;
    const calls = Array.from({ length: 8 }, () => keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0)));
    await Promise.all(calls);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("disabled budget → no send", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const res = await keyBudget.checkKeyBudget("keyA", {
      now: () => 0,
      getBudget: async () => null,
      getUsage: async () => overUsage,
      notify,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(res.reason).toBe("disabled");
  });

  it("never throws when the reader rejects", async () => {
    const notify = vi.fn();
    const res = await keyBudget.checkKeyBudget("keyA", {
      now: () => 0,
      getBudget: async () => BUDGET,
      getUsage: async () => { throw new Error("db down"); },
      notify,
    });
    expect(res.sent).toBe(false);
    expect(res.error).toContain("db down");
    expect(notify).not.toHaveBeenCalled();
  });

  it("never throws when getUsage throws synchronously", async () => {
    const notify = vi.fn();
    const res = await keyBudget.checkKeyBudget("keyA", {
      now: () => 0,
      getBudget: async () => BUDGET,
      getUsage: () => { throw new Error("sync boom"); },
      notify,
    });
    expect(res.sent).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("dedup Map stays bounded (size reflects distinct keys, evicts at cap)", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const t0 = DAY * 100;
    await keyBudget.checkKeyBudget("keyA", deps(notify, overUsage, t0));
    await keyBudget.checkKeyBudget("keyB", deps(notify, overUsage, t0));
    expect(keyBudget.__test__.size()).toBe(2);
  });
});

// ── notifyKeyBudget: masking + flood cap (real notifier transport, spied) ─────
describe("notifyKeyBudget masking + flood cap", () => {
  it("generic payload carries key NAME + masked hash, never the raw key", async () => {
    const created = await apiKeysRepo.createApiKey("billing-team-key", "machine-xyz");
    notifier.__resetForTests({ genericUrl: "https://relay.example.com/hooks/budget" });
    let captured = null;
    const spy = vi.spyOn(notifier, "sendGeneric").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });

    await keyBudgetAlert.notifyKeyBudget({
      apiKey: created.key,
      keyHash: "deadbeefdeadbeef",
      tier: "over",
      pct: 142,
      usage: { tokens: 7_000_000, requests: 12 },
      budget: { tokenPerDay: 5_000_000, requestPerDay: 5000 },
    });

    expect(captured).toBeTruthy();
    expect(captured.event).toBe("security.key_budget");
    expect(captured.keyName).toBe("billing-team-key");
    expect(captured.keyHash).toBe("deadbeefdeadbeef");
    // HARD invariant: the raw key must never appear in the serialized payload.
    expect(JSON.stringify(captured)).not.toContain(created.key);
    spy.mockRestore();
  });

  it("disabled notifier config → no send", async () => {
    notifier.__resetForTests({});
    const cfg = notifier.getNotifierConfig();
    const stub = vi.spyOn(notifier, "getNotifierConfig").mockReturnValue({ ...cfg, enabled: false });
    const res = await keyBudgetAlert.notifyKeyBudget({
      apiKey: "x", keyHash: "h", tier: "over", pct: 100,
      usage: { tokens: 1, requests: 1 }, budget: { tokenPerDay: 1, requestPerDay: 1 },
    });
    expect(res).toMatchObject({ notified: false, disabled: true });
    stub.mockRestore();
  });

  it("flood cap suppresses budget alerts beyond the hourly cap", async () => {
    notifier.__resetForTests({ genericUrl: "https://relay.example.com/hooks/budget" });
    const spy = vi.spyOn(notifier, "sendGeneric").mockResolvedValue({ ok: true, statusCode: 200 });
    const cap = keyBudgetAlert.__test__.CAP_PER_HOUR;
    const t0 = DAY * 200;

    let rateLimited = 0;
    for (let i = 0; i < cap + 5; i++) {
      const r = await keyBudgetAlert.notifyKeyBudget(
        { apiKey: "x", keyHash: "h", tier: "over", pct: 100, usage: { tokens: 1, requests: 1 }, budget: { tokenPerDay: 1, requestPerDay: 1 } },
        t0 + i * 1000, // all within the same hour
      );
      if (r.rateLimited) rateLimited++;
    }
    expect(rateLimited).toBe(5); // only the first `cap` go through
    spy.mockRestore();
  });

  it("Discord payload: [KEY BUDGET] prefix, mentions disarmed, no raw key", async () => {
    const created = await apiKeysRepo.createApiKey("@everyone pwn", "machine-dc");
    notifier.__resetForTests({ discordUrl: "https://discord.com/api/webhooks/12345678901234567890/aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm" });
    let captured = null;
    const spy = vi.spyOn(notifier, "sendDiscord").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });
    await keyBudgetAlert.notifyKeyBudget({
      apiKey: created.key, keyHash: "cafebabecafebabe", tier: "over", pct: 130,
      usage: { tokens: 9, requests: 9 }, budget: { tokenPerDay: 1, requestPerDay: 1 },
    });
    expect(captured.content).toContain("[KEY BUDGET]");
    expect(captured.content).not.toContain("@everyone");      // disarmed
    expect(captured.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(captured)).not.toContain(created.key);
    spy.mockRestore();
  });

  it("Telegram payload: MarkdownV2, masked hash, no raw key", async () => {
    const created = await apiKeysRepo.createApiKey("tg-key", "machine-tg");
    notifier.__resetForTests({ telegramToken: "1234567890:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQRR", telegramChatId: "987654" });
    let captured = null;
    const spy = vi.spyOn(notifier, "sendTelegram").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });
    await keyBudgetAlert.notifyKeyBudget({
      apiKey: created.key, keyHash: "0123456789abcdef", tier: "warn", pct: 85,
      usage: { tokens: 850, requests: 0 }, budget: { tokenPerDay: 1000, requestPerDay: 100 },
    });
    expect(captured.parse_mode).toBe("MarkdownV2");
    expect(captured.text).toContain("\\[KEY BUDGET\\]"); // prefix escaped for MarkdownV2
    expect(captured.text).toContain("0123456789abcdef");
    expect(JSON.stringify(captured)).not.toContain(created.key);
    spy.mockRestore();
  });

  it("multi-channel fanout reports delivered count; partial failure still notified", async () => {
    const created = await apiKeysRepo.createApiKey("multi-key", "machine-multi");
    notifier.__resetForTests({
      discordUrl: "https://discord.com/api/webhooks/12345678901234567890/aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm",
      genericUrl: "https://relay.example.com/hooks/budget",
    });
    const dSpy = vi.spyOn(notifier, "sendDiscord").mockResolvedValue({ ok: false, statusCode: 500, reason: "http_500" });
    const gSpy = vi.spyOn(notifier, "sendGeneric").mockResolvedValue({ ok: true, statusCode: 200 });
    const res = await keyBudgetAlert.notifyKeyBudget({
      apiKey: created.key, keyHash: "h", tier: "over", pct: 120,
      usage: { tokens: 9, requests: 9 }, budget: { tokenPerDay: 1, requestPerDay: 1 },
    });
    expect(res).toMatchObject({ notified: true, channels: 2, delivered: 1 });
    dSpy.mockRestore();
    gSpy.mockRestore();
  });
});

// ── sweep + warn-tier dedup ───────────────────────────────────────────────────
describe("checkKeyBudget sweep + warn-tier dedup", () => {
  const overUsage = { tokens: 2000, requests: 0 };
  const warnUsage = { tokens: 850, requests: 0 };
  const deps = (notify, usage, nowMs) => ({
    now: () => nowMs,
    getBudget: async () => BUDGET,
    getUsage: async () => usage,
    notify,
  });

  it("warn stays warn same day → notify once (no re-alert for warn tier)", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const t0 = DAY * 300;
    await keyBudget.checkKeyBudget("warnKey", deps(notify, warnUsage, t0));
    // even far past reAlertHours, a non-escalating warn must NOT re-fire
    await keyBudget.checkKeyBudget("warnKey", deps(notify, warnUsage, t0 + 10 * HOUR));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("sweep() drops prior-day entries, keeps today's", async () => {
    const notify = vi.fn().mockResolvedValue({ notified: true });
    const day1 = DAY * 400;
    const day2 = day1 + DAY;
    await keyBudget.checkKeyBudget("oldKey", deps(notify, overUsage, day1));
    await keyBudget.checkKeyBudget("newKey", deps(notify, overUsage, day2));
    expect(keyBudget.__test__.size()).toBe(2);
    keyBudget.sweep(() => day2); // sweep as-of day2
    expect(keyBudget.__test__.size()).toBe(1); // only newKey (today) survives
  });
});
