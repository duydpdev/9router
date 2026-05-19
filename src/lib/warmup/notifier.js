import { lookup as dnsLookup } from "node:dns/promises";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const DEFAULT_RATE_LIMIT_PER_HOUR = 30;
const DEFAULT_RECOVERY_RATE_LIMIT_PER_HOUR = 5;
const DEFAULT_RECOVERY_AFTER_FAILS = 3;
const FETCH_TIMEOUT_MS = 5000;
const DISCORD_MAX_CONTENT = 2000;
const ERROR_TRUNCATE = 1500;
const DIGEST_SAMPLE_LIMIT = 5;

const TELEGRAM_TOKEN_RE = /^\d{1,12}:[A-Za-z0-9_-]{30,80}$/;
const DISCORD_WEBHOOK_RE =
  /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{40,200}$/;
const HTTP_URL_RE = /^https?:\/\/.+/;
const BOT_TOKEN_PATTERN_RE = /bot\d{1,12}:[A-Za-z0-9_-]{20,}/g;
const MD2_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

const PRIVATE_IPV4 = [
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
];

let CONFIG = null;
let DISPATCHER = null;
let DISPATCHER_URI = null;
const recoveryState = new Map();
const rateLimitWindow = [];
const recoveryWindow = [];

// Cache ProxyAgent at module scope — undici keeps a connection pool per agent,
// so reusing it avoids socket leaks across fan-outs.
function getDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (DISPATCHER && DISPATCHER_URI === proxyUrl) return DISPATCHER;
  try {
    DISPATCHER = new ProxyAgent({ uri: proxyUrl });
    DISPATCHER_URI = proxyUrl;
    return DISPATCHER;
  } catch {
    DISPATCHER = null;
    DISPATCHER_URI = null;
    return undefined;
  }
}

function readEnv(env = process.env) {
  const enabled = String(env.WARMUP_NOTIFY_ENABLED || "").toLowerCase() === "true";
  const discordUrl = String(env.WARMUP_NOTIFY_DISCORD_WEBHOOK || "").trim();
  const telegramToken = String(env.WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN || "").trim();
  const telegramChatId = String(env.WARMUP_NOTIFY_TELEGRAM_CHAT_ID || "").trim();
  const genericUrl = String(env.WARMUP_NOTIFY_GENERIC_WEBHOOK_URL || "").trim();
  const proxyUrl =
    String(
      env.HTTPS_PROXY ||
        env.https_proxy ||
        env.HTTP_PROXY ||
        env.http_proxy ||
        env.ALL_PROXY ||
        env.all_proxy ||
        "",
    ).trim() || null;
  const rateLimitPerHour = parseInt(env.WARMUP_NOTIFY_RATE_LIMIT_PER_HOUR || "", 10);
  const recoveryRateLimitPerHour = parseInt(
    env.WARMUP_NOTIFY_RECOVERY_RATE_LIMIT_PER_HOUR || "",
    10,
  );
  const recoveryAfterFails = parseInt(env.WARMUP_NOTIFY_RECOVERY_AFTER_FAILS || "", 10);

  const discordValid = !!discordUrl && isValidDiscordWebhook(discordUrl);
  const telegramValid = !!telegramToken && !!telegramChatId && isValidTelegramToken(telegramToken);
  const genericValid = !!genericUrl && isValidPublicHttpUrl(genericUrl);

  return Object.freeze({
    enabled,
    discord: Object.freeze({
      enabled: discordValid,
      url: discordUrl,
      reason: !discordUrl ? "unset" : discordValid ? "ok" : "invalid_config",
    }),
    telegram: Object.freeze({
      enabled: telegramValid,
      token: telegramToken,
      chatId: telegramChatId,
      reason: !telegramToken || !telegramChatId
        ? "unset"
        : telegramValid
          ? "ok"
          : "invalid_config",
    }),
    generic: Object.freeze({
      enabled: genericValid,
      url: genericUrl,
      reason: !genericUrl ? "unset" : genericValid ? "ok" : "invalid_config",
    }),
    proxyUrl,
    rateLimitPerHour:
      Number.isFinite(rateLimitPerHour) && rateLimitPerHour >= 0
        ? rateLimitPerHour
        : DEFAULT_RATE_LIMIT_PER_HOUR,
    recoveryRateLimitPerHour:
      Number.isFinite(recoveryRateLimitPerHour) && recoveryRateLimitPerHour >= 0
        ? recoveryRateLimitPerHour
        : DEFAULT_RECOVERY_RATE_LIMIT_PER_HOUR,
    recoveryAfterFails:
      Number.isFinite(recoveryAfterFails) && recoveryAfterFails >= 1
        ? recoveryAfterFails
        : DEFAULT_RECOVERY_AFTER_FAILS,
  });
}

