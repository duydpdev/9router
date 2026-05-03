---
phase: 1
title: "Storage refactor: warmup_runs + warmup_dedupe tables"
status: pending
priority: P1
effort: "1.5h"
dependencies: []
---

# Phase 1: Storage refactor — warmup_runs + warmup_dedupe tables

## Overview

Prerequisite for catch-up. Today's `kv:warmup/runs` is a JSON blob rewritten on every append (O(n²)) and capped at 100 entries — which evicts dedupe keys mid-catch-up and re-fires successful slots. Replace with two relational tables:

- `warmup_runs` — full run record per row (history).
- `warmup_dedupe` — keyed by `dedupeKey`, with `status` ('success'|'failure') and `createdAt`. Dedupe truth lives here, independent of history pagination.

Adopts status-aware dedupe so failed runs retry on the next tick (within the open catch-up window) instead of being permanently marked done.

## Requirements

Functional:
- New tables `warmup_runs` and `warmup_dedupe` declared in `src/lib/db/schema.js TABLES`. `syncSchemaFromTables` auto-creates them on next boot (no migration version bump required — additive only).
- `appendWarmupRun(run)`:
  - Single `INSERT` into `warmup_runs` (O(1) write).
  - `INSERT INTO warmup_dedupe(dedupe_key, status, created_at) ON CONFLICT(dedupe_key) DO UPDATE SET status = excluded.status, created_at = excluded.created_at`.
  - Both writes inside `db.transaction(...)`.
- `hasWarmupRun(dedupeKey)` queries `warmup_dedupe` for `status='success'` (status-aware). Returns false for `status='failure'` so retry happens within the same catch-up window.
- `getWarmupRuns({ limit, offset })` paginates `warmup_runs ORDER BY created_at DESC`. No 100-entry cap on dedupe; optional retention cap on `warmup_runs` (default keep last 1000, configurable).
- One-shot migration: on first boot after upgrade, drain existing `kv:warmup/runs` JSON array into `warmup_runs` + `warmup_dedupe`, then delete the kv row. Idempotent (marker via `_meta.warmupRunsMigrated`).

Non-functional:
- Existing public surfaces (`getWarmupRunsPage`, `appendWarmupRun`, `hasWarmupRun`) keep their signatures so `runner.js`, `store.js`, `WarmupPageClient.js`, `/api/warmup/runs` don't need API changes.
- Tests use isolated `DATA_DIR` (see Phase 2 isolation pattern).

## Architecture

Schema additions:

```js
// src/lib/db/schema.js (additions to TABLES)
warmup_runs: {
  columns: {
    id: "TEXT PRIMARY KEY",
    schedule_id: "TEXT NOT NULL",
    provider_connection_id: "TEXT NOT NULL",
    scheduled_for_utc: "TEXT NOT NULL",   // slot boundary (catch-up) OR call time (real-time)
    actual_ran_at: "TEXT NOT NULL",       // wall clock when runner executed
    local_date: "TEXT NOT NULL",
    local_time: "TEXT NOT NULL",
    timezone: "TEXT NOT NULL",
    dedupe_key: "TEXT NOT NULL",
    status: "TEXT NOT NULL",              // 'success' | 'failure'
    error: "TEXT",
    created_at: "TEXT NOT NULL",
  },
  indexes: [
    "CREATE INDEX IF NOT EXISTS idx_warmup_runs_created ON warmup_runs(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_warmup_runs_dedupe ON warmup_runs(dedupe_key)",
  ],
},
warmup_dedupe: {
  columns: {
    dedupe_key: "TEXT PRIMARY KEY",
    status: "TEXT NOT NULL",              // 'success' | 'failure'
    created_at: "TEXT NOT NULL",
  },
},
```

Repo rewrite (`src/lib/db/repos/warmupRepo.js`):

```js
import { getAdapter } from "../driver.js";
import { getMetaSync, setMetaSync } from "../helpers/metaStore.js";
import { parseJson } from "../helpers/jsonCol.js";

// ── runs (per-row) ──────────────────────────────────────────────
export async function insertWarmupRun(run) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(
      `INSERT INTO warmup_runs(id, schedule_id, provider_connection_id, scheduled_for_utc, actual_ran_at, local_date, local_time, timezone, dedupe_key, status, error, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [run.id, run.scheduleId, run.providerConnectionId, run.scheduledForUtc, run.actualRanAt, run.localDate, run.localTime, run.timezone, run.dedupeKey, run.status, run.error || null, run.createdAt]
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
  const row = db.get(`SELECT 1 FROM warmup_dedupe WHERE dedupe_key = ? AND status = 'success'`, [dedupeKey]);
  return !!row;
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
  };
}
```

One-shot migration helper (called from `runMigrationOnce` after schema sync, or via lazy fn invoked on first repo call — idempotent):

```js
export async function migrateLegacyWarmupRunsOnce() {
  const db = await getAdapter();
  if (getMetaSync(db, "warmupRunsMigrated", "0") === "1") return;
  const row = db.get(`SELECT value FROM kv WHERE scope='warmup' AND key='runs'`);
  if (row) {
    const legacy = parseJson(row.value, []);
    db.transaction(() => {
      for (const r of legacy) {
        db.run(`INSERT OR IGNORE INTO warmup_runs(...) VALUES(...)`, [...]);
        db.run(`INSERT OR IGNORE INTO warmup_dedupe(...) VALUES(...)`, [r.dedupeKey, r.status || "success", r.createdAt]);
      }
      db.run(`DELETE FROM kv WHERE scope='warmup' AND key='runs'`);
    });
  }
  setMetaSync(db, "warmupRunsMigrated", "1");
}
```

Store-layer wrapper changes (`src/lib/warmup/store.js`):

```js
export async function appendWarmupRun(run) {
  const nextRun = { ...defaults, ...run, id: run.id || crypto.randomUUID(), createdAt: run.createdAt || new Date().toISOString() };
  await insertWarmupRun(nextRun);
  return nextRun;
}

