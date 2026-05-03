"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Modal from "@/shared/components/Modal";

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

export default function PreviewPanel({ preview, providerOptions }) {
  const [open, setOpen] = useState(true);
  const [selectedDay, setSelectedDay] = useState(null);
  const names = useMemo(() => new Map((providerOptions || []).map((option) => [option.id, option.displayName])), [providerOptions]);
  const days = useMemo(() => buildDays(preview), [preview]);

  return (
    <Card padding="none" className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 border-b border-black/5 dark:border-white/5 p-4 text-left"
      >
        <span>
          <span className="block font-semibold text-text-main">Next 7 days</span>
          <span className="text-sm text-text-muted">Calendar preview · click day for details</span>
        </span>
        <span className="material-symbols-outlined text-text-muted">{open ? "expand_less" : "expand_more"}</span>
      </button>

      {open && (
        <div className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {days.map((day) => (
              <button
                key={day.date}
                type="button"
                onClick={() => setSelectedDay(day)}
                className="rounded-xl border border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/10"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text-main">{day.label}</p>
                    <p className="text-xs text-text-muted">{day.date}</p>
                  </div>
                  <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                    {day.items.length} slots
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {day.items.slice(0, 6).map((item) => (
                    <span key={`${item.scheduleId}-${item.localTime}`} className="rounded-full border border-black/5 dark:border-white/10 px-2 py-1 text-[11px] text-text-muted">
                      {item.localTime} · {item.providerConnectionIds.length}
                    </span>
                  ))}
                  {day.items.length > 6 && <span className="text-[11px] text-text-muted">+{day.items.length - 6}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <Modal
        isOpen={!!selectedDay}
        onClose={() => setSelectedDay(null)}
        title={selectedDay ? `Next runs · ${selectedDay.date}` : "Next runs"}
        size="lg"
      >
        <div className="space-y-3">
          {selectedDay?.items.length ? selectedDay.items.map((item) => (
            <div key={`${item.scheduleId}-${item.localTime}`} className="rounded-lg border border-black/5 dark:border-white/5 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-text-main">{item.localTime}</p>
                  <p className="text-sm text-text-muted">{item.name}</p>
                </div>
                <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                  {item.providerConnectionIds.length} accounts
                </span>
              </div>
              <p className="mt-2 text-sm text-text-muted">
                {item.providerConnectionIds.map((id) => names.get(id) || id).join(", ")}
              </p>
            </div>
          )) : <p className="text-sm text-text-muted">No runs.</p>}
        </div>
      </Modal>
    </Card>
  );
}

function buildDays(preview) {
  const source = Array.isArray(preview) ? preview : [];
  const firstIso = source[0]?.localDate || new Date().toISOString().slice(0, 10);
  const start = Date.UTC(...firstIso.split("-").map((part, index) => Number(part) - (index === 1 ? 1 : 0)));

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start + index * DAY_MS);
    const iso = date.toISOString().slice(0, 10);
    const items = source.filter((item) => item.localDate === iso);
    return {
      date: iso,
      label: DATE_FORMATTER.format(date),
      items,
    };
  });
}

PreviewPanel.propTypes = {
  preview: PropTypes.arrayOf(PropTypes.shape({
    scheduleId: PropTypes.string,
    name: PropTypes.string,
    providerConnectionIds: PropTypes.arrayOf(PropTypes.string),
    scheduledForUtc: PropTypes.string,
    localDate: PropTypes.string,
    localTime: PropTypes.string,
    timezone: PropTypes.string,
  })),
  providerOptions: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    displayName: PropTypes.string,
  })),
};