export function getNotifierConfig() {
  if (!CONFIG) CONFIG = readEnv();
  return CONFIG;
}

export function isValidDiscordWebhook(url) {
  return typeof url === "string" && DISCORD_WEBHOOK_RE.test(url);
}

export function isValidTelegramToken(token) {
  return typeof token === "string" && TELEGRAM_TOKEN_RE.test(token);
}

// red-team #1: SSRF deny-list applied to literal IPs at parse time.
// Hostnames are re-resolved at send time via isHostSendable() to defeat DNS rebinding.
export function isValidPublicHttpUrl(url) {
  if (typeof url !== "string" || !HTTP_URL_RE.test(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host.toLowerCase() === "localhost") return false;
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    return !isPrivateOrLoopbackIp(host);
  }
  return true;
}

// Legacy alias kept for any caller wanting the same SSRF-safe check.
export const isValidHttpUrl = isValidPublicHttpUrl;

export function isPrivateOrLoopbackIp(ip) {
  if (typeof ip !== "string") return true;
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  // IPv6 ULA fc00::/7 and link-local fe80::/10
  if (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const o1 = +m[1];
  const o2 = +m[2];
  const o3 = +m[3];
  const o4 = +m[4];
  if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) return true;
  const n = (((o1 << 24) | (o2 << 16) | (o3 << 8) | o4) >>> 0);
  return PRIVATE_IPV4.some(([net, mask]) => (n & mask) === (net & mask));
}

async function isHostSendable(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host) return false;
  if (host.toLowerCase() === "localhost") return false;
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    return !isPrivateOrLoopbackIp(host);
  }
  try {
    const results = await dnsLookup(host, { all: true });
    return results.length > 0 && results.every((r) => !isPrivateOrLoopbackIp(r.address));
  } catch {
    return false;
  }
}

// red-team #6: counter dedupes by (connectionId, dedupeKey)
export function recordFailure(connectionId, dedupeKey) {
  let set = recoveryState.get(connectionId);
  if (!set) {
    set = new Set();
    recoveryState.set(connectionId, set);
  }
  set.add(String(dedupeKey));
  return { distinctFails: set.size };
}

export function recordSuccess(connectionId) {
  const cfg = getNotifierConfig();
  const set = recoveryState.get(connectionId);
  const distinctFails = set?.size ?? 0;
  const shouldEmitRecovery = distinctFails >= cfg.recoveryAfterFails;
  recoveryState.delete(connectionId);
  return { shouldEmitRecovery, distinctFails };
}

// red-team #15: independent budgets
export function tryReserveFailureSlot(nowMs = Date.now()) {
  return tryReserve(rateLimitWindow, getNotifierConfig().rateLimitPerHour, nowMs);
}

export function tryReserveRecoverySlot(nowMs = Date.now()) {
  return tryReserve(recoveryWindow, getNotifierConfig().recoveryRateLimitPerHour, nowMs);
}

function tryReserve(windowArr, cap, nowMs) {
  if (cap <= 0) return false;
  const cutoff = nowMs - 60 * 60 * 1000;
  while (windowArr.length && windowArr[0] < cutoff) windowArr.shift();
  if (windowArr.length >= cap) return false;
  windowArr.push(nowMs);
  return true;
}

// red-team #3: redactor — strips configured secrets + bot-token pattern.
export function redactSecrets(text) {
  const cfg = getNotifierConfig();
  let out = String(text ?? "");
  if (cfg.discord.url) out = out.split(cfg.discord.url).join("[redacted-discord-url]");
  if (cfg.generic.url) out = out.split(cfg.generic.url).join("[redacted-generic-url]");
  if (cfg.telegram.token)
    out = out.split(cfg.telegram.token).join("[redacted-telegram-token]");
  out = out.replace(BOT_TOKEN_PATTERN_RE, "bot[redacted]");
  return out;
}

