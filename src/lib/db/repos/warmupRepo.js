import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "warmup";
const KEY_SCHEDULES = "schedules";
const KEY_RUNS = "runs"; // legacy

// ── schedules (kv) ─────────────────────────────────────────────────────
export async function getWarmupSchedulesFromDb() {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, KEY_SCHEDULES]);
  return row ? parseJson(row.value, []) : [];
}

export async function saveWarmupSchedulesToDb(schedules) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, KEY_SCHEDULES, stringifyJson(schedules)]
  );
}

// ── runs (per-row) ─────────────────────────────────────────────────────
export async function insertWarmupRun(run) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(
      // New session columns are appended at the END of both the column list
      // and the bindings array, in identical order — keep them in lockstep.
      `INSERT INTO warmup_runs(id, schedule_id, provider_connection_id, scheduled_for_utc, actual_ran_at, local_date, local_time, timezone, dedupe_key, status, error, created_at, resets_at, utilization, session_state) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.scheduleId,
        run.providerConnectionId,
        run.scheduledForUtc,
        run.actualRanAt,
        run.localDate,
        run.localTime,
        run.timezone,
        run.dedupeKey,
        run.status,
        run.error || null,
        run.createdAt,
        run.resetsAt ?? null,
        run.utilization ?? null,
        run.sessionState ?? "n/a",
      ]
    );
    db.run(
      `INSERT INTO warmup_dedupe(dedupe_key, status, created_at) VALUES(?, ?, ?) ON CONFLICT(dedupe_key) DO UPDATE SET status = excluded.status, created_at = excluded.created_at`,
      [run.dedupeKey, run.status, run.createdAt]
    );
  });
}

export async function getWarmupRunsPageFromDb({ limit = 20, offset = 0 } = {}) {
  const db = await getAdapter();
  const total = db.get(`SELECT COUNT(*) AS c FROM warmup_runs`)?.c ?? 0;
  const rows = db.all(
    `SELECT * FROM warmup_runs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return { total, rows: rows.map(rowToRun) };
}

export async function hasSuccessfulWarmupRunFromDb(dedupeKey) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT 1 FROM warmup_dedupe WHERE dedupe_key = ? AND status = 'success'`,
    [dedupeKey]
  );
  return !!row;
}

export async function sweepWarmupRunsRetentionInDb(maxRows = 1000) {
  const db = await getAdapter();
  db.run(
    `DELETE FROM warmup_runs WHERE id NOT IN (SELECT id FROM warmup_runs ORDER BY created_at DESC LIMIT ?)`,
    [maxRows]
  );
}

function rowToRun(r) {
  return {
    id: r.id,
    scheduleId: r.schedule_id,
    providerConnectionId: r.provider_connection_id,
    scheduledForUtc: r.scheduled_for_utc,
    actualRanAt: r.actual_ran_at,
    localDate: r.local_date,
    localTime: r.local_time,
    timezone: r.timezone,
    dedupeKey: r.dedupe_key,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    resetsAt: r.resets_at,
    utilization: r.utilization,
    sessionState: r.session_state,
  };
}

// ── legacy read (migration only) ───────────────────────────────────────
export async function getWarmupRunsFromDb() {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, KEY_RUNS]);
  return row ? parseJson(row.value, []) : [];
}

export async function appendWarmupRunToDb(runs) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, KEY_RUNS, stringifyJson(runs)]
  );
}
