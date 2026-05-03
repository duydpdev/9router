"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import { createDefaultWarmupSchedule } from "@/lib/warmup/schedule";
import PreviewPanel from "./components/PreviewPanel";
import RunHistoryPanel from "./components/RunHistoryPanel";
import ScheduleRuleCard from "./components/ScheduleRuleCard";

export default function WarmupPageClient() {
  const [schedules, setSchedules] = useState([]);
  const [runs, setRuns] = useState([]);
  const [runsMeta, setRunsMeta] = useState({ total: 0, limit: 20, offset: 0, hasMore: false });
  const [preview, setPreview] = useState([]);
  const [providerOptions, setProviderOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [schedulesOpen, setSchedulesOpen] = useState(true);

  useEffect(() => {
    loadState();
  }, []);

  const summary = useMemo(() => {
    const accountIds = new Set(schedules.flatMap((schedule) => schedule.providerConnectionIds || []));
    return {
      rules: schedules.length,
      accounts: accountIds.size,
      nextRuns: preview.length,
    };
  }, [preview.length, schedules]);

  async function loadState() {
    setLoading(true);
    setError("");
    try {
      await Promise.all([loadSchedules(), loadPreview(), loadRuns({ limit: runsMeta.limit, offset: 0 })]);
    } finally {
      setLoading(false);
    }
  }

  async function loadSchedules() {
    try {
      const response = await fetch("/api/warmup/schedules", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load warmup schedules");
      setSchedules(data.schedules || []);
      setProviderOptions(data.providerOptions || []);
    } catch (err) {
      setError(err.message || "Failed to load warmup schedules");
    }
  }

  async function loadPreview() {
    try {
      const response = await fetch("/api/warmup/preview?days=7", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load warmup preview");
      setPreview(data.preview || []);
    } catch (err) {
      setError(err.message || "Failed to load warmup preview");
    }
  }

  async function loadRuns({ limit = runsMeta.limit, offset = 0, append = false } = {}) {
    try {
      const response = await fetch(`/api/warmup/runs?limit=${limit}&offset=${offset}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load warmup runs");
      setRuns((current) => (append ? [...current, ...(data.runs || [])] : (data.runs || [])));
      setRunsMeta({
        total: data.total || 0,
        limit: data.limit || limit,
        offset: data.offset || 0,
        hasMore: !!data.hasMore,
      });
    } catch (err) {
      setError(err.message || "Failed to load warmup runs");
    }
  }

  async function saveSchedules() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/warmup/schedules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schedules }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save warmup schedules");
      setSchedules(data.schedules || []);
      setProviderOptions(data.providerOptions || []);
      await loadPreview();
      setMessage("Saved warmup schedules.");
    } catch (err) {
      setError(err.message || "Failed to save warmup schedules");
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/warmup/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduleIds: schedules.map((schedule) => schedule.id) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to run warmup");
      setMessage(`Warmup finished: ${data.results?.length || 0} account run(s).`);
      await Promise.all([loadRuns({ limit: runsMeta.limit, offset: 0 }), loadPreview()]);
    } catch (err) {
      setError(err.message || "Failed to run warmup");
    } finally {
      setRunning(false);
    }
  }

  const updateSchedule = (index, nextSchedule) => {
    setSchedules((current) => current.map((schedule, idx) => (idx === index ? nextSchedule : schedule)));
  };

  const deleteSchedule = (index) => {
    setSchedules((current) => current.filter((_, idx) => idx !== index));
  };

  const addSchedule = () => {
    setSchedules((current) => [...current, createDefaultWarmupSchedule()]);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-text-main">Warmup Scheduler</h1>
          <p className="mt-2 text-sm text-text-muted">Warm selected provider accounts on schedule while 9Router is running.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon="play_arrow" onClick={runNow} loading={running} disabled={!schedules.length}>Run selected now</Button>
          <Button icon="save" onClick={saveSchedules} loading={saving}>Save changes</Button>
          <Button variant="secondary" icon="add" onClick={addSchedule}>Add schedule</Button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-500">{error}</div>}
      {message && <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-3 text-sm text-green-500">{message}</div>}

      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="rules" value={summary.rules} />
        <Metric label="accounts selected" value={summary.accounts} />
        <Metric label="runs next 7 days" value={summary.nextRuns} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card padding="none" className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-black/5 dark:border-white/5 p-4">
            <button type="button" onClick={() => setSchedulesOpen((value) => !value)} className="flex min-w-0 items-center gap-3 text-left">
              <span className="material-symbols-outlined text-primary">local_fire_department</span>
              <span className="min-w-0">
                <span className="block font-semibold text-text-main">Schedules</span>
                <span className="block truncate text-sm text-text-muted">One rule can target multiple provider accounts</span>
              </span>
              <span className="material-symbols-outlined text-text-muted">{schedulesOpen ? "expand_less" : "expand_more"}</span>
            </button>
            <Button size="sm" icon="add" onClick={addSchedule}>Add</Button>
          </div>
          {schedulesOpen && (
            <div className="p-6">
              {loading ? (
                <p className="text-sm text-text-muted">Loading warmup schedules...</p>
              ) : schedules.length ? (
                <div className="space-y-4">
                  {schedules.map((schedule, index) => (
                    <ScheduleRuleCard
                      key={schedule.id}
                      schedule={schedule}
                      providerOptions={providerOptions}
                      onChange={(nextSchedule) => updateSchedule(index, nextSchedule)}
                      onDelete={() => deleteSchedule(index)}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-black/10 dark:border-white/10 p-8 text-center">
                  <p className="text-sm text-text-muted">No schedules configured.</p>
                  <Button className="mt-4" icon="add" onClick={addSchedule}>Add schedule</Button>
                </div>
              )}
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <PreviewPanel preview={preview} providerOptions={providerOptions} />
          <RunHistoryPanel
            runs={runs}
            providerOptions={providerOptions}
            meta={runsMeta}
            onLimitChange={(limit) => loadRuns({ limit, offset: 0 })}
            onLoadMore={() => loadRuns({ limit: runsMeta.limit, offset: runs.length, append: true })}
          />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <Card padding="sm">
      <p className="text-2xl font-semibold text-text-main">{value}</p>
      <p className="text-xs text-text-muted">{label}</p>
    </Card>
  );
}

Metric.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.number.isRequired,
};