// red-team #7: Telegram MarkdownV2 escaping per spec.
export function escapeMarkdownV2(text) {
  return String(text ?? "").replace(MD2_ESCAPE_RE, "\\$1");
}

function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// red-team #4: belt-and-suspenders — neuter @everyone/@here/role-mention literals
// even though allowed_mentions:{parse:[]} already disarms them server-side.
function sanitizeDiscordMentions(text) {
  return String(text ?? "")
    .replace(/@everyone/gi, "@​everyone")
    .replace(/@here/gi, "@​here")
    .replace(/<@(!|&)?(\d+)>/g, "<@​$1$2>");
}

// red-team #4: Discord — allowed_mentions parse=[], truncate error to 1500, total≤2000.
export function buildDiscordPayload(kind, ctx) {
  const scheduleName = ctx?.schedule?.name ?? "(schedule)";
  const connectionName = ctx?.connection?.name ?? ctx?.connection?.id ?? "(connection)";
  const provider = ctx?.connection?.provider ?? "(provider)";
  const tz = ctx?.schedule?.timezone ?? "";
  const when = `${ctx?.run?.localDate ?? ""} ${ctx?.run?.localTime ?? ""}`.trim();

  let content;
  if (kind === "recovery") {
    const fails = ctx?.distinctFails ?? 0;
    content =
      `✅ **Warmup recovered** — \`${connectionName}\` (${provider})\n` +
      `Schedule: **${scheduleName}** ${tz ? `(${tz})` : ""}\n` +
      `Time: ${when}\n` +
      `Recovered after ${fails} consecutive failures.`;
  } else {
    const errRaw = ctx?.run?.error ?? "(no error message)";
    const err = sanitizeDiscordMentions(truncate(errRaw, ERROR_TRUNCATE));
    content =
      `🔥 **Warmup failed** — \`${connectionName}\` (${provider})\n` +
      `Schedule: **${scheduleName}** ${tz ? `(${tz})` : ""}\n` +
      `Time: ${when}\n` +
      "```\n" +
      err +
      "\n```";
  }
  if (content.length > DISCORD_MAX_CONTENT) {
    content = content.slice(0, DISCORD_MAX_CONTENT - 1) + "…";
  }
  return { content, allowed_mentions: { parse: [] } };
}

// red-team #7: Telegram MarkdownV2.
export function buildTelegramPayload(kind, ctx, chatId) {
  const scheduleName = escapeMarkdownV2(ctx?.schedule?.name ?? "(schedule)");
  const connectionName = escapeMarkdownV2(
    ctx?.connection?.name ?? ctx?.connection?.id ?? "(connection)",
  );
  const provider = escapeMarkdownV2(ctx?.connection?.provider ?? "(provider)");
  const tz = escapeMarkdownV2(ctx?.schedule?.timezone ?? "");
  const when = escapeMarkdownV2(
    `${ctx?.run?.localDate ?? ""} ${ctx?.run?.localTime ?? ""}`.trim(),
  );

  let text;
  if (kind === "recovery") {
    const fails = ctx?.distinctFails ?? 0;
    text =
      `✅ *9Router Warmup Recovered*\n` +
      `Connection: \`${connectionName}\` \\(${provider}\\)\n` +
      `Schedule: *${scheduleName}*${tz ? ` \\(${tz}\\)` : ""}\n` +
      `Time: ${when}\n` +
      `Recovered after ${escapeMarkdownV2(String(fails))} consecutive failures\\.`;
  } else {
    const errRaw = ctx?.run?.error ?? "(no error message)";
    const err = escapeMarkdownV2(truncate(errRaw, ERROR_TRUNCATE));
    text =
      `🔥 *9Router Warmup Failed*\n` +
      `Connection: \`${connectionName}\` \\(${provider}\\)\n` +
      `Schedule: *${scheduleName}*${tz ? ` \\(${tz}\\)` : ""}\n` +
      `Time: ${when}\n` +
      "```\n" +
      err +
      "\n```";
  }
  return { chat_id: chatId, parse_mode: "MarkdownV2", text };
}

