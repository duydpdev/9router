"use client";

import PropTypes from "prop-types";
import { Card, Toggle, Input } from "@/shared/components";

// Sub-toggles shown under the master switch. Order matches the bot guard's
// classification precedence (probe → bad-UA → ai-crawler) plus the proxy-trust
// posture flag.
const SUB_TOGGLES = [
  { key: "blockProbePaths", label: "Block probe paths", desc: "Instant 403 on scanner paths (/.env, /wp-admin, /phpmyadmin…)" },
  { key: "blockBadUA", label: "Block scanner user-agents", desc: "Reject sqlmap, nikto, masscan and empty user-agents" },
  { key: "blockAiCrawlers", label: "Block AI crawlers", desc: "GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider…" },
  { key: "trustProxy", label: "Trust X-Forwarded-For", desc: "Enable ONLY behind a reverse proxy that sets the header — otherwise the client IP is forgeable." },
];

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default function BotProtectionSettings({ value, onChange }) {
  if (!value) return null;

  const set = (patch) => onChange({ ...value, ...patch });
  const setRate = (patch) => onChange({ ...value, rateLimit: { ...value.rateLimit, ...patch } });
  const setLlm = (patch) => onChange({ ...value, llmRateLimit: { ...value.llmRateLimit, ...patch } });

  const on = value.enabled !== false;
  const rate = value.rateLimit || {};
  const llm = value.llmRateLimit || {};

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
        </>
      )}
    </Card>
  );
}

BotProtectionSettings.propTypes = {
  value: PropTypes.object,
  onChange: PropTypes.func.isRequired,
};
