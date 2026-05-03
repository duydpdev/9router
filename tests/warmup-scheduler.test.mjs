import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { setupIsolatedDb } from "./helpers/isolated-db.mjs";

let cleanup;
let scheduler;
let store;
let repo;

before(async () => {
  ({ cleanup } = setupIsolatedDb());
  scheduler = await import("../src/lib/warmup/scheduler.js");
  store = await import("../src/lib/warmup/store.js");
  repo = await import("../src/lib/db/repos/warmupRepo.js");
});

after(() => cleanup && cleanup());

function isoNow() {
  return new Date().toISOString();
}

function isoMinus(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function clearSchedulerState() {
  // Reset shared global so tests don't bleed state.
  const g = global.__warmupScheduler;
  if (g) {
    g.running = false;
    g.lastClampedFrom = null;
    g.lastResult = null;
    g.lastTickAt = null;
  }
}

test("cold start: no persisted lastTickAt → from = now, dueCount=0", async () => {
  await clearSchedulerState();
  // No schedules; ensure clean kv state.
  await store.saveWarmupSchedules([]);
  const result = await scheduler.tickWarmupScheduler();
  assert.equal(result.triggered, false);
  // lastTickAt persisted after first tick.
  const persisted = await store.getWarmupLastTickAt();
  assert.match(persisted, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("clamp at 6h: seed lastTickAt = now-9h → clamp log fires once", async () => {
  await clearSchedulerState();
  const old = isoMinus(9);
  // Bypass monotonic guard by writing kv directly via repo helper.
  // setWarmupLastTickAt would refuse if current >= new. We need to set then back.
  // Workaround: clear by importing kvStore directly.
  const kv = await import("../src/lib/db/helpers/kvStore.js");
  const warmupKv = kv.makeKv("warmup");
  await warmupKv.set("lastTickAt", old);

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await scheduler.tickWarmupScheduler();
    // Second tick — clamp log MUST NOT fire again for same persistedRaw (in-mem flag),
    // but persistedRaw changed because we just advanced lastTickAt.
    // Reset to old again and tick → fires again (different "outage" in-mem tracking).
  } finally {
    console.log = origLog;
  }
  const clampLogs = logs.filter((l) => l.includes("catch-up clamped from"));
  assert.equal(clampLogs.length, 1, `expected 1 clamp log, got ${clampLogs.length}: ${JSON.stringify(logs)}`);
});

test("clamp dedupes log when same persistedRaw seen twice", async () => {
  await clearSchedulerState();
  const kv = await import("../src/lib/db/helpers/kvStore.js");
  const warmupKv = kv.makeKv("warmup");
  const old = isoMinus(9);
  await warmupKv.set("lastTickAt", old);

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    // First tick: logs clamp (persistedRaw === old). Re-seed kv back to same old value.
    // Second tick sees same persistedRaw → g.lastClampedFrom matches → suppresses log.
    await scheduler.tickWarmupScheduler();
    await warmupKv.set("lastTickAt", old);
    await scheduler.tickWarmupScheduler();
  } finally {
    console.log = origLog;
  }
  const clampLogs = logs.filter((l) => l.includes("catch-up clamped from"));
  assert.equal(clampLogs.length, 1, `dedupe failed: ${JSON.stringify(logs)}`);
});

test("re-entrancy: parallel ticks return skipped on second call", async () => {
  await clearSchedulerState();
  await store.saveWarmupSchedules([]);
  // Manually flip g.running BEFORE the call to simulate in-flight tick.
  // Direct flip via global state ensures the guard is observable.
  global.__warmupScheduler.running = true;
  try {
    const result = await scheduler.tickWarmupScheduler();
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "already-running");
  } finally {
    global.__warmupScheduler.running = false;
  }
});

test("lastTickAt persists BEFORE schedules + runner execute", async () => {
  await clearSchedulerState();
  // Seed schedules with NO providers so due=0 and runner never invoked.
  // Then verify lastTickAt advanced to a value close to now.
  await store.saveWarmupSchedules([]);
  const before = Date.now();
  await scheduler.tickWarmupScheduler();
  const after = Date.now();
  const persisted = await store.getWarmupLastTickAt();
  const persistedMs = new Date(persisted).getTime();
  assert.ok(persistedMs >= before && persistedMs <= after, `persisted ${persisted} not in [${before}, ${after}]`);
});

test("status-aware dedupe: failure row does NOT block retry", async () => {
  await clearSchedulerState();
  const dedupeKey = `sched-x:conn-x:2026-05-17:09:00`;
  await repo.insertWarmupRun({
    id: "run-fail-1",
    scheduleId: "sched-x",
    providerConnectionId: "conn-x",
    scheduledForUtc: "2026-05-17T02:00:00.000Z",
    actualRanAt: "2026-05-17T02:00:01.000Z",
    localDate: "2026-05-17",
    localTime: "09:00",
    timezone: "Asia/Kolkata",
    dedupeKey,
    status: "failure",
    error: "boom",
    createdAt: "2026-05-17T02:00:01.000Z",
  });
  assert.equal(await store.hasWarmupRun(dedupeKey), false);

  await repo.insertWarmupRun({
    id: "run-ok-1",
    scheduleId: "sched-x",
    providerConnectionId: "conn-x",
    scheduledForUtc: "2026-05-17T02:00:00.000Z",
    actualRanAt: "2026-05-17T02:00:02.000Z",
    localDate: "2026-05-17",
    localTime: "09:00",
    timezone: "Asia/Kolkata",
    dedupeKey,
    status: "success",
    error: null,
    createdAt: "2026-05-17T02:00:02.000Z",
  });
  assert.equal(await store.hasWarmupRun(dedupeKey), true);
});

test("getWarmupSchedulerStatus reflects running flag", async () => {
  await clearSchedulerState();
  assert.equal(scheduler.getWarmupSchedulerStatus().running, false);
  global.__warmupScheduler.running = true;
  assert.equal(scheduler.getWarmupSchedulerStatus().running, true);
  global.__warmupScheduler.running = false;
});