export async function hasWarmupRun(dedupeKey) {
  return hasSuccessfulWarmupRunFromDb(dedupeKey); // status-aware
}

export async function getWarmupRunsPage({ limit, offset }) {
  return getWarmupRunsPageFromDb({ limit, offset });
}
```

Drop `trimWarmupRuns` from hot path.

<!-- Updated: Validation Session 1 — retention policy decided -->

**Retention (V1):** Hard cap at 1000 rows. A separate `setInterval(10 * 60 * 1000)` in `scheduler.js` (registered alongside the warmup interval, `.unref()`-able) runs:

```sql
DELETE FROM warmup_runs WHERE id NOT IN (SELECT id FROM warmup_runs ORDER BY created_at DESC LIMIT 1000);
```

Sweep is idempotent; running it more often is safe. Periodic (not per-insert) keeps the insert hot path O(1).

Helper exposed by repo + re-exported via `store.js`:

```js
// warmupRepo.js
export async function sweepWarmupRunsRetentionInDb(maxRows = 1000) {
  const db = await getAdapter();
  db.run(`DELETE FROM warmup_runs WHERE id NOT IN (SELECT id FROM warmup_runs ORDER BY created_at DESC LIMIT ?)`, [maxRows]);
}

// store.js
export async function sweepWarmupRunsRetention() {
  return sweepWarmupRunsRetentionInDb(1000);
}
```

## Related Code Files

- Create: tests for new repo (see Phase 2 — isolated DATA_DIR test infra reused).
- Modify: `src/lib/db/schema.js` (add TABLES.warmup_runs, TABLES.warmup_dedupe).
- Modify: `src/lib/db/repos/warmupRepo.js` (rewrite; drop `appendWarmupRunToDb` / `getWarmupRunsFromDb` JSON blob fns OR keep as legacy migration helpers).
- Modify: `src/lib/db/index.js` exports.
- Modify: `src/lib/localDb.js` re-exports.
- Modify: `src/lib/warmup/store.js` — `appendWarmupRun` calls `insertWarmupRun`; `hasWarmupRun` calls status-aware fn; `getWarmupRunsPage` paginates from DB.
- Modify: `src/lib/warmup/runner.js` — pass `actualRanAt: new Date().toISOString()` into `appendWarmupRun` (decouple from `scheduledForUtc`).
- Modify: `src/lib/warmup/schedule.js` — drop `MAX_RUN_HISTORY` constant if unused, OR keep for legacy display cap.

## Implementation Steps

1. Add `warmup_runs` and `warmup_dedupe` to `TABLES` in `schema.js`.
2. Rewrite `warmupRepo.js` with `insertWarmupRun`, `hasSuccessfulWarmupRunFromDb`, `getWarmupRunsPageFromDb`.
3. Keep old `appendWarmupRunToDb`/`getWarmupRunsFromDb` exports as legacy-read-only used by migration only.
4. Implement `migrateLegacyWarmupRunsOnce` and call it from `runMigrationOnce` after `syncSchemaFromTables`.
5. Rewrite `store.js#appendWarmupRun` and `store.js#hasWarmupRun`.
6. Update `runner.js` to pass `actualRanAt`.
7. Verify `WarmupPageClient.js` and `/api/warmup/runs` still work via existing pagination contract.

## Success Criteria

- [ ] On a fresh DB, both tables auto-create via `syncSchemaFromTables`.
- [ ] On a DB with legacy `kv:warmup/runs`, migration drains entries and deletes the kv row; second boot is a no-op.
- [ ] `appendWarmupRun` does O(1) writes (no full-array rewrite).
- [ ] `hasWarmupRun(key)` returns true iff a `success` row exists in `warmup_dedupe` (failed rows do NOT block retry).
- [ ] Existing run history UI still renders.
- [ ] All tests pass on isolated DATA_DIR.

## Risk Assessment

- Risk: schema sync race during initial tick (Finding 8). Mitigated by Phase 5 await-init.
- Risk: legacy migration row-count > expected (corrupted JSON). Mitigation: wrap in try/catch; on failure keep kv row and log; do NOT set the marker so a fixed deploy retries.
- Risk: retention sweep deletes rows mid-`getWarmupRunsPage` query. Mitigation: defer retention to a separate periodic task, not inline with each insert.
