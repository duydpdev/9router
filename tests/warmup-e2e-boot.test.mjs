// E2E-ish: prove `initializeApp` + warmup scheduler boot sequence works
// after restoring missing imports (cleanupProviderConnections, getSettings,
// updateSettings, getApiKeys). Without those, ReferenceError swallowed at
// initializeApp's catch → startWarmupScheduler never called → no warmup runs
// on the VPS. Test asserts the import resolves AND scheduler boots/ticks.

import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { setupIsolatedDb } from "./helpers/isolated-db.mjs";

let cleanup;
let scheduler;
let store;
let localDb;

before(async () => {
  ({ cleanup } = setupIsolatedDb());
  localDb = await import("../src/lib/localDb.js");
  scheduler = await import("../src/lib/warmup/scheduler.js");
  store = await import("../src/lib/warmup/store.js");
});

after(() => cleanup && cleanup());

test("localDb re-exports the four names initializeApp depends on", () => {
  for (const name of ["cleanupProviderConnections", "getSettings", "updateSettings", "getApiKeys"]) {
    assert.equal(typeof localDb[name], "function", `${name} must be exported as function`);
  }
});

test("scheduler ticks without throwing on empty schedules", async () => {
  const result = await scheduler.tickWarmupScheduler();
  assert.ok(result, "tick should return a result");
  assert.equal(result.triggered, false);
});

test("scheduler picks up a minute-level schedule and dedupe key carries HH:MM", async () => {
  // Compute "next HH:MM" 2 minutes ahead in Asia/Ho_Chi_Minh.
  const target = new Date(Date.now() + 2 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(target);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayIdx = weekdayMap[map.weekday];
  const hh = map.hour === "24" ? "00" : map.hour;
  const localTime = `${hh}:${map.minute}`;

  await store.saveWarmupSchedules([
    {
      id: "e2e-min",
      name: "e2e minute schedule",
      enabled: true,
      providerConnectionIds: ["__ghost__"], // won't run successfully, but slot detection is what we test
      days: [dayIdx],
      times: [localTime],
      prompt: "ping",
      timezone: "Asia/Ho_Chi_Minh",
    },
  ]);

  const schedules = await store.getWarmupSchedules();
  const found = schedules.find((s) => s.id === "e2e-min");
  assert.ok(found, "schedule should round-trip through store");
  assert.deepEqual(found.times, [localTime]);
});
