import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDedupeKey,
  buildWarmupPreview,
  findDueWarmupRuns,
  findDueWarmupRunsInRange,
  normalizeWarmupSchedule,
  trimWarmupRuns,
  validateWarmupSchedules,
} from "../src/lib/warmup/schedule.js";

const baseSchedule = {
  id: "schedule-1",
  name: "Weekday warmup",
  enabled: true,
  providerConnectionIds: ["conn-b", "conn-a", "conn-a"],
  days: [1, 3, 5],
  times: ["5", "10:00", "05:00"],
  prompt: "ping",
  timezone: "Asia/Ho_Chi_Minh",
};

test("normalizes provider ids, days, and hourly times", () => {
  const schedule = normalizeWarmupSchedule(baseSchedule);
  assert.deepEqual(schedule.providerConnectionIds, ["conn-b", "conn-a"]);
  assert.deepEqual(schedule.days, [1, 3, 5]);
  assert.deepEqual(schedule.times, ["05:00", "10:00"]);
});

test("rejects enabled schedule without selected providers", () => {
  const result = validateWarmupSchedules([{ ...baseSchedule, providerConnectionIds: [] }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /select at least one provider account/);
});

test("rejects non-hourly time values", () => {
  const result = validateWarmupSchedules([{ ...baseSchedule, times: ["10:30"] }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /select at least one time/);
});

test("finds one due item per selected provider account", () => {
  const now = new Date("2026-04-27T22:00:00.000Z");
  const due = findDueWarmupRuns([{ ...baseSchedule, days: [2], times: ["05:00"] }], now);
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((item) => item.providerConnectionId), ["conn-b", "conn-a"]);
  assert.equal(due[0].localDate, "2026-04-28");
  assert.equal(due[0].localTime, "05:00");
  assert.equal(due[0].timezone, "Asia/Ho_Chi_Minh");
});

test("skips disabled schedules", () => {
  const now = new Date("2026-04-27T22:00:00.000Z");
  const due = findDueWarmupRuns([{ ...baseSchedule, enabled: false, days: [2], times: ["05:00"] }], now);
  assert.equal(due.length, 0);
});

test("builds stable dedupe key", () => {
  assert.equal(buildDedupeKey("s1", "c1", "2026-04-28", "05:00"), "s1:c1:2026-04-28:05:00");
});

test("preview returns account-counted due items", () => {
  const now = new Date("2026-04-27T21:00:00.000Z");
  const preview = buildWarmupPreview([{ ...baseSchedule, days: [2], times: ["05:00"] }], now);
  assert.ok(preview.length >= 1);
  assert.equal(preview[0].providerConnectionIds.length, 2);
});

test("trims run history newest first", () => {
  const runs = trimWarmupRuns([
    { id: "old", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "new", createdAt: "2026-01-02T00:00:00.000Z" },
  ], 1);
  assert.deepEqual(runs.map((run) => run.id), ["new"]);
});

test("matches schedule when tick lands off the top of the hour", () => {
  // Scheduler interval ticks every 60s but drifts off :00. Bug: localTime
  // included the real minute, so HH:00 schedules never matched.
  const now = new Date("2026-04-27T22:23:45.000Z"); // 05:23 Asia/Ho_Chi_Minh
  const due = findDueWarmupRuns([{ ...baseSchedule, days: [2], times: ["05:00"] }], now);
  assert.equal(due.length, 2);
  assert.equal(due[0].localTime, "05:00");
});

// ── findDueWarmupRunsInRange ───────────────────────────────────────────

test("findDueWarmupRunsInRange yields entries per HH:00 in range", () => {
  // Tuesday 2026-04-28 05:00 / 06:00 / 07:00 Asia/Ho_Chi_Minh = 22:00 / 23:00 / 00:00 UTC
  const schedule = { ...baseSchedule, days: [2], times: ["05:00", "06:00", "07:00"], providerConnectionIds: ["c-a", "c-b"] };
  const from = new Date("2026-04-27T21:30:00.000Z");
  const to = new Date("2026-04-28T00:30:00.000Z");
  const due = findDueWarmupRunsInRange([schedule], from, to);
  assert.equal(due.length, 6); // 3 slots × 2 providers
  // Sorted ascending by scheduledForUtc
  assert.equal(due[0].scheduledForUtc, "2026-04-27T22:00:00.000Z");
  assert.equal(due[due.length - 1].scheduledForUtc, "2026-04-28T00:00:00.000Z");
});

test("findDueWarmupRunsInRange returns [] when from > to", () => {
  const schedule = { ...baseSchedule, days: [2], times: ["05:00"] };
  const due = findDueWarmupRunsInRange([schedule], new Date("2026-04-28T01:00:00.000Z"), new Date("2026-04-27T22:00:00.000Z"));
  assert.deepEqual(due, []);
});

test("findDueWarmupRunsInRange from===to at :00 equals real-time findDueWarmupRuns", () => {
  const schedule = { ...baseSchedule, days: [2], times: ["05:00"] };
  const at = new Date("2026-04-27T22:00:00.000Z");
  const range = findDueWarmupRunsInRange([schedule], at, at);
  const single = findDueWarmupRuns([schedule], at);
  assert.equal(range.length, single.length);
  assert.deepEqual(range.map((r) => r.dedupeKey).sort(), single.map((r) => r.dedupeKey).sort());
});

test("findDueWarmupRunsInRange from===to non-:00 yields []", () => {
  const schedule = { ...baseSchedule, days: [2], times: ["05:00"] };
  const at = new Date("2026-04-27T22:23:45.000Z");
  const due = findDueWarmupRunsInRange([schedule], at, at);
  assert.deepEqual(due, []);
});

test("findDueWarmupRunsInRange spans local day boundary", () => {
  // Asia/Ho_Chi_Minh UTC+7. Local midnight = 17:00 UTC prior day.
  // Window 16:00 UTC mon → 19:00 UTC mon = 23:00 mon local → 02:00 tue local.
  const schedule = {
    ...baseSchedule,
    timezone: "Asia/Ho_Chi_Minh",
    days: [1, 2], // Mon, Tue
    times: ["23:00", "00:00", "01:00", "02:00"],
    providerConnectionIds: ["c-x"],
  };
  const from = new Date("2026-04-27T15:30:00.000Z");
  const to = new Date("2026-04-27T19:30:00.000Z");
  const due = findDueWarmupRunsInRange([schedule], from, to);
  const dates = new Set(due.map((d) => d.localDate));
  assert.ok(dates.size >= 2, `expected entries across ≥2 local dates, got ${[...dates]}`);
});

test("findDueWarmupRunsInRange covers Kolkata 09:00 via UTC :00 iteration", () => {
  // Asia/Kolkata = UTC+5:30. Local 09:00 IST = 03:30 UTC.
  // UTC :00 boundary at 04:00 projects to 09:30 IST. getLocalSlot floors minute → localTime "09:00".
  // So an HH:00 schedule at "09:00" Kolkata matches the 04:00 UTC slot.
  const schedule = {
    ...baseSchedule,
    timezone: "Asia/Kolkata",
    days: [0, 1, 2, 3, 4, 5, 6],
    times: ["09:00"],
    providerConnectionIds: ["c-k"],
  };
  const from = new Date("2026-04-27T03:00:00.000Z");
  const to = new Date("2026-04-27T05:00:00.000Z");
  const due = findDueWarmupRunsInRange([schedule], from, to);
  assert.equal(due.length, 1);
  assert.equal(due[0].scheduledForUtc, "2026-04-27T04:00:00.000Z");
  assert.equal(due[0].localTime, "09:00");
});
