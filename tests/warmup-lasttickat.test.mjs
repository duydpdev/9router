import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { setupIsolatedDb } from "./helpers/isolated-db.mjs";

let cleanup;
let store;

before(async () => {
  ({ cleanup } = setupIsolatedDb());
  // Dynamic import AFTER DATA_DIR override so paths.js resolves to temp dir.
  store = await import("../src/lib/warmup/store.js");
});

after(() => cleanup && cleanup());

test("getWarmupLastTickAt returns null on fresh DB", async () => {
  const got = await store.getWarmupLastTickAt();
  assert.equal(got, null);
});

test("setWarmupLastTickAt stores ISO string round-trip", async () => {
  const iso = "2026-05-17T10:00:00.000Z";
  await store.setWarmupLastTickAt(iso);
  assert.equal(await store.getWarmupLastTickAt(), iso);
});

test("setWarmupLastTickAt accepts Date and stores ISO", async () => {
  const d = new Date("2026-05-17T11:00:00.000Z");
  await store.setWarmupLastTickAt(d);
  assert.equal(await store.getWarmupLastTickAt(), d.toISOString());
});

test("setWarmupLastTickAt throws on null", async () => {
  await assert.rejects(async () => store.setWarmupLastTickAt(null), TypeError);
});

test("setWarmupLastTickAt throws on non-ISO string", async () => {
  await assert.rejects(async () => store.setWarmupLastTickAt("not an iso"), TypeError);
});

test("setWarmupLastTickAt rejects backward write (monotonic)", async () => {
  await store.setWarmupLastTickAt("2026-05-17T12:00:00.000Z");
  await store.setWarmupLastTickAt("2026-05-17T10:00:00.000Z"); // older — silent no-op
  assert.equal(await store.getWarmupLastTickAt(), "2026-05-17T12:00:00.000Z");
});

test("setWarmupLastTickAt no-op on same value", async () => {
  await store.setWarmupLastTickAt("2026-05-17T13:00:00.000Z");
  await store.setWarmupLastTickAt("2026-05-17T13:00:00.000Z");
  assert.equal(await store.getWarmupLastTickAt(), "2026-05-17T13:00:00.000Z");
});
