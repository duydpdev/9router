import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let usageRepo;
let getAdapter;
let tempDir;
const originalEnv = { ...process.env };

// Build today's local dateKey the same way usageRepo aggregates the write side.
function localDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-key-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
  ({ getAdapter } = await import("@/lib/db/driver.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(originalEnv)) process.env[k] = v;
});

async function seedDay(dateKey, byApiKey) {
  const db = await getAdapter();
  const data = JSON.stringify({ requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, byApiKey });
  db.run(
    `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
    [dateKey, data]
  );
}

describe("getTodayUsageForKey", () => {
  it("sums today-only, key-scoped, across multiple byApiKey entries; ignores other keys", async () => {
    const dateKey = localDateKey();
    await seedDay(dateKey, {
      "keyA|gpt-4|openai": { requests: 3, promptTokens: 100, completionTokens: 50, cost: 0 },
      "keyA|claude|anthropic": { requests: 2, promptTokens: 200, completionTokens: 80, cost: 0 },
      "keyB|gpt-4|openai": { requests: 9, promptTokens: 999, completionTokens: 999, cost: 0 },
    });
    const usage = await usageRepo.getTodayUsageForKey("keyA");
    expect(usage.requests).toBe(5);          // 3 + 2
    expect(usage.tokens).toBe(430);          // 100+50 + 200+80
  });

  it("does NOT match a key that is a bare prefix of another (delimiter-anchored)", async () => {
    const dateKey = localDateKey();
    await seedDay(dateKey, {
      "key|m|p": { requests: 1, promptTokens: 10, completionTokens: 0, cost: 0 },
      "keyXL|m|p": { requests: 7, promptTokens: 700, completionTokens: 0, cost: 0 },
    });
    const usage = await usageRepo.getTodayUsageForKey("key");
    expect(usage.requests).toBe(1);
    expect(usage.tokens).toBe(10); // keyXL excluded
  });

  it("missing day row → {tokens:0, requests:0}", async () => {
    const usage = await usageRepo.getTodayUsageForKey("never-seen-key");
    expect(usage).toEqual({ tokens: 0, requests: 0 });
  });
});
