import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDedupeKey,
  buildWarmupPreview,
  ceilToMinute,
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

test("normalizes provider ids, days, and clock times", () => {
  const schedule = normalizeWarmupSchedule(baseSchedule);
  assert.deepEqual(schedule.providerConnectionIds, ["conn-b", "conn-a"]);
  assert.deepEqual(schedule.days, [1, 3, 5]);
  assert.deepEqual(schedule.times, ["05:00", "10:00"]);
});

test("normalizes HH:MM (minute-level) times", () => {
  const schedule = normalizeWarmupSchedule({
    ...baseSchedule,
    times: ["09:30", "09:00", "23:59", "9:5"],
  });
  // "9:5" → null (minute must be 2 digits); others kept, sorted.
  assert.deepEqual(schedule.times, ["09:00", "09:30", "23:59"]);
});

test("rejects enabled schedule without selected providers", () => {
  const result = validateWarmupSchedules([{ ...baseSchedule, providerConnectionIds: [] }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /select at least one provider account/);
});

test("rejects invalid HH:MM time values", () => {
  const result = validateWarmupSchedules([{ ...baseSchedule, times: ["25:00"] }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /select at least one time|HH:MM/);
});

test("accepts HH:MM time values", () => {
  const result = validateWarmupSchedules([{ ...baseSchedule, times: ["09:30", "14:45"] }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.schedules[0].times, ["09:30", "14:45"]);
});

test("finds one due item per selected provider account at minute boundary", () => {
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
  assert.equal(buildDedupeKey("s1", "c1", "2026-04-28", "05:30"), "s1:c1:2026-04-28:05:30");
});

test("preview returns account-counted due items", () => {
  const now = new Date("2026-04-27T21:00:00.000Z");
  const preview = buildWarmupPreview([{ ...baseSchedule, days: [2], times: ["05:00"] }], now);
  assert.ok(preview.length >= 1);
  assert.equal(preview[0].providerConnectionIds.length, 2);
});

test("preview surfaces minute-level slot HH:MM", () => {
  // Tuesday 2026-04-28 05:15 Asia/Ho_Chi_Minh = 22:15 UTC Mon
  const now = new Date("2026-04-27T21:00:00.000Z");
  const preview = buildWarmupPreview([
    { ...baseSchedule, days: [2], times: ["05:15"], providerConnectionIds: ["c-x"] },
  ], now);
  const hit = preview.find((entry) => entry.localTime === "05:15");
  assert.ok(hit, `expected 05:15 entry, got ${JSON.stringify(preview)}`);
  assert.equal(hit.scheduledForUtc, "2026-04-27T22:15:00.000Z");
});

test("trims run history newest first", () => {
  const runs = trimWarmupRuns([
    { id: "old", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "new", createdAt: "2026-01-02T00:00:00.000Z" },
  ], 1);
  assert.deepEqual(runs.map((run) => run.id), ["new"]);
});

test("off-second tick at HH:MM matches HH:MM schedule", () => {
  // Tick at 22:23:45 UTC = 05:23 Asia/Ho_Chi_Minh. Schedule HH:23 matches.
  const now = new Date("2026-04-27T22:23:45.000Z");
  const due = findDueWarmupRuns([
    { ...baseSchedule, days: [2], times: ["05:23"] },
  ], now);
  assert.equal(due.length, 2);
  assert.equal(due[0].localTime, "05:23");
});

test("off-second tick at HH:MM does NOT match foreign minute schedule", () => {
  // Tick at 22:23:45 UTC = 05:23 Asia/Ho_Chi_Minh. Schedule 05:00 must not fire.
  const now = new Date("2026-04-27T22:23:45.000Z");
  const due = findDueWarmupRuns([
    { ...baseSchedule, days: [2], times: ["05:00"] },
  ], now);
  assert.equal(due.length, 0);
});

// ── ceilToMinute ───────────────────────────────────────────

test("ceilToMinute rounds up to next minute boundary", () => {
  assert.equal(ceilToMinute(new Date("2026-04-27T22:23:45.123Z")).toISOString(), "2026-04-27T22:24:00.000Z");
  assert.equal(ceilToMinute(new Date("2026-04-27T22:23:00.000Z")).toISOString(), "2026-04-27T22:23:00.000Z");
  assert.equal(ceilToMinute(new Date("2026-04-27T22:23:00.500Z")).toISOString(), "2026-04-27T22:24:00.000Z");
});

// ── findDueWarmupRunsInRange ───────────────────────────────────────────

test("findDueWarmupRunsInRange yields entries per HH:MM slot in range", () => {
  // Tuesday 2026-04-28 Asia/Ho_Chi_Minh
  //   05:00 / 06:00 / 07:00 local = 22:00 / 23:00 / 00:00 UTC
  const schedule = {
    ...baseSchedule,
    days: [2],
    times: ["05:00", "06:00", "07:00"],
    providerConnectionIds: ["c-a", "c-b"],
  };
  const from = new Date("2026-04-27T21:30:00.000Z");
  const to = new Date("2026-04-28T00:30:00.000Z");
  const due = findDueWarmupRunsInRange([schedule], from, to);
  assert.equal(due.length, 6); // 3 slots × 2 providers
  assert.equal(due[0].scheduledForUtc, "2026-04-27T22:00:00.000Z");
  assert.equal(due[due.length - 1].scheduledForUtc, "2026-04-28T00:00:00.000Z");
});

test("findDueWarmupRunsInRange supports minute-level HH:MM", () => {
  // 2026-04-28 05:23 Asia/Ho_Chi_Minh = 22:23 UTC Mon
  const schedule = {
    ...baseSchedule,
    days: [2],
    times: ["05:23"],
    providerConnectionIds: ["c-a"],
  };
  const from = new Date("2026-04-27T22:00:00.000Z");
  const to = new Date("2026-04-27T22:59:00.000Z");
  const due = findDueWarmupRunsInRange([schedule], from, to);
  assert.equal(due.length, 1);
  assert.equal(due[0].scheduledForUtc, "2026-04-27T22:23:00.000Z");
  assert.equal(due[0].localTime, "05:23");
});

test("findDueWarmupRunsInRange returns [] when from > to", () => {
  const schedule = { ...baseSchedule, days: [2], times: ["05:00"] };
  const due = findDueWarmupRunsInRange(
    [schedule],
    new Date("2026-04-28T01:00:00.000Z"),
    new Date("2026-04-27T22:00:00.000Z"),
  );
  assert.deepEqual(due, []);
});

test("findDueWarmupRunsInRange from===to at minute boundary equals real-time findDueWarmupRuns", () => {
  const schedule = { ...baseSchedule, days: [2], times: ["05:00"] };
  const at = new Date("2026-04-27T22:00:00.000Z");
  const range = findDueWarmupRunsInRange([schedule], at, at);
  const single = findDueWarmupRuns([schedule], at);
  assert.equal(range.length, single.length);
  assert.deepEqual(range.map((r) => r.dedupeKey).sort(), single.map((r) => r.dedupeKey).sort());
});

test("findDueWarmupRunsInRange from===to mid-minute yields []", () => {
  // No minute boundary inside [22:23:45, 22:23:45]
  const schedule = { ...baseSchedule, days: [2], times: ["05:23"] };
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
    days: [1, 2],
    times: ["23:00", "00:00", "01:00", "02:00"],
    providerConnectionIds: ["c-x"],
  };
  const from = new Date("2026-04-27T15:30:00.000Z");
  const to = new Date("2026-04-27T19:30:00.000Z");
  const due = findDueWarmupRunsInRange([schedule], from, to);
  const dates = new Set(due.map((d) => d.localDate));
  assert.ok(dates.size >= 2, `expected entries across ≥2 local dates, got ${[...dates]}`);
});

test("findDueWarmupRunsInRange covers Kolkata 09:30 via UTC :00 iteration", () => {
  // Asia/Kolkata = UTC+5:30. Local 09:30 IST = 04:00 UTC.
  const schedule = {
    ...baseSchedule,
    timezone: "Asia/Kolkata",
    days: [0, 1, 2, 3, 4, 5, 6],
    times: ["09:30"],
    providerConnectionIds: ["c-k"],
  };
  const from = new Date("2026-04-27T03:30:00.000Z");
  const to = new Date("2026-04-27T05:00:00.000Z");
  const due = findDueWarmupRunsInRange([schedule], from, to);
  assert.equal(due.length, 1);
  assert.equal(due[0].scheduledForUtc, "2026-04-27T04:00:00.000Z");
  assert.equal(due[0].localTime, "09:30");
});

test("findDueWarmupRunsInRange dedupes if same slot crossed by ranges", () => {
  // Slot 22:00 UTC Mon, range covers it once.
  const schedule = {
    ...baseSchedule,
    days: [2],
    times: ["05:00"],
    providerConnectionIds: ["c-only"],
  };
  const from = new Date("2026-04-27T21:30:00.000Z");
  const to = new Date("2026-04-27T22:00:30.000Z");
  const due = findDueWarmupRunsInRange([schedule], from, to);
  assert.equal(due.length, 1);
});
