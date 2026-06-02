import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import { setupIsolatedDb } from "./helpers/isolated-db.mjs";

let cleanup;
let runner;
let repo;

before(async () => {
  ({ cleanup } = setupIsolatedDb());
  runner = await import("../src/lib/warmup/runner.js");
  repo = await import("../src/lib/db/repos/warmupRepo.js");
});

after(() => cleanup && cleanup());

const futureISO = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString();

let seq = 0;
function makeItem(provider, overrides = {}) {
  seq += 1;
  return {
    schedule: { id: `sch-${seq}`, name: `Schedule ${seq}`, timezone: "UTC", prompt: "hi" },
    providerConnectionId: `conn-${seq}`,
    scheduledForUtc: "2026-06-02T14:00:00.000Z",
    localDate: "2026-06-02",
    localTime: "21:00",
    timezone: "Asia/Ho_Chi_Minh",
    dedupeKey: `dk-${seq}`,
    ...overrides,
  };
}

// Build a deps bundle with sensible no-network stubs.
function makeDeps(item, { provider, served, usages = [], throwUsage = false } = {}) {
  const connId = item.providerConnectionId;
  let pollCount = 0;
  return {
    repollDelayMs: 0,
    sleep: async () => {},
    getConnection: async () => ({ id: connId, provider, isActive: true, name: `acct-${connId}` }),
    sendWarmupRequest: async () => ({
      servedConnectionId: served === undefined ? connId : served,
    }),
    fetchUsage: async () => {
      if (throwUsage) throw new Error("usage boom");
      const u = usages[Math.min(pollCount, usages.length - 1)];
      pollCount += 1;
      return u;
    },
  };
}

test("200 + fresh session (5h) window → success + active + resetsAt", async () => {
  const item = makeItem("claude");
  const reset = futureISO();
  const deps = makeDeps(item, {
    provider: "claude",
    usages: [{ usage: { plan: "Claude Code", extraUsage: null, quotas: { "session (5h)": { resetAt: reset, used: 50 } } }, authoritative: true }],
  });
  const row = await runner.runWarmupDueItem(item, { deps });
  assert.equal(row.status, "success");
  assert.equal(row.sessionState, "active");
  assert.equal(row.resetsAt, reset);
  assert.equal(row.utilization, 50);
});

test("no session window + authoritative + re-poll also empty → not-registered (status still success, dedupe=success)", async () => {
  const item = makeItem("claude");
  const empty = { usage: { plan: "Claude Code", extraUsage: null, quotas: { "weekly (7d)": { resetAt: futureISO(), used: 10 } } }, authoritative: true };
  const deps = makeDeps(item, { provider: "claude", usages: [empty, empty] });
  const row = await runner.runWarmupDueItem(item, { deps });
  assert.equal(row.status, "success");
  assert.equal(row.sessionState, "not-registered");
  assert.equal(await repo.hasSuccessfulWarmupRunFromDb(item.dedupeKey), true);
});

test("first poll empty but re-poll returns a window → active (confirmation re-poll absorbs lag)", async () => {
  const item = makeItem("claude");
  const reset = futureISO();
  const empty = { usage: { plan: "Claude Code", extraUsage: null, quotas: {} }, authoritative: true };
  const ok = { usage: { plan: "Claude Code", extraUsage: null, quotas: { "session (5h)": { resetAt: reset, used: 5 } } }, authoritative: true };
  const deps = makeDeps(item, { provider: "claude", usages: [empty, ok] });
  const row = await runner.runWarmupDueItem(item, { deps });
  assert.equal(row.sessionState, "active");
  assert.equal(row.resetsAt, reset);
});

test("claude legacy {message}-without-quotas → unknown, status success", async () => {
  const item = makeItem("claude");
  const deps = makeDeps(item, {
    provider: "claude",
    usages: [{ usage: { plan: "Pro", organization: "Acme", message: "admin only" }, authoritative: false }],
  });
  const row = await runner.runWarmupDueItem(item, { deps });
  assert.equal(row.status, "success");
  assert.equal(row.sessionState, "unknown");
});

test("fetchUsage throwing → unknown, warmup still success", async () => {
  const item = makeItem("claude");
  const deps = makeDeps(item, { provider: "claude", throwUsage: true });
  const row = await runner.runWarmupDueItem(item, { deps });
  assert.equal(row.status, "success");
  assert.equal(row.sessionState, "unknown");
});

test("non-session provider (qwen) → no poll, n/a", async () => {
  const item = makeItem("qwen");
  let polled = false;
  const deps = makeDeps(item, { provider: "qwen" });
  deps.fetchUsage = async () => { polled = true; return { usage: { quotas: {} }, authoritative: true }; };
  const row = await runner.runWarmupDueItem(item, { deps });
  assert.equal(row.sessionState, "n/a");
  assert.equal(polled, false, "must not poll usage for non-session provider");
});

test("served ≠ pinned (router fallback) → n/a, never not-registered", async () => {
  const item = makeItem("claude");
  let polled = false;
  const deps = makeDeps(item, { provider: "claude", served: "some-other-conn" });
  deps.fetchUsage = async () => { polled = true; return { usage: { quotas: {} }, authoritative: true }; };
  const row = await runner.runWarmupDueItem(item, { deps });
  assert.equal(row.sessionState, "n/a");
  assert.equal(polled, false, "divert must not be classified not-registered");
});

test("served account unobtainable (null header) → unknown, never not-registered", async () => {
  const item = makeItem("claude");
  const deps = makeDeps(item, { provider: "claude", served: null });
  const row = await runner.runWarmupDueItem(item, { deps });
  assert.equal(row.sessionState, "unknown");
});

test("digest mode: a not-registered item lands in notRegisteredBatch and triggers a send", async () => {
  const item = makeItem("claude");
  const empty = { usage: { plan: "Claude Code", extraUsage: null, quotas: {} }, authoritative: true };
  const deps = makeDeps(item, { provider: "claude", usages: [empty, empty] });
  let captured = null;
  deps.loadNotifier = async () => ({
    notifyWarmupDigest: (arg) => { captured = arg; },
  });
  await runner.runWarmupItems([item], { notify: "digest", deps });
  assert.ok(captured, "notifyWarmupDigest was called");
  assert.equal(captured.notRegisteredBatch.length, 1);
  assert.equal(captured.notRegisteredBatch[0].connectionId, item.providerConnectionId);
  assert.equal(captured.batch.length, 0, "no failures, only not-registered");
});
