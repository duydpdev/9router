// scheduledForUtc semantics:
//   - Real-time tick: equals the cursor instant passed to findDueWarmupRuns.
//   - Catch-up via findDueWarmupRunsInRange: equals the slot boundary (HH:00 UTC).
//   It is a SLOT IDENTIFIER, not wall-clock execution time. The runner records
//   actual execution wall-clock as `actualRanAt`.

const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";
const DAY_VALUES = new Set([0, 1, 2, 3, 4, 5, 6]);
const MAX_PREVIEW_DAYS = 7;
const MAX_RUN_HISTORY = 100;

export function createDefaultWarmupSchedule() {
  return {
    id: crypto.randomUUID(),
    name: "New warmup schedule",
    enabled: true,
    providerConnectionIds: [],
    days: [1, 2, 3, 4, 5],
    times: ["09:00"],
    prompt: "Quick warmup ping. Reply ok.",
    timezone: DEFAULT_TIMEZONE,
  };
}

export function normalizeWarmupSchedule(input) {
  const schedule = input && typeof input === "object" ? input : {};
  return {
    id: String(schedule.id || crypto.randomUUID()),
    name: String(schedule.name || "").trim(),
    enabled: schedule.enabled !== false,
    providerConnectionIds: normalizeProviderIds(schedule.providerConnectionIds),
    days: normalizeDays(schedule.days),
    times: normalizeTimes(schedule.times),
    prompt: String(schedule.prompt || "Quick warmup ping. Reply ok.").trim(),
    timezone: String(schedule.timezone || DEFAULT_TIMEZONE).trim(),
  };
}

export function normalizeWarmupSchedules(input) {
  return (Array.isArray(input) ? input : []).map(normalizeWarmupSchedule);
}

export function validateWarmupSchedules(input) {
  const original = Array.isArray(input) ? input : [];
  const normalized = normalizeWarmupSchedules(original);

  for (let index = 0; index < normalized.length; index += 1) {
    const schedule = normalized[index];
    const raw = original[index] || {};
    if (!schedule.name) return { ok: false, error: "Schedule name is required" };
    if (!schedule.timezone) return { ok: false, error: "Timezone is required" };
    if (!isValidTimezone(schedule.timezone)) return { ok: false, error: `Invalid timezone: ${schedule.timezone}` };
    if (!schedule.days.length) return { ok: false, error: `${schedule.name}: select at least one day` };
    if (!schedule.times.length) return { ok: false, error: `${schedule.name}: select at least one time` };
    if (hasInvalidRawTime(raw.times)) return { ok: false, error: `${schedule.name}: times must use HH:00` };
    if (schedule.enabled && !schedule.providerConnectionIds.length) {
      return { ok: false, error: `${schedule.name}: select at least one provider account` };
    }
  }

  return { ok: true, schedules: normalized };
}

export function findDueWarmupRuns(schedules, now = new Date()) {
  const due = [];
  for (const schedule of normalizeWarmupSchedules(schedules)) {
    if (!schedule.enabled) continue;
    const slot = getLocalSlot(now, schedule.timezone);
    if (!schedule.days.includes(slot.day)) continue;
    if (!schedule.times.includes(slot.localTime)) continue;
    for (const providerConnectionId of schedule.providerConnectionIds) {
      due.push({
        schedule,
        providerConnectionId,
        scheduledForUtc: now.toISOString(),
        localDate: slot.localDate,
        localTime: slot.localTime,
        timezone: schedule.timezone,
        dedupeKey: buildDedupeKey(schedule.id, providerConnectionId, slot.localDate, slot.localTime),
      });
    }
  }
  return due;
}

export function ceilToHour(input) {
  const d = new Date(input);
  if (d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) return d;
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

export function findDueWarmupRunsInRange(schedules, from, to) {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (fromDate > toDate) return [];
  const results = [];
  for (
    let cursor = ceilToHour(fromDate);
    cursor <= toDate;
    cursor = new Date(cursor.getTime() + 3600 * 1000)
  ) {
    results.push(...findDueWarmupRuns(schedules, cursor));
  }
  results.sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc));
  return results;
}

export function buildWarmupPreview(schedules, now = new Date(), days = MAX_PREVIEW_DAYS) {
  const preview = [];
  const cursor = ceilToHour(now);
  const hoursToScan = days * 24;
  for (let step = 0; step <= hoursToScan; step += 1) {
    const candidate = new Date(cursor.getTime() + step * 60 * 60 * 1000);
    for (const item of findDueWarmupRuns(schedules, candidate)) {
      const existing = preview.find((entry) => (
        entry.scheduleId === item.schedule.id &&
        entry.localDate === item.localDate &&
        entry.localTime === item.localTime
      ));
      if (existing) continue;
      preview.push({
        scheduleId: item.schedule.id,
        name: item.schedule.name,
        providerConnectionIds: item.schedule.providerConnectionIds,
        scheduledForUtc: item.scheduledForUtc,
        localDate: item.localDate,
        localTime: item.localTime,
        timezone: item.timezone,
      });
    }
  }

  return preview.slice(0, 50);
}

export function trimWarmupRuns(runs, max = MAX_RUN_HISTORY) {
  return [...(Array.isArray(runs) ? runs : [])]
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
    .slice(0, max);
}

export function buildDedupeKey(scheduleId, providerConnectionId, localDate, localTime) {
  return `${scheduleId}:${providerConnectionId}:${localDate}:${localTime}`;
}

// Defensive: drop providerConnectionIds that don't appear in knownIds. Used by
// the scheduler tick so orphans (deleted connections still referenced in a
// schedule) can't trigger fan-outs that throw "Provider connection not found".
export function pruneOrphanProviderIds(schedules, knownIds) {
  if (!Array.isArray(schedules)) return [];
  const ids = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  return schedules.map((s) => ({
    ...s,
    providerConnectionIds: Array.isArray(s?.providerConnectionIds)
      ? s.providerConnectionIds.filter((cid) => ids.has(cid))
      : [],
  }));
}

function normalizeProviderIds(value) {
  return Array.from(new Set(
    Array.isArray(value) ? value.map((id) => String(id).trim()).filter(Boolean) : []
  ));
}

function normalizeDays(value) {
  return Array.from(new Set(
    Array.isArray(value) ? value.map((day) => Number(day)) : []
  )).filter((day) => DAY_VALUES.has(day)).sort((left, right) => left - right);
}

function normalizeTimes(value) {
  return Array.from(new Set(
    Array.isArray(value) ? value.map(normalizeHourlyTime).filter(Boolean) : []
  )).sort((left, right) => left.localeCompare(right));
}

function normalizeHourlyTime(value) {
  const text = String(value || "").trim();
  const hourOnly = text.match(/^(\d{1,2})$/);
  if (hourOnly) {
    const hour = Number(hourOnly[1]);
    if (hour >= 0 && hour <= 23) return `${String(hour).padStart(2, "0")}:00`;
    return null;
  }
  const match = text.match(/^(\d{1,2}):00$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:00`;
}

function hasInvalidRawTime(value) {
  if (!Array.isArray(value)) return false;
  return value.some((time) => !normalizeHourlyTime(time));
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getLocalSlot(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    day: weekdayMap[map.weekday],
    localDate: `${map.year}-${map.month}-${map.day}`,
    localTime: `${map.hour}:00`,
  };
}
