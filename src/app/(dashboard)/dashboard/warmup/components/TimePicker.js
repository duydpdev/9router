"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";

const HOUR_PRESETS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
const MINUTE_STEP_PRESETS = [15, 30];
const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function sortTimes(arr) {
  return Array.from(new Set(arr)).sort((left, right) => left.localeCompare(right));
}

function normalizeInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const hourOnly = text.match(/^(\d{1,2})$/);
  if (hourOnly) {
    const hour = Number(hourOnly[1]);
    if (hour < 0 || hour > 23) return null;
    return `${String(hour).padStart(2, "0")}:00`;
  }
  const match = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export default function TimePicker({ value, onChange }) {
  const selected = useMemo(() => sortTimes(Array.isArray(value) ? value : []), [value]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const setTimes = (next) => onChange(sortTimes(next));

  const toggle = (time) => {
    const set = new Set(selected);
    if (set.has(time)) set.delete(time);
    else set.add(time);
    setTimes(Array.from(set));
  };

  const remove = (time) => setTimes(selected.filter((t) => t !== time));

  const addDraft = () => {
    const normalized = normalizeInput(draft);
    if (!normalized) {
      setError("Use HH:MM (00:00 – 23:59)");
      return;
    }
    setError("");
    setDraft("");
    if (selected.includes(normalized)) return;
    setTimes([...selected, normalized]);
  };

  const fillEvery = (stepMinutes) => {
    const next = [];
    for (let total = 0; total < 24 * 60; total += stepMinutes) {
      const h = Math.floor(total / 60);
      const m = total % 60;
      next.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
    setTimes(next);
  };

  const clearAll = () => setTimes([]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] px-2 py-1">
          <input
            type="text"
            inputMode="numeric"
            placeholder="HH:MM"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addDraft(); } }}
            className="w-20 bg-transparent text-sm text-text-main outline-none placeholder:text-text-muted"
            aria-label="Add time (HH:MM)"
          />
          <button
            type="button"
            onClick={addDraft}
            className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/20"
          >
            Add
          </button>
        </div>
        {MINUTE_STEP_PRESETS.map((step) => (
          <button
            key={step}
            type="button"
            onClick={() => fillEvery(step)}
            className="rounded-full border border-black/10 dark:border-white/10 px-3 py-1 text-xs text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          >
            Every {step} min
          </button>
        ))}
        {selected.length > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="rounded-full border border-black/10 dark:border-white/10 px-3 py-1 text-xs text-text-muted hover:text-red-500"
          >
            Clear
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] p-2">
          {selected.map((time) => (
            <span
              key={time}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
            >
              {time}
              <button
                type="button"
                onClick={() => remove(time)}
                className="rounded-full text-primary/80 hover:text-primary"
                aria-label={`Remove ${time}`}
              >
                <span className="material-symbols-outlined text-sm leading-none">close</span>
              </button>
            </span>
          ))}
        </div>
      )}

      <div>
        <p className="mb-1 text-xs text-text-muted">Quick hour presets</p>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
          {HOUR_PRESETS.map((time) => (
            <button
              key={time}
              type="button"
              onClick={() => toggle(time)}
              className={`rounded-full border px-2 py-1.5 text-xs font-medium transition-colors ${selected.includes(time)
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-black/10 dark:border-white/10 text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              {time}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

TimePicker.propTypes = {
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
};

TimePicker.normalizeInput = normalizeInput;
TimePicker.HH_MM_RE = HH_MM_RE;
