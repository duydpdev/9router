import {
  getProviderConnections,
  getWarmupSchedulesFromDb,
  saveWarmupSchedulesToDb,
  insertWarmupRun,
  hasSuccessfulWarmupRunFromDb,
  getWarmupRunsPageFromDb,
  sweepWarmupRunsRetentionInDb,
} from "@/lib/localDb";
import {
  buildWarmupPreview,
  normalizeWarmupSchedules,
  validateWarmupSchedules,
} from "@/lib/warmup/schedule";

const WARMUP_RUNS_RETENTION = 1000;

export async function getWarmupState() {
  const schedules = await getWarmupSchedules();
  const providerOptions = await getWarmupProviderOptions();
  return {
    schedules,
    providerOptions,
  };
}

export async function getWarmupPreview(days = 7) {
  const schedules = await getWarmupSchedules();
  return buildWarmupPreview(schedules, new Date(), days);
}

export async function getWarmupRunsPage({ limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 5), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const { total, rows } = await getWarmupRunsPageFromDb({ limit: safeLimit, offset: safeOffset });
  return {
    runs: rows,
    total,
    limit: safeLimit,
    offset: safeOffset,
    hasMore: safeOffset + safeLimit < total,
  };
}

export async function saveWarmupSchedules(input) {
  const validation = validateWarmupSchedules(input);
  if (!validation.ok) {
    const error = new Error(validation.error);
    error.statusCode = 400;
    throw error;
  }

  await saveWarmupSchedulesToDb(validation.schedules);
  return getWarmupState();
}

export async function getWarmupSchedules() {
  const raw = await getWarmupSchedulesFromDb();
  const schedules = normalizeWarmupSchedules(raw || []);

  // Self-heal: prune providerConnectionIds that no longer match any row in
  // providerConnections. Covers orphans created before the cascade fix in
  // deleteProviderConnection (or via any path that bypassed it). Idempotent:
  // a clean read does no writes. If the providerConnections lookup fails, we
  // return un-pruned data so a transient DB error doesn't corrupt schedules.
  let knownIds;
  try {
    const allConnections = await getProviderConnections();
    knownIds = new Set(allConnections.map((c) => c.id));
  } catch {
    return schedules;
  }
  let mutated = false;
  const pruned = schedules.map((s) => {
    const before = s.providerConnectionIds.length;
    const next = s.providerConnectionIds.filter((cid) => knownIds.has(cid));
    if (next.length !== before) mutated = true;
    return next.length === before ? s : { ...s, providerConnectionIds: next };
  });
  if (mutated) {
    try {
      await saveWarmupSchedulesToDb(pruned);
    } catch {
      // Persist failed — caller still gets the in-memory pruned view this call.
    }
  }
  return pruned;
}

export async function appendWarmupRun(run) {
  const nextRun = {
    id: run.id || crypto.randomUUID(),
    scheduleId: run.scheduleId,
    providerConnectionId: run.providerConnectionId,
    scheduledForUtc: run.scheduledForUtc,
    actualRanAt: run.actualRanAt || new Date().toISOString(),
    localDate: run.localDate,
    localTime: run.localTime,
    timezone: run.timezone,
    dedupeKey: run.dedupeKey,
    status: run.status,
    error: run.error || null,
    createdAt: run.createdAt || new Date().toISOString(),
  };
  await insertWarmupRun(nextRun);
  return nextRun;
}

export async function hasWarmupRun(dedupeKey) {
  return hasSuccessfulWarmupRunFromDb(dedupeKey);
}

export async function sweepWarmupRunsRetention(maxRows = WARMUP_RUNS_RETENTION) {
  return sweepWarmupRunsRetentionInDb(maxRows);
}

// ── lastTickAt (Phase 4) ───────────────────────────────────────────────
// Defined here so scheduler can persist tick boundary via existing kv helper.
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const warmupKv = makeKv("warmup");
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function getWarmupLastTickAt() {
  const raw = await warmupKv.get("lastTickAt", null);
  if (typeof raw !== "string" || !ISO_RE.test(raw)) return null;
  return raw;
}

export async function setWarmupLastTickAt(value) {
  let iso;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("setWarmupLastTickAt: invalid Date");
    iso = value.toISOString();
  } else if (typeof value === "string" && ISO_RE.test(value)) {
    iso = value;
  } else {
    throw new TypeError(`setWarmupLastTickAt: expected Date or ISO string, got ${typeof value === "object" ? (value === null ? "null" : value.constructor?.name || "object") : typeof value}`);
  }
  const current = await warmupKv.get("lastTickAt", null);
  if (current && typeof current === "string" && current >= iso) return;
  await warmupKv.set("lastTickAt", iso);
}

export async function getWarmupProviderOptions() {
  const connections = await getProviderConnections({ isActive: true });
  return connections.map((connection) => ({
    id: connection.id,
    provider: connection.provider,
    name: connection.name || connection.displayName || connection.email || connection.provider,
    displayName: connection.displayName || connection.name || connection.email || connection.provider,
    defaultModel: connection.defaultModel || null,
    priority: connection.priority || connection.globalPriority || null,
    testStatus: connection.testStatus || (connection.isAvailable === false ? "unavailable" : "active"),
  }));
}