export function buildGenericPayload(kind, ctx) {
  const errRaw = ctx?.run?.error;
  const payload = {
    event: kind === "recovery" ? "warmup.recovery" : "warmup.failure",
    schedule: {
      id: ctx?.schedule?.id,
      name: ctx?.schedule?.name,
      timezone: ctx?.schedule?.timezone,
    },
    provider: {
      connectionId: ctx?.connection?.id,
      name: ctx?.connection?.name,
      provider: ctx?.connection?.provider,
    },
    run: {
      localDate: ctx?.run?.localDate,
      localTime: ctx?.run?.localTime,
      scheduledForUtc: ctx?.run?.scheduledForUtc,
      dedupeKey: ctx?.run?.dedupeKey,
    },
    timestamp: new Date().toISOString(),
  };
  if (kind === "recovery") {
    payload.distinctFails = ctx?.distinctFails ?? 0;
  } else if (errRaw !== undefined) {
    payload.error = truncate(errRaw, ERROR_TRUNCATE);
  }
  return payload;
}

// red-team #2: catch-up digest builder.
export function buildDigestPayload(channel, batch) {
  const batchSize = Array.isArray(batch) ? batch.length : 0;
  const sample = (batch || []).slice(0, DIGEST_SAMPLE_LIMIT);

  if (channel === "discord") {
    const lines = sample.map(
      (e) =>
        `• \`${e.connectionId ?? "?"}\` — ${e.scheduleName ?? "?"} @ ${e.localDate ?? ""} ${e.localTime ?? ""}: ${sanitizeDiscordMentions(truncate(e.error ?? "", 200))}`,
    );
    let content =
      `🔥 **Warmup catch-up digest** — ${batchSize} failures during outage\n` +
      lines.join("\n");
    if (content.length > DISCORD_MAX_CONTENT) {
      content = content.slice(0, DISCORD_MAX_CONTENT - 1) + "…";
    }
    return { content, allowed_mentions: { parse: [] } };
  }

  if (channel === "telegram") {
    const lines = sample.map((e) => {
      const conn = escapeMarkdownV2(e.connectionId ?? "?");
      const name = escapeMarkdownV2(e.scheduleName ?? "?");
      const when = escapeMarkdownV2(`${e.localDate ?? ""} ${e.localTime ?? ""}`.trim());
      const err = escapeMarkdownV2(truncate(e.error ?? "", 200));
      return `• \`${conn}\` — ${name} @ ${when}: ${err}`;
    });
    const text =
      `🔥 *9Router Warmup catch\\-up digest* — ${escapeMarkdownV2(String(batchSize))} failures during outage\n` +
      lines.join("\n");
    return { parse_mode: "MarkdownV2", text };
  }

  // generic
  return {
    event: "warmup.digest",
    batchSize,
    sample: sample.map((e) => ({
      scheduleId: e.scheduleId,
      scheduleName: e.scheduleName,
      connectionId: e.connectionId,
      localDate: e.localDate,
      localTime: e.localTime,
      error: truncate(e.error ?? "", ERROR_TRUNCATE),
    })),
    timestamp: new Date().toISOString(),
  };
}

function classifyFetchError(e) {
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout_5s";
  const code = e?.cause?.code || e?.code;
  return code ? String(code) : "network_error";
}

async function sendJson(url, payload, dispatcher) {
  const res = await undiciFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "9router-warmup-notifier" },
    body: JSON.stringify(payload),
    dispatcher,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // Drain body so socket can be released
  try {
    await res.text();
  } catch {
    // ignore
  }
  return res;
}

async function sendDiscord(payload, url, dispatcher) {
  if (!(await isHostSendable(url))) {
    return { ok: false, statusCode: null, reason: "private_target_blocked" };
  }
  try {
    const res = await sendJson(url, payload, dispatcher);
    return { ok: res.ok, statusCode: res.status, reason: res.ok ? null : `http_${res.status}` };
  } catch (e) {
    return { ok: false, statusCode: null, reason: classifyFetchError(e) };
  }
}

