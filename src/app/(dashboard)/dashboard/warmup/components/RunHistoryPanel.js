"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Modal from "@/shared/components/Modal";

const LIMIT_OPTIONS = [10, 20, 50, 100];

export default function RunHistoryPanel({ runs, providerOptions, meta, onLimitChange, onLoadMore }) {
  const [open, setOpen] = useState(true);
  const [selectedRun, setSelectedRun] = useState(null);
  const names = useMemo(() => new Map((providerOptions || []).map((option) => [option.id, option.displayName])), [providerOptions]);
  const groups = useMemo(() => groupRuns(runs), [runs]);
  // Captured once per render — countdown is a snapshot, no per-second ticking.
  const now = Date.now();

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-black/5 dark:border-white/5 p-4">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 text-left"
        >
          <span className="block font-semibold text-text-main">Recent runs</span>
          <span className="text-sm text-text-muted">{runs?.length || 0}/{meta?.total || 0} shown · click run for details</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <select
            value={meta?.limit || 20}
            onChange={(event) => onLimitChange(Number(event.target.value))}
            className="rounded-lg border border-black/10 bg-transparent px-2 py-1 text-xs text-text-main dark:border-white/10"
          >
            {LIMIT_OPTIONS.map((limit) => <option key={limit} value={limit}>{limit}</option>)}
          </select>
          <button type="button" onClick={() => setOpen((value) => !value)} className="rounded-lg p-1 text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-text-main">
            <span className="material-symbols-outlined text-lg">{open ? "expand_less" : "expand_more"}</span>
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-3 p-4">
          {groups.length ? groups.map((group) => (
            <div key={group.date} className="rounded-xl border border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-text-main">{group.date}</p>
                <p className="text-xs text-text-muted">{group.items.length} runs</p>
              </div>
              <div className="space-y-1">
                {group.items.map((run) => {
                  const status = statusMeta(run);
                  const badge = sessionBadgeMeta(run.sessionState);
                  const countdown = formatCountdown(run.resetsAt, now);
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => setSelectedRun(run)}
                      className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      <span className={`size-2.5 rounded-full ${status.dot}`} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text-main">{names.get(run.providerConnectionId) || run.providerConnectionId}</span>
                        <span className="flex items-center gap-2 truncate text-xs text-text-muted">
                          <span className="truncate">{run.localTime || run.scheduledForUtc}</span>
                          {badge && <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>{badge.label}</span>}
                          {countdown && <span className="shrink-0">· {countdown}</span>}
                        </span>
                      </span>
                      <span className={`text-xs font-semibold ${status.text}`}>
                        {status.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )) : <p className="text-sm text-text-muted">No warmup runs yet.</p>}
          {meta?.hasMore && (
            <button
              type="button"
              onClick={onLoadMore}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-medium text-text-muted hover:bg-black/5 hover:text-text-main dark:border-white/10 dark:hover:bg-white/5"
            >
              Load more
            </button>
          )}
        </div>
      )}

      <Modal
        isOpen={!!selectedRun}
        onClose={() => setSelectedRun(null)}
        title="Warmup run"
        size="lg"
      >
        {selectedRun && (
          <div className="space-y-3 text-sm">
            <Detail label="Account" value={names.get(selectedRun.providerConnectionId) || selectedRun.providerConnectionId} />
            <Detail label="Status" value={selectedRun.status} />
            <Detail label="Scheduled" value={selectedRun.localDate && selectedRun.localTime ? `${selectedRun.localDate} ${selectedRun.localTime}` : selectedRun.scheduledForUtc} />
            <Detail label="Created" value={selectedRun.createdAt} />
            {sessionBadgeMeta(selectedRun.sessionState) && (
              <>
                <Detail label="Session state" value={sessionBadgeMeta(selectedRun.sessionState).label} />
                <Detail label="5h window resets" value={formatResetTime(selectedRun.resetsAt, selectedRun.timezone) || "—"} />
                <Detail label="Resets in" value={formatCountdown(selectedRun.resetsAt, now) || "—"} />
                <Detail label="Utilization" value={typeof selectedRun.utilization === "number" ? `${selectedRun.utilization}% used` : "—"} />
              </>
            )}
            {selectedRun.error && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-muted">Error</p>
                <pre className="max-h-64 overflow-auto rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500 whitespace-pre-wrap">{selectedRun.error}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}

function Detail({ label, value }) {
  return (
    <div className="rounded-lg border border-black/5 dark:border-white/5 p-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-1 break-all text-text-main">{value || "—"}</p>
    </div>
  );
}

// Status dot/label derive from BOTH status and session_state so a 200 warmup
// that did not register a session shows amber, not a misleading green.
function statusMeta(run) {
  if (run.status === "failure") return { dot: "bg-red-500", text: "text-red-500", label: "Fail" };
  if (run.sessionState === "not-registered") return { dot: "bg-amber-500", text: "text-amber-500", label: "No session" };
  return { dot: "bg-green-500", text: "text-green-500", label: "OK" };
}

// Badge derives from session_state. n/a / null (non-session or old rows) → no badge.
function sessionBadgeMeta(sessionState) {
  switch (sessionState) {
    case "active":
      return { label: "session active", className: "bg-green-500/15 text-green-500" };
    case "not-registered":
      return { label: "not registered", className: "bg-amber-500/15 text-amber-500" };
    case "unknown":
      return { label: "unknown", className: "bg-black/10 text-text-muted dark:bg-white/10" };
    default:
      return null;
  }
}

function formatResetTime(resetsAt, timezone) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function formatCountdown(resetsAt, now) {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `resets in ${h}h${String(m).padStart(2, "0")}m`;
}

function groupRuns(runs) {
  const map = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const date = run.localDate || String(run.createdAt || run.scheduledForUtc || "Unknown").slice(0, 10);
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(run);
  }
  return Array.from(map.entries()).map(([date, items]) => ({ date, items }));
}

Detail.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string,
};

RunHistoryPanel.propTypes = {
  runs: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    providerConnectionId: PropTypes.string,
    status: PropTypes.string,
    localDate: PropTypes.string,
    localTime: PropTypes.string,
    scheduledForUtc: PropTypes.string,
    createdAt: PropTypes.string,
    error: PropTypes.string,
    timezone: PropTypes.string,
    sessionState: PropTypes.string,
    resetsAt: PropTypes.string,
    utilization: PropTypes.number,
  })),
  providerOptions: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    displayName: PropTypes.string,
  })),
  meta: PropTypes.shape({
    total: PropTypes.number,
    limit: PropTypes.number,
    offset: PropTypes.number,
    hasMore: PropTypes.bool,
  }),
  onLimitChange: PropTypes.func.isRequired,
  onLoadMore: PropTypes.func.isRequired,
};
