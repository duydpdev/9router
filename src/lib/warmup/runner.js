import { getProviderConnectionById } from "@/lib/localDb";
import { appendWarmupRun, hasWarmupRun } from "@/lib/warmup/store";
import { classifyWarmupSession } from "@/lib/warmup/session-state";

// Lazy dynamic imports keep heavy modules (the SSE chat handler, the proxy-aware
// usage fetcher, the notifier) out of the runner's import graph until actually
// invoked — they pull in open-sse, which the test loader can't statically link.
async function loadNotifier() {
  return import("@/lib/warmup/notifier");
}

async function defaultFetchUsage(connectionId) {
  const { fetchUsageForConnection } = await import("@/lib/usage/fetch-usage-for-connection");
  return fetchUsageForConnection(connectionId);
}

// config-state failures are not provider failures.
function isConfigStateError(message) {
  if (typeof message !== "string") return false;
  return (
    message.startsWith("Provider connection not found") ||
    message.startsWith("Provider connection is inactive")
  );
}

const SESSION_PROVIDERS = new Set(["claude", "codex"]);

// Delay before the single confirmation re-poll when the first usage poll reports
// no session window. Absorbs usage-endpoint propagation lag — the endpoint is
// not guaranteed to reflect the just-sent warmup instantly. Injectable in tests
// so the suite never actually sleeps.
export const NOT_REGISTERED_REPOLL_MS = 5000;

