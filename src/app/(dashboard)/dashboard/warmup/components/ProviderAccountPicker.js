"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import Toggle from "@/shared/components/Toggle";

const DEFAULT_OPEN_PROVIDERS = 3;

export default function ProviderAccountPicker({ options, value, onChange }) {
  const selected = new Set(value || []);
  const groups = useMemo(() => groupByProvider(options || []), [options]);
  const [openProviders, setOpenProviders] = useState(() => new Set(groups.slice(0, DEFAULT_OPEN_PROVIDERS).map((group) => group.provider)));
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  const toggleProvider = (provider, checked) => {
    const next = new Set(selected);
    const group = groups.find((item) => item.provider === provider);
    for (const option of group?.options || []) {
      if (checked) next.delete(option.id);
      else next.add(option.id);
    }
    onChange(Array.from(next));
  };

  const toggleOpenProvider = (provider) => {
    setOpenProviders((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  if (!options?.length) {
    return (
      <div className="rounded-lg border border-dashed border-black/10 dark:border-white/10 p-4 text-sm text-text-muted">
        No active provider accounts found.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => {
        const selectedCount = group.options.filter((option) => selected.has(option.id)).length;
        const allSelected = selectedCount === group.options.length;
        const provider = AI_PROVIDERS[group.provider] || { id: group.provider, name: group.provider, color: "#F97316" };
        const isOpen = openProviders.has(group.provider);
        return (
          <div key={group.provider} className="overflow-hidden rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02]">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 p-2.5">
              <button
                type="button"
                onClick={() => toggleOpenProvider(group.provider)}
                className="flex min-w-0 items-center gap-3 text-left"
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${provider.color?.length > 7 ? provider.color : provider.color + "15"}` }}
                >
                  <ProviderIcon
                    src={`/providers/${provider.id}.png`}
                    alt={provider.name}
                    size={32}
                    className="max-h-8 max-w-8 rounded-lg object-contain"
                    fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
                    fallbackColor={provider.color}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-text-main">{provider.name}</span>
                  <span className="block text-xs text-text-muted">{selectedCount}/{group.options.length} selected</span>
                </span>
              </button>
              <Toggle size="sm" checked={allSelected} onChange={() => toggleProvider(group.provider, allSelected)} />
              <button
                type="button"
                onClick={() => toggleOpenProvider(group.provider)}
                className="rounded-lg p-1 text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-text-main"
              >
                <span className="material-symbols-outlined text-lg">{isOpen ? "expand_less" : "expand_more"}</span>
              </button>
            </div>

            {isOpen && (
              <div className="grid gap-1 border-t border-black/5 dark:border-white/5 p-2">
                {group.options.map((option) => {
                  const checked = selected.has(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggle(option.id)}
                      className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors ${checked
                        ? "bg-primary/10"
                        : "hover:bg-black/5 dark:hover:bg-white/5"
                      }`}
                    >
                      <span className={`flex size-5 items-center justify-center rounded-md border text-xs ${checked ? "border-primary bg-primary text-white" : "border-black/20 dark:border-white/20"}`}>
                        {checked ? "✓" : ""}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text-main">{option.displayName}</span>
                        <span className="block truncate text-xs text-text-muted">
                          {option.defaultModel || "default model"}{option.priority ? ` · priority ${option.priority}` : ""}
                        </span>
                      </span>
                      <span className={`rounded-full px-2 py-1 text-[11px] ${option.testStatus === "active" ? "bg-green-500/10 text-green-500" : "bg-black/5 text-text-muted dark:bg-white/10"}`}>
                        {option.testStatus}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function groupByProvider(options) {
  const map = new Map();
  for (const option of options) {
    if (!map.has(option.provider)) map.set(option.provider, []);
    map.get(option.provider).push(option);
  }
  return Array.from(map.entries()).map(([provider, providerOptions]) => ({
    provider,
    options: providerOptions,
  }));
}

ProviderAccountPicker.propTypes = {
  options: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    provider: PropTypes.string,
    displayName: PropTypes.string,
    defaultModel: PropTypes.string,
    priority: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    testStatus: PropTypes.string,
  })),
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
};
