// 9Router MCP control-plane server (stdio, read-only).
//
// Exposes router introspection as MCP tools for Claude Desktop and other stdio
// MCP clients. createMcpServer() is a LAZY factory — no top-level side effects,
// no boot-time cost. v1 ships 3 read-only tools.
//
// IMPORT-STYLE CONTRACT: db/shared imports below MUST stay RELATIVE
// (../db/..., ../../shared/...) — never the "@/" alias. The CLI binary ships
// this module as loose files inside the standalone bundle and runs it under
// plain node with no alias resolver; relative paths resolve there, "@/" does not.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProviderConnections } from "../db/repos/connectionsRepo.js";
import { getUsageStats } from "../db/repos/usageRepo.js";
import { getEffectiveStatus } from "../../shared/utils/get-effective-status.js";

const SERVER_NAME = "9router";
const SERVER_VERSION = "1.0.0";

// Shared MCP tool-error helper: machine-readable code + message in a JSON body.
export const mcpError = (code, message) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
});

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

// getEffectiveStatus() can return values beyond this documented set (a raw
// testStatus, or "success"). Keep the enum as the published contract but coerce
// anything unexpected to "unknown" so live data never fails output validation.
const StatusSchema = z
  .enum(["active", "needs_reauth", "expired", "unavailable", "error", "unknown"])
  .catch("unknown");

// ---------------------------------------------------------------------------
// router.list_providers
// ---------------------------------------------------------------------------
const ListProvidersInput = { includeInactive: z.boolean().optional() };
const ListProvidersInputSchema = z.object(ListProvidersInput).strict();
const ListProvidersOutput = z.array(
  z.object({
    connectionId: z.string(),
    provider: z.string(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    status: StatusSchema,
    authType: z.string(),
  }),
);

// Map a raw connection to a credential-free summary. NEVER copy token fields.
function toSummary(conn) {
  return {
    connectionId: conn.id,
    provider: conn.provider,
    name: conn.name ?? null,
    email: conn.email ?? null,
    status: getEffectiveStatus(conn),
    authType: conn.authType,
  };
}

async function listProvidersHandler(rawInput) {
  let input;
  try {
    input = ListProvidersInputSchema.parse(rawInput ?? {});
  } catch (err) {
    return mcpError("invalid_input", err.message);
  }
  try {
    const rows = await getProviderConnections(
      input.includeInactive ? {} : { isActive: true },
    );
    const out = rows.map(toSummary);
    return ok(ListProvidersOutput.parse(out));
  } catch (err) {
    return mcpError("list_providers_failed", err.message);
  }
}

// ---------------------------------------------------------------------------
// router.get_quota_status
// ---------------------------------------------------------------------------
const GetQuotaStatusInput = { provider: z.string().optional() };
const GetQuotaStatusInputSchema = z.object(GetQuotaStatusInput).strict();
const GetQuotaStatusOutput = z.array(
  z.object({
    provider: z.string(),
    dailyTokens: z.number(),
    dailyRequests: z.number(),
    quotaRemaining: z.number().nullable().optional(),
    resetAt: z.string().nullable().optional(),
  }),
);

// Derive the optional quota fields for one provider from its connections.
// 9Router has no hard per-day quota field — the only related signal is each
// connection's `rateLimitedUntil` (set when a provider rate-limits us).
//   - quotaRemaining: no cap exists → null (do not invent a number an LLM
//     would treat as a hard fact).
//   - resetAt: soonest FUTURE `rateLimitedUntil` across the provider's
//     connections = when capacity returns; null if none are rate-limited.
function deriveQuotaFields(connections) {
  const now = Date.now();
  let soonest = null;
  for (const c of connections) {
    const until = c?.rateLimitedUntil;
    if (!until) continue;
    const t = new Date(until).getTime();
    if (Number.isNaN(t) || t <= now) continue; // past / invalid → stale
    if (soonest === null || t < soonest) soonest = t;
  }
  return {
    quotaRemaining: null,
    resetAt: soonest === null ? null : new Date(soonest).toISOString(),
  };
}

async function getQuotaStatusHandler(rawInput) {
  let input;
  try {
    input = GetQuotaStatusInputSchema.parse(rawInput ?? {});
  } catch (err) {
    return mcpError("invalid_input", err.message);
  }
  try {
    const stats = await getUsageStats("today");
    const allConns = await getProviderConnections({});
    const connsByProvider = {};
    for (const c of allConns) (connsByProvider[c.provider] ??= []).push(c);

    // Source providers from today's usage, PLUS any provider currently
    // rate-limited (future rateLimitedUntil) even with zero usage today — else
    // its resetAt, the signal this tool exists to surface, would be invisible.
    const providerSet = new Set(Object.keys(stats.byProvider || {}));
    for (const [provider, conns] of Object.entries(connsByProvider)) {
      if (deriveQuotaFields(conns).resetAt) providerSet.add(provider);
    }
    let providers = [...providerSet];
    if (input.provider) providers = providers.filter((p) => p === input.provider);

    const out = providers.map((provider) => {
      const p = stats.byProvider[provider] || {};
      const quota = deriveQuotaFields(connsByProvider[provider] || []) || {};
      return {
        provider,
        dailyTokens: (p.promptTokens || 0) + (p.completionTokens || 0),
        dailyRequests: p.requests || 0,
        quotaRemaining: quota.quotaRemaining ?? null,
        resetAt: quota.resetAt ?? null,
      };
    });
    return ok(GetQuotaStatusOutput.parse(out));
  } catch (err) {
    return mcpError("get_quota_status_failed", err.message);
  }
}

// ---------------------------------------------------------------------------
// router.get_usage_today
// ---------------------------------------------------------------------------
const GetUsageTodayInput = { groupBy: z.enum(["provider", "model"]).optional() };
const GetUsageTodayInputSchema = z.object(GetUsageTodayInput).strict();
const GetUsageTodayOutput = z.object({
  totals: z.object({ tokens: z.number(), requests: z.number() }),
  breakdown: z.array(
    z.object({ key: z.string(), tokens: z.number(), requests: z.number() }),
  ),
});

async function getUsageTodayHandler(rawInput) {
  let input;
  try {
    input = GetUsageTodayInputSchema.parse(rawInput ?? {});
  } catch (err) {
    return mcpError("invalid_input", err.message);
  }
  try {
    const stats = await getUsageStats("today");
    const groupBy = input.groupBy || "provider";
    const source = groupBy === "model" ? stats.byModel : stats.byProvider;
    const breakdown = Object.entries(source || {}).map(([key, v]) => ({
      key,
      tokens: (v.promptTokens || 0) + (v.completionTokens || 0),
      requests: v.requests || 0,
    }));
    const out = {
      totals: {
        tokens: (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0),
        requests: stats.totalRequests || 0,
      },
      breakdown,
    };
    return ok(GetUsageTodayOutput.parse(out));
  } catch (err) {
    return mcpError("get_usage_today_failed", err.message);
  }
}

export function createMcpServer() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "router.list_providers",
    {
      description: "List provider connections with their effective health status.",
      inputSchema: ListProvidersInput,
    },
    listProvidersHandler,
  );

  server.registerTool(
    "router.get_quota_status",
    {
      description: "Per-provider daily token/request usage and remaining quota.",
      inputSchema: GetQuotaStatusInput,
    },
    getQuotaStatusHandler,
  );

  server.registerTool(
    "router.get_usage_today",
    {
      description: "Today's total token/request usage with an optional breakdown.",
      inputSchema: GetUsageTodayInput,
    },
    getUsageTodayHandler,
  );

  return server;
}
