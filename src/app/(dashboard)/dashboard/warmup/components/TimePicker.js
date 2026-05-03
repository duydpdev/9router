"use client";

import PropTypes from "prop-types";

const TIMES = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);

export default function TimePicker({ value, onChange }) {
  const selected = new Set(value || []);
  const toggle = (time) => {
    const next = new Set(selected);
    if (next.has(time)) next.delete(time);
    else next.add(time);
    onChange(Array.from(next).sort((left, right) => left.localeCompare(right)));
  };

  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
      {TIMES.map((time) => (
        <button
          key={time}
          type="button"
          onClick={() => toggle(time)}
          className={`rounded-full border px-2 py-1.5 text-xs font-medium transition-colors ${selected.has(time)
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-black/10 dark:border-white/10 text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          {time}
        </button>
      ))}
    </div>
  );
}

TimePicker.propTypes = {
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
};
