"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import Toggle from "@/shared/components/Toggle";
import { ConfirmModal } from "@/shared/components/Modal";
import DayPicker from "./DayPicker";
import ProviderAccountPicker from "./ProviderAccountPicker";
import TimePicker from "./TimePicker";

export default function ScheduleRuleCard({ schedule, providerOptions, onChange, onDelete }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const selectedCount = schedule.providerConnectionIds?.length || 0;
  const timeSummary = schedule.times?.length ? schedule.times.join(", ") : "No times";

  const patch = (changes) => onChange({ ...schedule, ...changes });

  return (
    <Card.Section className={schedule.enabled ? "py-3" : "py-3 opacity-70"}>
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => setDetailsOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="material-symbols-outlined text-primary">schedule</span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-text-main">{schedule.name || "Untitled schedule"}</span>
            <span className="block truncate text-xs text-text-muted">
              {selectedCount} account{selectedCount === 1 ? "" : "s"} · {timeSummary} · {schedule.timezone}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Toggle size="sm" checked={!!schedule.enabled} onChange={() => patch({ enabled: !schedule.enabled })} />
          <button
            type="button"
            onClick={() => setDetailsOpen((value) => !value)}
            className="rounded-lg p-1 text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-text-main"
          >
            <span className="material-symbols-outlined text-lg">{detailsOpen ? "expand_less" : "expand_more"}</span>
          </button>
        </div>
      </div>

      {detailsOpen && <div className="mt-4 space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_220px]">
          <Input label="Rule name" value={schedule.name} onChange={(event) => patch({ name: event.target.value })} />
          <Input label="Timezone" value={schedule.timezone} onChange={(event) => patch({ timezone: event.target.value })} />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-text-main">Provider accounts</p>
          <ProviderAccountPicker
            options={providerOptions}
            value={schedule.providerConnectionIds}
            onChange={(providerConnectionIds) => patch({ providerConnectionIds })}
          />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-text-main">Days</p>
          <DayPicker value={schedule.days} onChange={(days) => patch({ days })} />
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-text-main">Times</p>
          <TimePicker value={schedule.times} onChange={(times) => patch({ times })} />
        </div>

        <Input label="Prompt" value={schedule.prompt} onChange={(event) => patch({ prompt: event.target.value })} />

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary/10 p-3 text-xs text-primary">
          <span>Runs all selected accounts. Success requires real chat response.</span>
          <Button variant="ghost" size="sm" icon="delete" onClick={() => setConfirmOpen(true)}>Delete</Button>
        </div>
      </div>}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); onDelete(); }}
        title="Delete schedule"
        message={`Delete ${schedule.name || "this schedule"}?`}
        confirmText="Delete"
      />
    </Card.Section>
  );
}

ScheduleRuleCard.propTypes = {
  schedule: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    enabled: PropTypes.bool,
    providerConnectionIds: PropTypes.arrayOf(PropTypes.string),
    days: PropTypes.arrayOf(PropTypes.number),
    times: PropTypes.arrayOf(PropTypes.string),
    prompt: PropTypes.string,
    timezone: PropTypes.string,
  }).isRequired,
  providerOptions: PropTypes.array,
  onChange: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};