async function sendTelegram(payload, token, chatId, dispatcher) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // host is api.telegram.org → public; DNS-recheck still applied
  if (!(await isHostSendable(url))) {
    return { ok: false, statusCode: null, reason: "private_target_blocked" };
  }
  try {
    const res = await sendJson(url, payload, dispatcher);
    return { ok: res.ok, statusCode: res.status, reason: res.ok ? null : `http_${res.status}` };
  } catch (e) {
    return { ok: false, statusCode: null, reason: classifyFetchError(e) };
  }
}

async function sendGeneric(payload, url, dispatcher) {
  if (!(await isHostSendable(url))) {
    return { ok: false, statusCode: null, reason: "private_target_blocked" };
  }
  try {
    const res = await sendJson(url, payload, dispatcher);
    return { ok: res.ok, statusCode: res.status, reason: res.ok ? null : `http_${res.status}` };
  } catch (e) {
    return { ok: false, statusCode: null, reason: classifyFetchError(e) };
  }
}

async function fanOut(kind, cfg, ctx) {
  const dispatcher = getDispatcher(cfg.proxyUrl);
  const jobs = [];
  if (cfg.discord.enabled) {
    jobs.push(
      sendDiscord(buildDiscordPayload(kind, ctx), cfg.discord.url, dispatcher).then((r) => ({
        channel: "discord",
        ...r,
      })),
    );
  }
  if (cfg.telegram.enabled) {
    jobs.push(
      sendTelegram(
        buildTelegramPayload(kind, ctx, cfg.telegram.chatId),
        cfg.telegram.token,
        cfg.telegram.chatId,
        dispatcher,
      ).then((r) => ({ channel: "telegram", ...r })),
    );
  }
  if (cfg.generic.enabled) {
    jobs.push(
      sendGeneric(buildGenericPayload(kind, ctx), cfg.generic.url, dispatcher).then((r) => ({
        channel: "generic",
        ...r,
      })),
    );
  }
  const settled = await Promise.allSettled(jobs);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      const r = s.value;
      log({
        level: r.ok ? "info" : "warn",
        event: r.ok ? "sent" : "send_failed",
        kind,
        channel: r.channel,
        statusCode: r.statusCode ?? null,
        reason: r.reason ?? null,
        connectionId: ctx?.connection?.id ?? null,
        scheduleId: ctx?.schedule?.id ?? null,
      });
    } else {
      log({
        level: "warn",
        event: "send_failed",
        kind,
        reason: String(s.reason?.message || s.reason || "unknown"),
      });
    }
  }
}

async function fanOutDigest(cfg, batch) {
  const dispatcher = getDispatcher(cfg.proxyUrl);
  const jobs = [];
  if (cfg.discord.enabled) {
    jobs.push(
      sendDiscord(buildDigestPayload("discord", batch), cfg.discord.url, dispatcher).then((r) => ({
        channel: "discord",
        ...r,
      })),
    );
  }
  if (cfg.telegram.enabled) {
    jobs.push(
      sendTelegram(
        { ...buildDigestPayload("telegram", batch), chat_id: cfg.telegram.chatId },
        cfg.telegram.token,
        cfg.telegram.chatId,
        dispatcher,
      ).then((r) => ({ channel: "telegram", ...r })),
    );
  }
  if (cfg.generic.enabled) {
    jobs.push(
      sendGeneric(buildDigestPayload("generic", batch), cfg.generic.url, dispatcher).then((r) => ({
        channel: "generic",
        ...r,
      })),
    );
  }
  const settled = await Promise.allSettled(jobs);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      const r = s.value;
      log({
        level: r.ok ? "info" : "warn",
        event: r.ok ? "sent" : "send_failed",
        kind: "digest",
        channel: r.channel,
        statusCode: r.statusCode ?? null,
        reason: r.reason ?? null,
        batchSize: Array.isArray(batch) ? batch.length : 0,
      });
    } else {
      log({
        level: "warn",
        event: "send_failed",
        kind: "digest",
        reason: String(s.reason?.message || s.reason || "unknown"),
      });
    }
  }
}

