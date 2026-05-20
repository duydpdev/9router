import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { setupIsolatedDb } from "./helpers/isolated-db.mjs";

let cleanup;
let connectionsRepo;
let store;

before(async () => {
  ({ cleanup } = setupIsolatedDb());
  connectionsRepo = await import("../src/lib/db/repos/connectionsRepo.js");
  store = await import("../src/lib/warmup/store.js");
});

after(() => cleanup && cleanup());

async function seedConnection(id, provider) {
  const now = new Date().toISOString();
  const adapter = await (await import("../src/lib/db/driver.js")).getAdapter();
  adapter.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, isActive=excluded.isActive, updatedAt=excluded.updatedAt`,
    [id, provider, "apiKey", `${provider}-${id}`, null, 1, 1, "{}", now, now],
  );
}

test("deleteProviderConnection strips ID from warmup schedule providerConnectionIds", async () => {
  await seedConnection("conn-A", "claude");
  await seedConnection("conn-B", "claude");

  await store.saveWarmupSchedules([
    {
      id: "sched-1",
      name: "test",
      enabled: true,
      providerConnectionIds: ["conn-A", "conn-B"],
      days: [0, 1, 2, 3, 4, 5, 6],
      times: ["09:00"],
      prompt: "ping",
      timezone: "UTC",
    },
  ]);

  const before = await store.getWarmupSchedules();
  assert.deepEqual(before[0].providerConnectionIds, ["conn-A", "conn-B"]);

  const ok = await connectionsRepo.deleteProviderConnection("conn-A");
  assert.equal(ok, true);

  const after = await store.getWarmupSchedules();
  assert.deepEqual(after[0].providerConnectionIds, ["conn-B"], "conn-A should be pruned");
});

test("deleteProviderConnection is no-op when ID is not in any schedule", async () => {
  await seedConnection("conn-C", "claude");
  await store.saveWarmupSchedules([
    {
      id: "sched-2",
      name: "test2",
      enabled: true,
      providerConnectionIds: ["conn-C"],
      days: [0, 1, 2, 3, 4, 5, 6],
      times: ["10:00"],
      prompt: "ping",
      timezone: "UTC",
    },
  ]);
  await seedConnection("conn-untouched", "claude");
  await connectionsRepo.deleteProviderConnection("conn-untouched");
  const after = await store.getWarmupSchedules();
  // conn-C must remain since only conn-untouched was deleted
  assert.deepEqual(after[0].providerConnectionIds, ["conn-C"]);
});

test("deleteProviderConnectionsByProvider cascades all deleted IDs", async () => {
  await seedConnection("conn-X", "openai");
  await seedConnection("conn-Y", "openai");
  await seedConnection("conn-Z", "claude");

  await store.saveWarmupSchedules([
    {
      id: "sched-3",
      name: "mix",
      enabled: true,
      providerConnectionIds: ["conn-X", "conn-Y", "conn-Z"],
      days: [0, 1, 2, 3, 4, 5, 6],
      times: ["11:00"],
      prompt: "ping",
      timezone: "UTC",
    },
  ]);

  const removed = await connectionsRepo.deleteProviderConnectionsByProvider("openai");
  assert.equal(removed, 2);

  const after = await store.getWarmupSchedules();
  assert.deepEqual(after[0].providerConnectionIds, ["conn-Z"]);
});

test("pruneOrphanProviderIds drops IDs not present in knownIds set", async () => {
  const { pruneOrphanProviderIds } = await import("../src/lib/warmup/schedule.js");
  const input = [
    {
      id: "s1",
      name: "x",
      enabled: true,
      providerConnectionIds: ["conn-real", "conn-deleted-orphan"],
      days: [1],
      times: ["09:00"],
      prompt: "p",
      timezone: "UTC",
    },
    {
      id: "s2",
      name: "y",
      enabled: true,
      providerConnectionIds: ["conn-deleted-orphan"],
      days: [1],
      times: ["09:00"],
      prompt: "p",
      timezone: "UTC",
    },
  ];
  const out = pruneOrphanProviderIds(input, new Set(["conn-real"]));
  assert.deepEqual(out[0].providerConnectionIds, ["conn-real"]);
  assert.deepEqual(out[1].providerConnectionIds, []);
  // Original input not mutated
  assert.deepEqual(input[0].providerConnectionIds, ["conn-real", "conn-deleted-orphan"]);
});

test("pruneOrphanProviderIds accepts plain array as knownIds", async () => {
  const { pruneOrphanProviderIds } = await import("../src/lib/warmup/schedule.js");
  const out = pruneOrphanProviderIds(
    [{ id: "s", providerConnectionIds: ["a", "b", "c"] }],
    ["a", "c"],
  );
  assert.deepEqual(out[0].providerConnectionIds, ["a", "c"]);
});
