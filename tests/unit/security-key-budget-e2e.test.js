// End-to-end wiring smoke for the per-key budget monitor. Exercises the REAL
// chain with no stubs except the notifier transport:
//   saveRequestUsage() → statsEmitter.emit("usage") → initKeyBudgetMonitor
//   subscriber → checkKeyBudget → getCachedBotSettings (real settings) →
//   getTodayUsageForKey (real usageDaily) → evaluateBudget → notifyKeyBudget.
// Proves the usageRepo↔monitor decoupling (event-based, no security import in
// usageRepo) actually connects, and that a real request over budget fires a
// masked alert.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

let usageRepo;
let settingsRepo;
let apiKeysRepo;
let keyBudget;
let notifier;
let botSettingsCache;
let tempDir;
const originalEnv = { ...process.env };

const waitFor = async (cond, { tries = 50, gap = 10 } = {}) => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, gap));
  }
  return false;
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-budget-e2e-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
  settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
  apiKeysRepo = await import("@/lib/db/repos/apiKeysRepo.js");
  keyBudget = await import("@/lib/security/keyBudget.js");
  notifier = await import("@/lib/warmup/notifier.js");
  botSettingsCache = await import("@/lib/security/botSettingsCache.js");

  // Register the monitor once (mirrors the boot path).
  keyBudget.__test__.reset();
  keyBudget.initKeyBudgetMonitor();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
});

beforeEach(() => {
  keyBudget.__test__.reset();
  // re-register (reset cleared the guard); statsEmitter de-dups by our guard.
  keyBudget.initKeyBudgetMonitor();
  botSettingsCache.__test__.resetCache();
});

describe("key budget monitor — end-to-end via statsEmitter", () => {
  it("a real over-budget request fires a masked alert through the live chain", async () => {
    // Tiny budget so a single request trips 'over'.
    await settingsRepo.updateSettings({
      botProtection: {
        enabled: true,
        keyBudget: { enabled: true, tokenPerDay: 1, requestPerDay: 1, warnAtPercent: 80, reAlertHours: 4 },
      },
    });
    botSettingsCache.__test__.resetCache();

    const created = await apiKeysRepo.createApiKey("e2e-budget-key", "machine-e2e");

    notifier.__resetForTests({ genericUrl: "https://relay.example.com/hooks/budget" });
    let captured = null;
    const spy = vi.spyOn(notifier, "sendGeneric").mockImplementation(async (payload) => {
      captured = payload;
      return { ok: true, statusCode: 200 };
    });

    // Real usage write → real usageDaily upsert → real "usage" event.
    await usageRepo.saveRequestUsage({
      apiKey: created.key,
      provider: "openai",
      model: "gpt-4",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 500, completion_tokens: 200 },
      status: "ok",
    });

    const fired = await waitFor(() => captured !== null);
    expect(fired).toBe(true);
    expect(captured.event).toBe("security.key_budget");
    expect(captured.keyName).toBe("e2e-budget-key");
    expect(captured.tier).toBe("over");
    // SECURITY: the raw key must never appear in the alert payload.
    expect(JSON.stringify(captured)).not.toContain(created.key);
    spy.mockRestore();
  });

  it("a request UNDER budget fires no alert", async () => {
    await settingsRepo.updateSettings({
      botProtection: {
        enabled: true,
        keyBudget: { enabled: true, tokenPerDay: 100_000_000, requestPerDay: 100_000, warnAtPercent: 80, reAlertHours: 4 },
      },
    });
    botSettingsCache.__test__.resetCache();

    const created = await apiKeysRepo.createApiKey("e2e-under-key", "machine-e2e-2");
    notifier.__resetForTests({ genericUrl: "https://relay.example.com/hooks/budget" });
    const spy = vi.spyOn(notifier, "sendGeneric").mockResolvedValue({ ok: true, statusCode: 200 });

    await usageRepo.saveRequestUsage({
      apiKey: created.key,
      provider: "openai",
      model: "gpt-4",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      status: "ok",
    });

    // Give the microtask a chance; assert it stayed silent.
    await new Promise((r) => setTimeout(r, 80));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("monitor disabled (keyBudget.enabled=false) fires no alert even when over", async () => {
    await settingsRepo.updateSettings({
      botProtection: {
        enabled: true,
        keyBudget: { enabled: false, tokenPerDay: 1, requestPerDay: 1, warnAtPercent: 80, reAlertHours: 4 },
      },
    });
    botSettingsCache.__test__.resetCache();

    const created = await apiKeysRepo.createApiKey("e2e-disabled-key", "machine-e2e-3");
    notifier.__resetForTests({ genericUrl: "https://relay.example.com/hooks/budget" });
    const spy = vi.spyOn(notifier, "sendGeneric").mockResolvedValue({ ok: true, statusCode: 200 });

    await usageRepo.saveRequestUsage({
      apiKey: created.key,
      provider: "openai",
      model: "gpt-4",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 9999, completion_tokens: 9999 },
      status: "ok",
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
