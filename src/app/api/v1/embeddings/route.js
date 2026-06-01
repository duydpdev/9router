import { handleEmbeddings } from "@/sse/handlers/embeddings.js";
import { parseCacheDirective } from "@/sse/services/cache-directive.js";
import { getPromptCache, hashKey } from "@/sse/services/prompt-cache.js";
import * as log from "@/sse/utils/logger.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/embeddings - OpenAI-compatible embeddings endpoint.
 *
 * Optional opt-in cache: `x-router-cache: ttl=<seconds>`. Disabled by default —
 * a request without the header is byte-for-byte identical to pre-feature behavior.
 * Cache is wired at the route layer (not the handler) because embeddings has a
 * single route entry point with no format translation, so placement is
 * unambiguous and the handler stays untouched.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    // Malformed JSON — hand the raw request to the handler to emit its standard
    // 400, preserving pre-feature behavior. (Body unconsumed: original request.)
    return await handleEmbeddings(request);
  }

  const directive = parseCacheDirective(request, body, "embeddings");

  let cacheKey = null;
  if (directive.enabled) {
    cacheKey = hashKey({
      model: body.model,
      input: body.input,
      encoding_format: body.encoding_format,
      dimensions: body.dimensions,
    });
    const hit = getPromptCache().get(cacheKey);
    if (hit) {
      // Mirror the headers a fresh success response carries (see
      // embeddingsCore success path) so a cache hit is indistinguishable from a
      // miss to the client — notably CORS, which a browser caller needs on
      // EVERY response, not just misses.
      return new Response(JSON.stringify(hit), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "x-router-cache-hit": "true",
        },
      });
    }
  } else if (directive.bypassReason) {
    log.debug("CACHE", `bypass: ${directive.bypassReason}`);
  }

  // Body already consumed above — rebuild a request for the handler to re-read.
  // Re-serialization can change the byte length, so drop the stale
  // Content-Length to avoid a header/body mismatch for any downstream reader.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete("content-length");
  const forwarded = new Request(request.url, {
    method: request.method,
    headers: forwardedHeaders,
    body: JSON.stringify(body),
  });

  // handleEmbeddings returns a RAW Response (success + error paths alike); gate
  // caching on response.ok (200-only), NOT a { success } envelope.
  const response = await handleEmbeddings(forwarded);

  if (cacheKey && response.ok) {
    const cachedBody = await response.clone().json();
    getPromptCache().set(cacheKey, cachedBody, directive.ttl);
    return new Response(JSON.stringify(cachedBody), {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), "x-router-cache-hit": "false" },
    });
  }

  return response;
}