export async function notifyWarmupFailure(ctx) {
  try {
    const cfg = getNotifierConfig();
    if (!cfg.enabled) return;
    if (!tryReserveFailureSlot()) {
      log({
        level: "info",
        event: "rate_limited",
        kind: "failure",
        capPerHour: cfg.rateLimitPerHour,
      });
      return;
    }
    await fanOut("failure", cfg, ctx);
  } catch (error) {
    log({
      level: "error",
      event: "notify_exception",
      kind: "failure",
      reason: String(error?.message || error),
    });
  }
}

export async function notifyWarmupRecovery(ctx) {
  try {
    const cfg = getNotifierConfig();
    if (!cfg.enabled) return;
    if (!tryReserveRecoverySlot()) {
      log({
        level: "info",
        event: "rate_limited",
        kind: "recovery",
        capPerHour: cfg.recoveryRateLimitPerHour,
      });
      return;
    }
    await fanOut("recovery", cfg, ctx);
  } catch (error) {
    log({
      level: "error",
      event: "notify_exception",
      kind: "recovery",
      reason: String(error?.message || error),
    });
  }
}

export async function notifyWarmupDigest({ batch } = {}) {
  try {
    const cfg = getNotifierConfig();
    if (!cfg.enabled || !Array.isArray(batch) || batch.length === 0) return;
    if (!tryReserveFailureSlot()) {
      log({
        level: "info",
        event: "rate_limited",
        kind: "digest",
        capPerHour: cfg.rateLimitPerHour,
      });
      return;
    }
    await fanOutDigest(cfg, batch);
  } catch (error) {
    log({
      level: "error",
      event: "notify_exception",
      kind: "digest",
      reason: String(error?.message || error),
    });
  }
}

// red-team #13: surface state size so operators detect restart wipes.
export function logBootStatus() {
  const cfg = getNotifierConfig();
  log({
    level: "info",
    event: "boot",
    enabled: cfg.enabled,
    channels: {
      discord: cfg.discord.reason,
      telegram: cfg.telegram.reason,
      generic: cfg.generic.reason,
    },
    proxy: cfg.proxyUrl ? "[redacted-proxy]" : null,
    rateLimitPerHour: cfg.rateLimitPerHour,
    recoveryRateLimitPerHour: cfg.recoveryRateLimitPerHour,
    recoveryAfterFails: cfg.recoveryAfterFails,
    "recoveryState.size": recoveryState.size,
    "rateLimitWindow.length": rateLimitWindow.length,
    "recoveryWindow.length": recoveryWindow.length,
  });
}

function log(payload) {
  const safe = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [
      k,
      typeof v === "string" ? redactSecrets(v) : v,
    ]),
  );
  console.log(
    JSON.stringify({ at: "warmup.notifier", ts: new Date().toISOString(), ...safe }),
  );
}

// Test hook — never used in production code paths.
export function __resetForTests(overrides = {}) {
  recoveryState.clear();
  rateLimitWindow.length = 0;
  recoveryWindow.length = 0;
  DISPATCHER = null;
  DISPATCHER_URI = null;
  CONFIG = Object.freeze({
    enabled: true,
    discord: Object.freeze({
      enabled: !!overrides.discordUrl,
      url: overrides.discordUrl || "",
      reason: overrides.discordUrl ? "ok" : "unset",
    }),
    telegram: Object.freeze({
      enabled: !!overrides.telegramToken,
      token: overrides.telegramToken || "",
      chatId: overrides.telegramChatId || "",
      reason: overrides.telegramToken ? "ok" : "unset",
    }),
    generic: Object.freeze({
      enabled: !!overrides.genericUrl,
      url: overrides.genericUrl || "",
      reason: overrides.genericUrl ? "ok" : "unset",
    }),
    proxyUrl: overrides.proxyUrl || null,
    rateLimitPerHour: overrides.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR,
    recoveryRateLimitPerHour:
      overrides.recoveryRateLimitPerHour ?? DEFAULT_RECOVERY_RATE_LIMIT_PER_HOUR,
    recoveryAfterFails: overrides.recoveryAfterFails ?? DEFAULT_RECOVERY_AFTER_FAILS,
  });
}
