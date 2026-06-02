import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { setupIsolatedDb } from "./helpers/isolated-db.mjs";

let cleanup;
let store;
let repo;
let migrate;
let driver;

before(async () => {
  ({ cleanup } = setupIsolatedDb());
  // Dynamic import AFTER DATA_DIR override so paths.js resolves to temp dir.
  store = await import("../src/lib/warmup/store.js");
  repo = await import("../src/lib/db/repos/warmupRepo.js");
  migrate = await import("../src/lib/db/migrate.js");
  driver = await import("../src/lib/db/driver.js");
});

after(() => cleanup && cleanup());

const BASE = {
  scheduleId: "sch-1",
  providerConnectionId: "conn-1",
  scheduledForUtc: "2026-06-02T14:00:00.000Z",
  localDate: "2026-06-02",
  localTime: "21:00",
  timezone: "Asia/Ho_Chi_Minh",
};

test("sentinel round-trip: new fields persist to the RIGHT column (no binding swap)", async () => {
  const dedupeKey = "round-trip-1";
  await store.appendWarmupRun({
    ...BASE,
    dedupeKey,
    status: "success",
    resetsAt: "2026-06-02T14:47:00.000Z",
    utilization: 42,
    sessionState: "active",
  });
  const { rows } = await repo.getWarmupRunsPageFromDb({ limit: 100, offset: 0 });
  const row = rows.find((r) => r.dedupeKey === dedupeKey);
  assert.ok(row, "row found");
  // Distinct sentinel values prove each lands in its own column.
  assert.equal(row.resetsAt, "2026-06-02T14:47:00.000Z");
  assert.equal(row.utilization, 42);
  assert.equal(row.sessionState, "active");
  assert.equal(row.status, "success");
});

test("missing new fields default to null / null / 'n/a'", async () => {
  const dedupeKey = "defaults-1";
  await store.appendWarmupRun({
    ...BASE,
    dedupeKey,
    status: "success",
  });
  const { rows } = await repo.getWarmupRunsPageFromDb({ limit: 100, offset: 0 });
  const row = rows.find((r) => r.dedupeKey === dedupeKey);
  assert.ok(row, "row found");
  assert.equal(row.resetsAt, null);
  assert.equal(row.utilization, null);
  assert.equal(row.sessionState, "n/a");
});

test("dedupe still keys only on status='success'", async () => {
  const dedupeKey = "dedupe-1";
  await store.appendWarmupRun({ ...BASE, dedupeKey, status: "success", sessionState: "not-registered" });
  // A not-registered run is still status=success → locks the dedupe slot.
  assert.equal(await repo.hasSuccessfulWarmupRunFromDb(dedupeKey), true);

  const failKey = "dedupe-2";
  await store.appendWarmupRun({ ...BASE, dedupeKey: failKey, status: "failure" });
  assert.equal(await repo.hasSuccessfulWarmupRunFromDb(failKey), false);
});

test("additive migration: ADD COLUMN on a pre-existing table preserves rows", async () => {
  const db = await driver.getAdapter();
  // Simulate a DB created before the session columns existed: rebuild
  // warmup_runs with the original 12-column shape and seed a row.
  db.exec("DROP TABLE IF EXISTS warmup_runs");
  db.exec(
    `CREATE TABLE warmup_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      provider_connection_id TEXT NOT NULL,
      scheduled_for_utc TEXT NOT NULL,
      actual_ran_at TEXT NOT NULL,
      local_date TEXT NOT NULL,
      local_time TEXT NOT NULL,
      timezone TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    )`
  );
  db.run(
    `INSERT INTO warmup_runs(id, schedule_id, provider_connection_id, scheduled_for_utc, actual_ran_at, local_date, local_time, timezone, dedupe_key, status, error, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["legacy-1", "sch", "conn", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01", "07:00", "UTC", "legacy-dedupe", "success", null, "2026-01-01T00:00:00.000Z"]
  );

  migrate.syncSchemaFromTables(db);

  const cols = new Set(db.all("PRAGMA table_info(warmup_runs)").map((r) => r.name));
  assert.ok(cols.has("resets_at"), "resets_at added");
  assert.ok(cols.has("utilization"), "utilization added");
  assert.ok(cols.has("session_state"), "session_state added");

  const survivor = db.get("SELECT * FROM warmup_runs WHERE id = ?", ["legacy-1"]);
  assert.ok(survivor, "pre-existing row survived ADD COLUMN");
  assert.equal(survivor.status, "success");
  // Old rows read back null for the new columns.
  assert.equal(survivor.resets_at, null);
  assert.equal(survivor.session_state, null);
});
