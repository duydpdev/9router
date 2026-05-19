import { getProviderConnectionById } from "@/lib/localDb";
import { handleInternalWarmupChat } from "@/sse/handlers/chat";
import { appendWarmupRun, hasWarmupRun } from "@/lib/warmup/store";

// Lazy dynamic import keeps the notifier module out of code paths that only
// need the runner (e.g. the manual /api/warmup/run route). Evaluation deferred
// until first scheduler-tick notify. (red-team #12)
async function loadNotifier() {
  return import("@/lib/warmup/notifier");
}

// red-team #14: config-state failures are not provider failures.
function isConfigStateError(message) {
  if (typeof message !== "string") return false;
  return (
    message.startsWith("Provider connection not found") ||
    message.startsWith("Provider connection is inactive")
  );
}

const WARMUP_MODEL_BY_PROVIDER = {
  codex: "gpt-5.3-codex",
  "gemini-cli": "gemini-3-flash-preview",
  qwen: "qwen3-coder-flash",
  iflow: "qwen3-coder-plus",
  github: "gpt-4o-mini",
  claude: "claude-haiku-4-5-20251001",
  "claude-code": "claude-haiku-4-5-20251001",
  openrouter: "anthropic/claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.5-flash",
};

export async function runWarmupDueItem(item, { notify = false } = {}) {
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
    connection = await getProviderConnectionById(item.providerConnectionId);
    if (!connection) throw new Error("Provider connection not found");
    if (connection.isActive === false) throw new Error("Provider connection is inactive");

    await sendWarmupRequest(connection, item.schedule.prompt);

    const row = await appendWarmupRun({
      scheduleId: item.schedule.id,
      providerConnectionId: item.providerConnectionId,
      scheduledForUtc: item.scheduledForUtc,
      actualRanAt: new Date().toISOString(),
      localDate: item.localDate,
      localTime: item.localTime,
      timezone: item.timezone,
      dedupeKey: item.dedupeKey,
      status: "success",
      error: null,
    });

    if (notify === "scheduler") {
      try {
        const { recordSuccess, notifyWarmupRecovery } = await loadNotifier();
        const { shouldEmitRecovery, distinctFails } = recordSuccess(item.providerConnectionId);
        if (shouldEmitRecovery) {
          void notifyWarmupRecovery({
            schedule: {
              id: item.schedule.id,
              name: item.schedule.name,
              timezone: item.schedule.timezone,
            },
            connection: {
              id: connection.id,
              name:
                connection.name ||
                connection.displayName ||
                connection.email ||
                connection.provider,
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
      } catch (notifyError) {
        console.log("[WarmupRunner] notify recovery failed:", notifyError.message);
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

    // red-team #14: skip notify path entirely for config-state failures.
    if (notify === "scheduler" && !isConfigStateError(error.message)) {
      try {
        const { recordFailure, notifyWarmupFailure } = await loadNotifier();
        const { distinctFails } = recordFailure(
          item.providerConnectionId,
          item.dedupeKey,
        );
        void notifyWarmupFailure({
          schedule: {
            id: item.schedule.id,
            name: item.schedule.name,
            timezone: item.schedule.timezone,
          },
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
  const { notify = false } = options;
  const results = [];
  const digestBatch = [];

  for (const item of items) {
    // In digest mode, per-item runs suppress notification; runner accumulates
    // failures for ONE end-of-batch digest send. (red-team #2)
    const perItemNotify = notify === "digest" ? false : notify;
    const result = await runWarmupDueItem(item, { notify: perItemNotify });
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
  }

  if (notify === "digest" && digestBatch.length) {
    try {
      const { notifyWarmupDigest } = await loadNotifier();
      void notifyWarmupDigest({ batch: digestBatch });
    } catch (notifyError) {
      console.log("[WarmupRunner] notify digest failed:", notifyError.message);
    }
  }
  return results;
}

async function sendWarmupRequest(connection, prompt) {
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
}
