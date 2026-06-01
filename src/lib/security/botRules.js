// Pure, stateless request-classification rules for bot protection.
// No state, no I/O — every function is deterministic on its inputs.

// Asset extensions that should bypass classification + rate limiting entirely.
// Excludes .json on purpose: JSON config/API fetches must still flow through
// classification + rate limiting, not be silently exempted as "static".
const STATIC_ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|map|woff2?|ttf|eot)$/i;

// Scanner probe paths. Matched as ANCHORED PREFIX (never substring) so a legit
// route like /api/vendors does not collide with the /vendor probe.
const PROBE_PATHS = [
  "/.env",
  "/.git",
  "/.aws",
  "/wp-login.php",
  "/wp-admin",
  "/phpmyadmin",
  "/vendor",
  "/xmlrpc.php",
];

// Known malicious scanner UAs only. Deliberately NOT blocking generic clients
// (curl, python-requests, wget) — too broad, breaks legit API/SDK traffic.
// The valid-key exemption (botGuard) is the safety net for these.
const BAD_UA_RE = /(sqlmap|nikto|masscan|zgrab|nmap|nessus|acunetix|wpscan|dirbuster|gobuster)/i;

// AI scraper/crawler UAs — toggled independently from generic bad-UA blocking.
const AI_CRAWLER_RE = /(GPTBot|CCBot|ClaudeBot|Google-Extended|anthropic-ai|PerplexityBot|Bytespider|Amazonbot|cohere-ai)/i;

export function isStaticAsset(pathname) {
  return STATIC_ASSET_RE.test(pathname);
}

function matchesProbe(pathname) {
  return PROBE_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// Classify a request. Returns the first match in precedence order:
//   probe → bad-ua → ai-crawler. Each layer honors its own toggle.
// { block, reason, kind } where kind ∈ "probe" | "bad-ua" | "ai-crawler" | null.
export function classifyRequest({ pathname, userAgent, opts }) {
  const ua = userAgent || "";

  if (opts.blockProbePaths && matchesProbe(pathname)) {
    return { block: true, kind: "probe", reason: `probe path ${pathname}` };
  }

  if (opts.blockBadUA && (ua.trim() === "" || BAD_UA_RE.test(ua))) {
    return { block: true, kind: "bad-ua", reason: ua.trim() === "" ? "empty user-agent" : "scanner user-agent" };
  }

  if (opts.blockAiCrawlers && AI_CRAWLER_RE.test(ua)) {
    return { block: true, kind: "ai-crawler", reason: "ai crawler user-agent" };
  }

  return { block: false, kind: null, reason: null };
}
