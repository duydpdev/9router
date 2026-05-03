import { getProviderConnectionById } from "@/lib/localDb";
import { handleInternalWarmupChat } from "@/sse/handlers/chat";
import { appendWarmupRun, hasWarmupRun } from "@/lib/warmup/store";

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

export async function runWarmupDueItem(item) {
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

  try {
    const connection = await getProviderConnectionById(item.providerConnectionId);
    if (!connection) throw new Error("Provider connection not found");
    if (connection.isActive === false) throw new Error("Provider connection is inactive");

    await sendWarmupRequest(connection, item.schedule.prompt);

    return appendWarmupRun({
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
  } catch (error) {
    return appendWarmupRun({
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
  }
}

export async function runWarmupItems(items) {
  const results = [];
  for (const item of items) {
    results.push(await runWarmupDueItem(item));
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
