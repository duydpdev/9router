import { getProviderConnections } from "@/lib/localDb";
import { findDueWarmupRunsInRange, pruneOrphanProviderIds } from "@/lib/warmup/schedule";
import {
  getWarmupSchedules,
  getWarmupLastTickAt,
  setWarmupLastTickAt,
  sweepWarmupRunsRetention,
} from "@/lib/warmup/store";

// runner is dynamically imported only when due items exist — keeps the
// scheduler module light and avoids pulling SSE handlers when nothing is due.
async function loadRunner() {
  return import("@/lib/warmup/runner");
}

// red-team #12: notifier stays lazy so it never loads in non-scheduler paths.
async function loadNotifier() {
  return import("@/lib/warmup/notifier");
}

export const MAX_CATCHUP_HOURS = 6;
const CHECK_INTERVAL_MS = 60 * 1000;
const RETENTION_SWEEP_MS = 10 * 60 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const g = (global.__warmupScheduler ??= {
  interval: null,
  retentionInterval: null,
  running: false,
  lastTickAt: null,
  lastResult: null,
  lastClampedFrom: null,
  bootLogged: false,
});

export async function startWarmupScheduler() {
  if (g.interval) return;

  // red-team #11: boot log must precede the initial tick so its line is the
  // first warmup-notifier entry in stdout even when catch-up replay emits
  // many `event:"sent"` lines.
  if (!g.bootLogged) {
    g.bootLogged = true;
    try {
      const { logBootStatus } = await loadNotifier();
      logBootStatus();
    } catch (error) {
      console.log("[WarmupScheduler] notifier boot log failed:", error.message);
    }
  }

  try {
    await tickWarmupScheduler();
  } catch (error) {
    console.log("[WarmupScheduler] initial tick failed:", error.message);
  }
  g.interval = setInterval(() => {
    tickWarmupScheduler().catch((error) => {
      console.log("[WarmupScheduler] tick failed:", error.message);
    });
  }, CHECK_INTERVAL_MS);
  if (g.interval.unref) g.interval.unref();

  if (!g.retentionInterval) {
    g.retentionInterval = setInterval(() => {
      sweepWarmupRunsRetention().catch((e) =>
        console.log("[WarmupScheduler] retention sweep failed:", e.message)
      );
    }, RETENTION_SWEEP_MS);
    if (g.retentionInterval.unref) g.retentionInterval.unref();
  }
}

export async function tickWarmupScheduler() {
  if (g.running) return { skipped: true, reason: "already-running" };
  g.running = true;
  try {
    const now = new Date();
    const cap = new Date(now.getTime() - MAX_CATCHUP_HOURS * 3600 * 1000);
    const persistedRaw = await getWarmupLastTickAt();
    const persisted = ISO_RE.test(persistedRaw || "") ? new Date(persistedRaw) : null;

    let from;
    if (!persisted) {
      from = now;
    } else if (persisted < cap) {
      if (g.lastClampedFrom !== persistedRaw) {
        console.log(
          `[WarmupScheduler] catch-up clamped from ${persistedRaw} to ${cap.toISOString()}`
        );
        g.lastClampedFrom = persistedRaw;
      }
      from = cap;
    } else {
      from = persisted;
    }

    // Persist BEFORE running — idempotent via status-aware dedupe.
    // Crash-loop safe: a successful run won't refire next boot because dedupe blocks it;
    // failures are not in dedupe (status='failure' → hasWarmupRun=false), so retry happens
    // within the open catch-up window.
    await setWarmupLastTickAt(now);

    const schedules = await getWarmupSchedules();
    // Defensive: drop providerConnectionIds that no longer exist in the
    // providerConnections table. Belt to the cascade-on-delete suspenders —
    // cleans up orphans that predate the cascade or were created via a path
    // that bypassed deleteProviderConnection.
    const allConnections = await getProviderConnections();
    const knownIds = new Set(allConnections.map((c) => c.id));
    const filteredSchedules = pruneOrphanProviderIds(schedules, knownIds);
    const due = findDueWarmupRunsInRange(filteredSchedules, from, now);
    let results = [];
    if (due.length) {
      const { runWarmupItems } = await loadRunner();
      // red-team #2: catch-up batches (>5 min outage) collapse to a single digest.
      const isCatchUp = now.getTime() - from.getTime() > 5 * 60 * 1000;
      const notify = isCatchUp ? "digest" : "scheduler";
      results = await runWarmupItems(due, { notify });
    }

    g.lastTickAt = now.toISOString();
    g.lastResult = {
      triggered: due.length > 0,
      dueCount: due.length,
      resultsCount: results.length,
    };
    return { triggered: due.length > 0, results };
  } finally {
    g.running = false;
  }
}

export function getWarmupSchedulerStatus() {
  return {
    running: g.running,
    started: !!g.interval,
    lastTickAt: g.lastTickAt,
    lastResult: g.lastResult,
    intervalMs: CHECK_INTERVAL_MS,
  };
}

// Atomic check-and-set so manual /api/warmup/run can serialize against
// scheduler ticks without a TOCTOU window. Caller must release on every path.
export function tryAcquireWarmupGuard() {
  if (g.running) return false;
  g.running = true;
  return true;
}

export function releaseWarmupGuard() {
  g.running = false;
}
