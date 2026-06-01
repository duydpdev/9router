import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  requireLogin: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  enableObservability: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  cavemanEnabled: false,
  cavemanLevel: "full",
  // Layered bot protection. Defaults ON; loopback + valid key always exempt.
  // trustProxy=false means x-forwarded-for is treated as untrusted (direct-exposed
  // npx/docker); set true only behind a reverse proxy that sets the header.
  botProtection: {
    enabled: true,
    trustProxy: false,
    blockProbePaths: true,
    blockBadUA: true,
    blockAiCrawlers: true,
    rateLimit: { enabled: true, limit: 300, windowMs: 60000 },
    llmRateLimit: { enabled: true, limit: 120, windowMs: 60000, keyLimit: 1200, keyWindowMs: 60000 },
  },
};

// Keys whose default is a nested object with sub-defaults that must survive a
// partial user override (shallow spread would clobber siblings). Only
// botProtection needs this — the other object-valued keys are user-populated maps.
const NESTED_DEFAULT_KEYS = ["botProtection"];

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// One-level-recursive merge of a default object with a user override.
function deepMergeDefaults(def, override) {
  if (!isPlainObject(override)) return { ...def };
  const out = { ...def };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(def[k]) && isPlainObject(v) ? deepMergeDefaults(def[k], v) : v;
  }
  return out;
}

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  // Nested-object keys: preserve sub-defaults under a partial user override.
  for (const key of NESTED_DEFAULT_KEYS) {
    merged[key] = deepMergeDefaults(DEFAULT_SETTINGS[key], raw?.[key]);
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)]
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}

export const __test__ = { mergeWithDefaults };
