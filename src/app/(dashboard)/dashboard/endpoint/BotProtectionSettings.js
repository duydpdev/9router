"use client";

import PropTypes from "prop-types";
import { Card, Toggle, Input } from "@/shared/components";
import { toPositiveInt, clampPercent, shouldShowChannelWarning } from "./bot-protection-settings-helpers";

// Sub-toggles shown under the master switch. Order matches the bot guard's
// classification precedence (probe → bad-UA → ai-crawler) plus the proxy-trust
// posture flag.
const SUB_TOGGLES = [
  { key: "blockProbePaths", label: "Block probe paths", desc: "Instant 403 on scanner paths (/.env, /wp-admin, /phpmyadmin…)" },
  { key: "blockBadUA", label: "Block scanner user-agents", desc: "Reject sqlmap, nikto, masscan and empty user-agents" },
  { key: "blockAiCrawlers", label: "Block AI crawlers", desc: "GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider…" },
  { key: "trustProxy", label: "Trust X-Forwarded-For", desc: "Enable ONLY behind a reverse proxy that sets the header — otherwise the client IP is forgeable." },
];

export default function BotProtectionSettings({ value, onChange, notifierEnabled = false }) {
  if (!value) return null;

  const set = (patch) => onChange({ ...value, ...patch });
  const setRate = (patch) => onChange({ ...value, rateLimit: { ...value.rateLimit, ...patch } });
  const setLlm = (patch) => onChange({ ...value, llmRateLimit: { ...value.llmRateLimit, ...patch } });
  const setBudget = (patch) => onChange({ ...value, keyBudget: { ...value.keyBudget, ...patch } });

  const on = value.enabled !== false;
  const rate = value.rateLimit || {};
  const llm = value.llmRateLimit || {};
  const budget = value.keyBudget || {};
  const budgetOn = budget.enabled !== false;

  return (
    <Card id="bot-protection">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">shield</span>
          Bot Protection
        </h2>
        <Toggle checked={on} onChange={() => set({ enabled: !on })} />
      </div>
      <p className="text-sm text-text-muted pb-2">
        Probe-path, scanner, and AI-crawler blocking plus per-IP / per-key rate limiting. Loopback and valid API keys are always exempt.
      </p>

      {on && (
        <>
          {SUB_TOGGLES.map((t) => (
            <div key={t.key} className="flex items-center justify-between pt-4 border-t border-border gap-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.label}</p>
                <p className="text-sm text-text-muted">{t.desc}</p>
              </div>
              <Toggle checked={value[t.key] !== false} onChange={() => set({ [t.key]: !(value[t.key] !== false) })} />
            </div>
          ))}

          <div className="flex flex-wrap items-end gap-4 pt-4 border-t border-border">
            <Input
              label="Global limit (req/min/IP)"
              type="number"
              value={rate.limit ?? ""}
              onChange={(e) => setRate({ limit: toPositiveInt(e.target.value, rate.limit) })}
            />
            <Input
              label="/v1 keyless (req/min/IP)"
              type="number"
              value={llm.limit ?? ""}
              onChange={(e) => setLlm({ limit: toPositiveInt(e.target.value, llm.limit) })}
            />
            <Input
              label="/v1 per-key (req/min)"
              type="number"
              value={llm.keyLimit ?? ""}
              onChange={(e) => setLlm({ keyLimit: toPositiveInt(e.target.value, llm.keyLimit) })}
            />
          </div>

          {/* Per-key daily budget monitor — alert-only, never blocks. */}
          <div className="flex items-center justify-between pt-4 border-t border-border gap-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Per-key daily budget alerts</p>
              <p className="text-sm text-text-muted">
                Webhook alert when a single API key crosses its daily token / request budget. Alert-only — never blocks or disables the key.
              </p>
            </div>
            <Toggle checked={budgetOn} onChange={() => setBudget({ enabled: !budgetOn })} />
          </div>

          {budgetOn && (
            <>
              {shouldShowChannelWarning(budgetOn, notifierEnabled) && (
                <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined align-middle text-base mr-1">warning</span>
                  No notifier channel is active — budget alerts will be silently dropped. Set <code>WARMUP_NOTIFY_ENABLED=true</code> and configure a Discord / Telegram / generic webhook to receive them.
                </div>
              )}
              <div className="flex flex-wrap items-end gap-4 pt-4">
                <Input
                  label="Tokens / day / key"
                  type="number"
                  value={budget.tokenPerDay ?? ""}
                  onChange={(e) => setBudget({ tokenPerDay: toPositiveInt(e.target.value, budget.tokenPerDay) })}
                />
                <Input
                  label="Requests / day / key"
                  type="number"
                  value={budget.requestPerDay ?? ""}
                  onChange={(e) => setBudget({ requestPerDay: toPositiveInt(e.target.value, budget.requestPerDay) })}
                />
                <Input
                  label="Warn at (%)"
                  type="number"
                  value={budget.warnAtPercent ?? ""}
                  onChange={(e) => setBudget({ warnAtPercent: clampPercent(e.target.value, budget.warnAtPercent) })}
                />
                <Input
                  label="Re-alert every (hours)"
                  type="number"
                  value={budget.reAlertHours ?? ""}
                  onChange={(e) => setBudget({ reAlertHours: toPositiveInt(e.target.value, budget.reAlertHours) })}
                />
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

BotProtectionSettings.propTypes = {
  value: PropTypes.object,
  onChange: PropTypes.func.isRequired,
  notifierEnabled: PropTypes.bool,
};
