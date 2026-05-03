"use client";

import PropTypes from "prop-types";

const DAYS = [
  { value: 1, label: "T2" },
  { value: 2, label: "T3" },
  { value: 3, label: "T4" },
  { value: 4, label: "T5" },
  { value: 5, label: "T6" },
  { value: 6, label: "T7" },
  { value: 0, label: "CN" },
];

export default function DayPicker({ value, onChange }) {
  const selected = new Set(value || []);
  const toggle = (day) => {
    const next = new Set(selected);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    onChange(Array.from(next).sort((left, right) => left - right));
  };

  return (
    <div className="flex flex-wrap gap-2">
      {DAYS.map((day) => (
        <button
          key={day.value}
          type="button"
          onClick={() => toggle(day.value)}
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${selected.has(day.value)
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-black/10 dark:border-white/10 text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          {day.label}
        </button>
      ))}
    </div>
  );
}

DayPicker.propTypes = {
  value: PropTypes.arrayOf(PropTypes.number),
  onChange: PropTypes.func.isRequired,
};
