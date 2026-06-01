import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { isStaticAsset, classifyRequest } from "./botRules.js";
import { check } from "./rateLimiter.js";
import { getTrustedClientIp } from "./clientIp.js";
import { logBlocked } from "./auditLog.js";
import {
  isLocalRequest,
  hasValidCliToken,
  isAuthenticated,
  isPublicLlmApi,
  extractApiKey,
} from "@/dashboardGuard";

// Short, stable bucket id for a validated key — never the raw key.
function keyHash(k) {
  return crypto.createHash("sha256").update(k).digest("hex").slice(0, 16);
}

// ~5s settings cache. botGuard runs on the hot /v1 path, which otherwise does
// no settings read — avoid a sqlite hit per proxied request.
let _cache = null;
let _cacheAt = 0;
async function getCachedBotSettings(now = Date.now) {
  const t = now();
  if (_cache && t - _cacheAt < 5000) return _cache;
  const s = await getSettings();
  _cache = s?.botProtection || null;
  _cacheAt = t;
  return _cache;
}

function block403(reason) {
  return NextResponse.json({ error: "Forbidden", reason }, { status: 403 });
}

// /v1 clients are SDKs (Anthropic/OpenAI) — return a JSON error envelope they
// parse, plus Retry-After. Non-/v1 gets a plain message.
function block429(retryAfter, isLlm) {
  const body = isLlm
    ? { error: { message: "Rate limit exceeded. Please retry later.", type: "rate_limit" } }
    : { error: "Too many requests" };
  return NextResponse.json(body, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}

// First check in proxy(). Returns a block response, or null to pass through.
// Fail-open: bot protection is best-effort and must never take down the proxy.
// A transient settings/DB error (e.g. SQLITE_BUSY) degrades to pass-through,
// mirroring proxy()'s existing "on error, keep defaults" posture. Hard auth
// still runs after this in proxy().
export async function botGuard(request) {
  try {
    return await runBotGuard(request);
  } catch {
    return null;
  }
}

async function runBotGuard(request) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  // The middleware matcher catches public/ assets too — skip them so asset
  // fan-out on a page load never burns the per-IP rate budget.
  if (isStaticAsset(pathname)) return null;
  if (method === "OPTIONS" || method === "HEAD") return null;

  const bp = await getCachedBotSettings();
  if (!bp || bp.enabled === false) return null;
  if (isLocalRequest(request)) return null; // loopback always exempt

  const ip = getTrustedClientIp(request, { trustProxy: bp.trustProxy });
  const ua = request.headers.get("user-agent");
  const opts = {
    blockProbePaths: bp.blockProbePaths,
    blockBadUA: bp.blockBadUA,
    blockAiCrawlers: bp.blockAiCrawlers,
  };

  // Lazy key resolution — only computed when needed (imminent block or /v1).
  let apiKey = null;
  let keyValid = false;
  let keyResolved = false;
  async function resolveKey() {
    if (keyResolved) return;
    keyResolved = true;
    apiKey = extractApiKey(request) || "";
    keyValid = apiKey ? await validateApiKey(apiKey) : false;
    if (!keyValid) keyValid = await hasValidCliToken(request);
  }

  // 1. Classification. Probe paths block unconditionally; bad-UA / ai-crawler
  // are skipped for a valid key (don't break legit SDK clients).
  const cls = classifyRequest({ pathname, userAgent: ua, opts });
  if (cls.block) {
    if (cls.kind === "probe") {
      logBlocked({ ip, kind: cls.kind, reason: cls.reason, path: pathname, ua });
      return block403(cls.reason);
    }
    await resolveKey();
    if (!keyValid) {
      logBlocked({ ip, kind: cls.kind, reason: cls.reason, path: pathname, ua });
      return block403(cls.reason);
    }
  }

  // 2. Rate limit.
  return isPublicLlmApi(pathname)
    ? rateLimitLlm(bp.llmRateLimit, { ip, ua, pathname, resolveKey, getKey: () => ({ keyValid, apiKey }) })
    : await rateLimitGlobal(bp.rateLimit, request, { ip, ua, pathname });
}

// /v1: key-aware tiering. Keyed by the validated key (hashed) so teams behind
// one NAT don't share a bucket; keyless falls back to per-IP.
async function rateLimitLlm(llm, { ip, ua, pathname, resolveKey, getKey }) {
  if (!llm || llm.enabled === false) return null;
  await resolveKey();
  const { keyValid, apiKey } = getKey();
  let bucket;
  let limit;
  let windowMs;
  if (keyValid && apiKey) {
    bucket = `v1:key:${keyHash(apiKey)}`;
    limit = llm.keyLimit;
    windowMs = llm.keyWindowMs || llm.windowMs;
  } else if (keyValid) {
    bucket = "v1:cli";
    limit = llm.keyLimit;
    windowMs = llm.keyWindowMs || llm.windowMs;
  } else {
    bucket = `v1:ip:${ip}`;
    limit = llm.limit;
    windowMs = llm.windowMs;
  }
  const r = check(bucket, { limit, windowMs });
  if (r.allowed) return null;
  logBlocked({ ip, kind: "rate", reason: "llm rate limit", path: pathname, ua });
  return block429(r.retryAfter, true);
}

// Non-/v1 global per-IP. Authed first-party browser is exempt — counting
// dashboard traffic against a bot limit is the wrong threat model.
async function rateLimitGlobal(g, request, { ip, ua, pathname }) {
  if (!g || g.enabled === false) return null;
  if (await isAuthenticated(request)) return null;
  const r = check(`g:${ip}`, { limit: g.limit, windowMs: g.windowMs });
  if (r.allowed) return null;
  logBlocked({ ip, kind: "rate", reason: "global rate limit", path: pathname, ua });
  return block429(r.retryAfter, false);
}

export const __test__ = {
  resetCache: () => {
    _cache = null;
    _cacheAt = 0;
  },
};
