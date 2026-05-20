import { Buffer } from "node:buffer";
import { createErrorResult } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { getTtsAdapter, synthesizeViaConfig } from "./ttsProviders/index.js";
import { getExecutor } from "../executors/index.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";

const AUTH_FAILURE_RE = /\b(401|403|unauthor|forbidden)\b/i;

// Re-export voice fetchers + voices APIs for backward compat with existing routes
export {
  VOICE_FETCHERS,
  fetchEdgeTtsVoices,
  fetchLocalDeviceVoices,
  fetchElevenLabsVoices,
} from "./ttsProviders/index.js";

// ── Response Formatter (DRY) ───────────────────────────────────
function createTtsResponse(base64Audio, format, responseFormat) {
  const audioBuffer = Buffer.from(base64Audio, "base64");

  // JSON format: return base64 encoded audio
  if (responseFormat === "json") {
    return {
      success: true,
      response: new Response(JSON.stringify({ audio: base64Audio, format }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }),
    };
  }

  // Binary format (default): return raw audio
  return {
    success: true,
    response: new Response(audioBuffer, {
      headers: {
        "Content-Type": `audio/${format}`,
        "Content-Length": String(audioBuffer.length),
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}

// ── Core handler ───────────────────────────────────────────────
/**
 * Synthesize text to audio. Provider logic lives in `./ttsProviders/{id}.js`
 * or is dispatched generically via `ttsConfig.format`.
 *
 * @returns {Promise<{success, response, status?, error?}>}
 */
async function runSynthesize(provider, model, input, credentials, responseFormat, language) {
  const adapter = getTtsAdapter(provider);
  if (adapter) {
    const result = await adapter.synthesize(input.trim(), model, credentials, responseFormat, { language });
    if (result.success !== undefined) return result;
    return createTtsResponse(result.base64, result.format, responseFormat);
  }

  const result = await synthesizeViaConfig(provider, input.trim(), model, credentials);
  if (result) return createTtsResponse(result.base64, result.format, responseFormat);

  return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support TTS via this route.`);
}

export async function handleTtsCore({ provider, model, input, credentials, responseFormat = "mp3", language, log, onCredentialsRefreshed }) {
  if (!input?.trim()) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }

  try {
    return await runSynthesize(provider, model, input, credentials, responseFormat, language);
  } catch (err) {
    const errMsg = err?.message || "TTS synthesis failed";
    const executor = getExecutor(provider);

    // Mid-stream 401/403 retry-once: thrown error carries the upstream status
    // in its message (adapter convention). Refresh once and retry one time.
    if (
      AUTH_FAILURE_RE.test(errMsg) &&
      executor?.refreshCredentials &&
      credentials?.authType === "oauth"
    ) {
      const newCredentials = await refreshWithRetry(
        () => executor.refreshCredentials(credentials, log),
        3,
        log,
      );
      if (newCredentials?.accessToken || newCredentials?.apiKey) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for TTS`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);
        try {
          return await runSynthesize(provider, model, input, credentials, responseFormat, language);
        } catch (retryErr) {
          return createErrorResult(HTTP_STATUS.BAD_GATEWAY, retryErr.message || "TTS synthesis failed");
        }
      }
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed for TTS`);
    }

    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }
}