const WARMUP_MODEL_BY_PROVIDER = {
  codex: "gpt-5.3-codex",
  "gemini-cli": "gemini-3-flash-preview",
  qwen: "qwen3-coder-flash",
  iflow: "qwen3-coder-plus",
  github: "gpt-4o-mini",
  claude: "claude-sonnet-4-5-20250929",
  "claude-code": "claude-sonnet-4-5-20250929",
  openrouter: "anthropic/claude-sonnet-4-5-20250929",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Normalized quota key holding the 5h/session window per provider.
function quotaKeyForProvider(provider) {
  return provider === "codex" ? "session" : "session (5h)";
}

async function pollSessionOnce(provider, connectionId, fetchUsage) {
  try {
    const { usage, authoritative } = await fetchUsage(connectionId);
    const usageOk = !!usage && !!usage.quotas;
    const quota = usageOk ? usage.quotas[quotaKeyForProvider(provider)] : null;
    return classifyWarmupSession({ provider, quota, usageOk, authoritative });
  } catch {
    // Usage poll failure NEVER fails the warmup — just unknown session signal.
    return { sessionState: "unknown", resetsAt: null, utilization: null };
  }
}

/**
 * Determine the session-window state for a just-completed warmup.
 * - Non-session providers → n/a (no poll).
 * - Router served a different account → n/a (known divert, not a mystery).
 * - Served account unobtainable → unknown (never risk a false not-registered).
 * - Otherwise poll usage; on not-registered, one confirmation re-poll absorbs
 *   usage-endpoint propagation lag before committing.
 */
export async function probeSession({
  provider,
  pinnedConnectionId,
  servedConnectionId,
  fetchUsage = defaultFetchUsage,
  repollDelayMs = NOT_REGISTERED_REPOLL_MS,
  sleep = defaultSleep,
}) {
  if (!SESSION_PROVIDERS.has(provider)) {
    return { sessionState: "n/a", resetsAt: null, utilization: null };
  }
  if (servedConnectionId && servedConnectionId !== pinnedConnectionId) {
    return { sessionState: "n/a", resetsAt: null, utilization: null };
  }
  if (!servedConnectionId) {
    return { sessionState: "unknown", resetsAt: null, utilization: null };
  }

  const first = await pollSessionOnce(provider, pinnedConnectionId, fetchUsage);
  if (first.sessionState === "not-registered") {
    await sleep(repollDelayMs);
    const second = await pollSessionOnce(provider, pinnedConnectionId, fetchUsage);
    if (second.sessionState !== "not-registered") return second;
  }
  return first;
}

export async function runWarmupDueItem(item, { notify = false, deps = {} } = {}) {
  const getConnection = deps.getConnection || getProviderConnectionById;
  const sendReq = deps.sendWarmupRequest || sendWarmupRequest;
  const fetchUsage = deps.fetchUsage || defaultFetchUsage;
  const repollDelayMs = deps.repollDelayMs ?? NOT_REGISTERED_REPOLL_MS;
  const sleep = deps.sleep || defaultSleep;
  const loadNotifierFn = deps.loadNotifier || loadNotifier;

  if (await hasWarmupRun(item.dedupeKey)) {
    return {
      skipped: true,
      scheduleId: item.schedule.id,
      providerConnectionId: item.providerConnectionId,
      scheduledForUtc: item.scheduledForUtc,
      localDate: item.localDate,
      localTime: item.localTime,
      timezone: item.timezone,
    };
  }

  let connection;
  try {
    connection = await getConnection(item.providerConnectionId);
    if (!connection) throw new Error("Provider connection not found");
    if (connection.isActive === false) throw new Error("Provider connection is inactive");

    const { servedConnectionId } = await sendReq(connection, item.schedule.prompt);

    // Hoisted so the persisted run row and any downstream logic share one
    // timestamp for when the warmup actually ran.
    const actualRanAt = new Date().toISOString();

    const session = await probeSession({
      provider: connection.provider,
      pinnedConnectionId: connection.id,
      servedConnectionId,
      fetchUsage,
      repollDelayMs,
      sleep,
    });

    const row = await appendWarmupRun({
      scheduleId: item.schedule.id,
      providerConnectionId: item.providerConnectionId,
      scheduledForUtc: item.scheduledForUtc,
      actualRanAt,
      localDate: item.localDate,
      localTime: item.localTime,
      timezone: item.timezone,
      dedupeKey: item.dedupeKey,
      // Run status stays success/failure — the session signal is session_state.
      status: "success",
      error: null,
      resetsAt: session.resetsAt,
      utilization: session.utilization,
      sessionState: session.sessionState,
    });

    if (notify === "scheduler") {
      try {
        const { recordSuccess, notifyWarmupRecovery, notifyWarmupNotRegistered } =
          await loadNotifierFn();
        const { shouldEmitRecovery, distinctFails } = recordSuccess(item.providerConnectionId);
        if (shouldEmitRecovery) {
          void notifyWarmupRecovery({
            schedule: { id: item.schedule.id, name: item.schedule.name, timezone: item.schedule.timezone },
            connection: {
              id: connection.id,
              name: connection.name || connection.displayName || connection.email || connection.provider,
              provider: connection.provider,
            },
            run: {
              localDate: item.localDate,
              localTime: item.localTime,
              scheduledForUtc: item.scheduledForUtc,
              dedupeKey: item.dedupeKey,
            },
            distinctFails,
          });
        }
        // The request succeeded (status=success) but the 5h window did not
        // register. This alert fires independently of the recovery threshold —
        // recordSuccess may still clear the failure counter; the not-registered
        // page must not be swallowed by recovery logic.
        if (session.sessionState === "not-registered" && typeof notifyWarmupNotRegistered === "function") {
          void notifyWarmupNotRegistered({
            schedule: { id: item.schedule.id, name: item.schedule.name, timezone: item.schedule.timezone },
            connection: {
              id: connection.id,
              name: connection.name || connection.displayName || connection.email || connection.provider,
              provider: connection.provider,
            },
            run: {
              localDate: item.localDate,
              localTime: item.localTime,
              scheduledForUtc: item.scheduledForUtc,
              dedupeKey: item.dedupeKey,
              sessionState: session.sessionState,
              resetsAt: session.resetsAt,
            },
          });
        }
      } catch (notifyError) {
        console.log("[WarmupRunner] notify success-path failed:", notifyError.message);
      }
    }

    return row;
  } catch (error) {
    const row = await appendWarmupRun({
      scheduleId: item.schedule.id,
      providerConnectionId: item.providerConnectionId,
      scheduledForUtc: item.scheduledForUtc,
      actualRanAt: new Date().toISOString(),
      localDate: item.localDate,
      localTime: item.localTime,
      timezone: item.timezone,
      dedupeKey: item.dedupeKey,
      status: "failure",
      error: error.message || "Warmup failed",
    });

    // skip notify path entirely for config-state failures.
    if (notify === "scheduler" && !isConfigStateError(error.message)) {
      try {
        const { recordFailure, notifyWarmupFailure } = await loadNotifierFn();
        const { distinctFails } = recordFailure(item.providerConnectionId, item.dedupeKey);
        void notifyWarmupFailure({
          schedule: { id: item.schedule.id, name: item.schedule.name, timezone: item.schedule.timezone },
          connection: {
            id: connection?.id || item.providerConnectionId,
            name:
              connection?.name ||
              connection?.displayName ||
              connection?.email ||
              connection?.provider ||
              `<missing:${item.providerConnectionId}>`,
            provider: connection?.provider || "(unknown)",
          },
          run: {
            localDate: item.localDate,
            localTime: item.localTime,
            scheduledForUtc: item.scheduledForUtc,
            dedupeKey: item.dedupeKey,
            error: error.message || "Warmup failed",
          },
          distinctFails,
        });
      } catch (notifyError) {
        console.log("[WarmupRunner] notify failure failed:", notifyError.message);
      }
    }

    return row;
  }
}

export async function runWarmupItems(items, options = {}) {
  const { notify = false, deps = {} } = options;
  const results = [];
  const digestBatch = [];
  const notRegisteredBatch = [];

  for (const item of items) {
    // In digest mode, per-item runs suppress notification; runner accumulates
    // failures AND not-registered events for ONE end-of-batch digest send.
    const perItemNotify = notify === "digest" ? false : notify;
    const result = await runWarmupDueItem(item, { notify: perItemNotify, deps });
    results.push(result);

    if (notify === "digest" && result?.status === "failure") {
      digestBatch.push({
        scheduleId: item.schedule.id,
        scheduleName: item.schedule.name,
        connectionId: item.providerConnectionId,
        localDate: item.localDate,
        localTime: item.localTime,
        error: result.error || "Warmup failed",
      });
    }

    if (notify === "digest" && result?.sessionState === "not-registered") {
      notRegisteredBatch.push({
        scheduleId: item.schedule.id,
        scheduleName: item.schedule.name,
        connectionId: item.providerConnectionId,
        localDate: item.localDate,
        localTime: item.localTime,
        resetsAt: result.resetsAt || null,
        sessionState: result.sessionState,
      });
    }
  }

  if (notify === "digest" && (digestBatch.length || notRegisteredBatch.length)) {
    try {
      const { notifyWarmupDigest } = await (deps.loadNotifier || loadNotifier)();
      void notifyWarmupDigest({ batch: digestBatch, notRegisteredBatch });
    } catch (notifyError) {
      console.log("[WarmupRunner] notify digest failed:", notifyError.message);
    }
  }
  return results;
}

async function sendWarmupRequest(connection, prompt) {
  const { handleInternalWarmupChat } = await import("@/sse/handlers/chat");
  const model = WARMUP_MODEL_BY_PROVIDER[connection.provider] || "claude-haiku-4-5-20251001";
  const request = new Request("http://127.0.0.1/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "9router-warmup",
      "x-9router-connection-id": connection.id,
    },
    body: JSON.stringify({
      model: `${connection.provider}/${model}`,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_tokens: 8,
    }),
  });

  const response = await handleInternalWarmupChat(request, {
    endpoint: "/api/v1/chat/completions",
    body: await request.clone().json(),
    headers: Object.fromEntries(request.headers.entries()),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let errorMsg = `Warmup request failed with status ${response.status}`;
    if (text) {
      try {
        const json = JSON.parse(text);
        const extracted = json?.error?.message || json?.message || json?.error;
        errorMsg = typeof extracted === "string" ? extracted : text;
      } catch {
        errorMsg = text;
      }
    }
    throw new Error(errorMsg);
  }

  // Which connection actually served the request (after any router fallback).
  const servedConnectionId = response.headers.get("x-9router-served-connection-id") || null;
  return { servedConnectionId };
}
