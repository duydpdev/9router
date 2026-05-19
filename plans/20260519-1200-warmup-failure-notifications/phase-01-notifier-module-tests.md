---
phase: 1
title: "Notifier module + tests"
status: completed
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Notifier module + tests

## Overview

Create a self-contained `src/lib/warmup/notifier.js` with pure helpers (env load, validators, payload builders, rate limiter, recovery state machine) plus channel adapters (Discord, Telegram, generic). Add `tests/warmup-notifier.test.mjs` covering pure logic. Module is loadable but not wired yet — no behavior change to runner.

## Requirements

**Functional:**
- Read env vars once at module init; expose `getNotifierConfig()` returning a frozen snapshot
- Validate Discord webhook URL, Telegram bot token, generic webhook URL; invalid → channel disabled, log `invalid_config`
- `notifyWarmupFailure({ schedule, connection, run, distinctFails })` — fan-out to enabled channels via `Promise.allSettled`, never throws
- `notifyWarmupRecovery({ schedule, connection, run, distinctFails })` — same fan-out, uses SEPARATE recovery budget
- `notifyWarmupDigest({ batch })` — one summary per catch-up batch (red-team #2)
- In-memory recovery state: `Map<connectionId, Set<dedupeKey>>` — pure helpers `recordFailure(connectionId, dedupeKey)` and `recordSuccess(connectionId)` returning `{ shouldEmitRecovery, distinctFails }`. Repeated failures on the same `dedupeKey` are no-ops (red-team #6)
- Sliding-hour rate limiter: in-memory deque of send timestamps; over-cap → log `rate_limited`, return without sending
- `logBootStatus()` — one JSON line dumping enabled channels + thresholds (no secrets)

**Non-functional:**
- **No new runtime deps**. Use `undici@^7.19.2` (already in `package.json`) — `import { fetch, ProxyAgent } from "undici"` — NOT native global `fetch` (it ignores `HTTP_PROXY`). Pattern matches existing `src/lib/network/proxyTest.js`. Use `AbortSignal.timeout(5000)`. (red-team #8)
- Every log line = single-line JSON, parseable by `JSON.parse`
- Tokens / URLs NEVER appear in any log line. Enforced by `redactSecrets(text, cfg)` applied at the LAST step before every `log()` call, AND unit-tested by injecting an error whose `message` contains the configured Telegram token / Discord webhook URL / generic webhook URL and asserting all three substrings are absent from the emitted log. (red-team #3)
- Pure functions (payload builders, validators, rate limit, recovery state, redactor) are unit-testable without network
- SSRF: validator rejects loopback, RFC1918, link-local (incl. AWS/GCP metadata host), and unique-local IPv6 ranges. At SEND time, hostname is DNS-resolved and ALL resolved IPs are re-checked against the same deny-list. (red-team #1)
- Discord adapter ALWAYS sets `allowed_mentions: { parse: [] }` and truncates `error` to 1500 chars before embedding. (red-team #4)
- Telegram adapter uses `parse_mode: "MarkdownV2"` and applies `escapeMarkdownV2()` to every user-controlled field (schedule name, connection name, error text). (red-team #7)
- Failure recovery counter is keyed by `(connectionId, dedupeKey)`-set, NOT a raw integer. `recordFailure` adds the dedupeKey to a per-connection Set; counter = `Set.size`. Repeated failures on the same slot do NOT inflate the counter. (red-team #6)
- Recovery alerts have a SEPARATE rate-limit budget (`recoveryWindow`), default 5/hour, never shared with the failure budget. (red-team #15)
- Catch-up mode: notifier exposes a `notifyWarmupDigest({ batchSize, sampleItems, schedule, connection })` API for emitting ONE summary message per catch-up batch instead of N per-item messages. (red-team #2)
- Boot log payload includes `recoveryState.size` and `rateLimitWindow.length` and `recoveryWindow.length` so operators see when state was wiped by restart. (red-team #13)

## Architecture

```
notifier.js
├── readEnv()                       // read process.env once, freeze config
├── validators
│   ├── isValidDiscordWebhook(url)  // regex + length bounds for token segment
│   ├── isValidTelegramToken(token) // regex + 30..80 char token segment
│   ├── isValidPublicHttpUrl(url)   // http(s) + RFC1918/loopback/link-local DENY (red-team #1)
│   └── isPrivateOrLoopbackIp(ip)   // shared by validator + send-time DNS recheck
├── payload builders
│   ├── buildDiscordPayload(kind, ctx)    // allowed_mentions:{parse:[]}, error≤1500ch (red-team #4)
│   ├── buildTelegramPayload(kind, ctx, chatId)  // parse_mode:"MarkdownV2", escape (red-team #7)
│   ├── buildGenericPayload(kind, ctx)
│   └── buildDigestPayload(channel, batch)        // catch-up digest (red-team #2)
├── escape helpers
│   └── escapeMarkdownV2(text)      // escape _*[](){}~`>#+-=|.! per Telegram docs
├── recovery state machine          // keyed by connectionId; value = Set<dedupeKey>
│   ├── recordFailure(connectionId, dedupeKey): { distinctFails }
│   └── recordSuccess(connectionId): { shouldEmitRecovery, distinctFails }
├── rate limiters (two separate buckets)
│   ├── tryReserveFailureSlot(now): boolean   // cfg.rateLimitPerHour (default 30)
│   └── tryReserveRecoverySlot(now): boolean  // cfg.recoveryRateLimitPerHour (default 5)
├── channel adapters (use undici fetch + optional ProxyAgent)
│   ├── sendDiscord(payload, url, dispatcher)
│   ├── sendTelegram(payload, token, chatId, dispatcher)
│   └── sendGeneric(payload, url, dispatcher)
│       └── (each adapter DNS-resolves URL host and rejects private IPs before sending)
├── secret redaction
│   └── redactSecrets(text, cfg)    // strip configured token / webhook URLs + bot{N}:{TOKEN} pattern (red-team #3)
├── public API
│   ├── notifyWarmupFailure(ctx)
│   ├── notifyWarmupRecovery(ctx)
│   ├── notifyWarmupDigest({ kind, batchSize, sampleItems, schedule, connection })
│   ├── logBootStatus()
│   ├── recordFailure(id, dedupeKey)
│   └── recordSuccess(id)
└── logger
    └── log({ level, event, ... })  // wraps payload through redactSecrets BEFORE JSON.stringify
```

`ctx` shape for failure / recovery:
```js
{
  schedule:   { id, name, timezone },
  connection: { id, name, provider },
  run:        { localDate, localTime, scheduledForUtc, error?, dedupeKey },  // dedupeKey REQUIRED for recordFailure
  distinctFails: number  // recovery only — distinct-slot count, not raw event count
}
```

## Related Code Files

**Create:**
- `src/lib/warmup/notifier.js`
- `tests/warmup-notifier.test.mjs`

**Modify:**
- `package.json` — add `"test:warmup": "node --import ./tests/helpers/at-loader.mjs --test tests/warmup-*.test.mjs"` script (red-team #9). All other phases use this script for verification.

## Implementation Steps

### Step 1: Write failing tests

Create `tests/warmup-notifier.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetForTests,
  buildDiscordPayload,
  buildGenericPayload,
  buildTelegramPayload,
  isValidDiscordWebhook,
  isValidHttpUrl,
  isValidPublicHttpUrl,
  isValidTelegramToken,
  logBootStatus,
  recordFailure,
  recordSuccess,
  redactSecrets,
  tryReserveFailureSlot,
  tryReserveRecoverySlot,
} from "../src/lib/warmup/notifier.js";

test("isValidDiscordWebhook accepts canonical discord webhook hosts", () => {
  assert.equal(isValidDiscordWebhook("https://discord.com/api/webhooks/123/abc"), true);
  assert.equal(isValidDiscordWebhook("https://canary.discord.com/api/webhooks/123/abc"), true);
  assert.equal(isValidDiscordWebhook("https://example.com/webhook"), false);
  assert.equal(isValidDiscordWebhook("http://discord.com/api/webhooks/x/y"), false);
  assert.equal(isValidDiscordWebhook(""), false);
});

test("isValidTelegramToken matches Telegram BotFather format", () => {
  assert.equal(isValidTelegramToken("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), true);
  assert.equal(isValidTelegramToken("123:short"), false);
  assert.equal(isValidTelegramToken("nope"), false);
  assert.equal(isValidTelegramToken(""), false);
});

test("isValidHttpUrl accepts http and https public targets, rejects loopback/private", () => {
  // Red-team #1: this test's earlier version accepted 127.0.0.1; deny-list now blocks it.
  assert.equal(isValidHttpUrl("https://example.com/webhook"), true);
  assert.equal(isValidHttpUrl("http://example.com:9000/x"), true);
  assert.equal(isValidHttpUrl("http://127.0.0.1:9000/x"), false);  // CHANGED — was true
  assert.equal(isValidHttpUrl("ftp://example.com"), false);
  assert.equal(isValidHttpUrl("not-a-url"), false);
});

test("Discord payload includes schedule, connection, time, error and uses code fences", () => {
  const payload = buildDiscordPayload("failure", {
    schedule: { id: "s1", name: "Weekday warmup", timezone: "Asia/Ho_Chi_Minh" },
    connection: { id: "c1", name: "Claude-A", provider: "claude" },
    run: { localDate: "2026-05-19", localTime: "09:00", error: "401 unauthorized" },
  });
  assert.ok(payload.content.includes("Warmup failed"));
  assert.ok(payload.content.includes("Weekday warmup"));
  assert.ok(payload.content.includes("Claude-A"));
  assert.ok(payload.content.includes("2026-05-19 09:00"));
  assert.ok(payload.content.includes("401 unauthorized"));
});

test("Discord recovery payload mentions consecutive fails count", () => {
  const payload = buildDiscordPayload("recovery", {
    schedule: { id: "s1", name: "X", timezone: "UTC" },
    connection: { id: "c1", name: "A", provider: "claude" },
    run: { localDate: "2026-05-19", localTime: "10:00" },
    distinctFails: 4,
  });
  assert.ok(payload.content.includes("recovered"));
  assert.ok(payload.content.includes("4"));
});

test("Telegram payload uses parse_mode Markdown and chat_id", () => {
  const payload = buildTelegramPayload(
    "failure",
    {
      schedule: { id: "s1", name: "X", timezone: "UTC" },
      connection: { id: "c1", name: "A", provider: "claude" },
      run: { localDate: "2026-05-19", localTime: "10:00", error: "boom" },
    },
    "987654321"
  );
  assert.equal(payload.chat_id, "987654321");
  assert.equal(payload.parse_mode, "Markdown");
  assert.ok(payload.text.includes("Warmup Failed"));
  assert.ok(payload.text.includes("boom"));
});

test("Generic payload includes event name and structured fields", () => {
  const payload = buildGenericPayload("failure", {
    schedule: { id: "s1", name: "X", timezone: "UTC" },
    connection: { id: "c1", name: "A", provider: "claude" },
    run: { localDate: "2026-05-19", localTime: "10:00", scheduledForUtc: "2026-05-19T03:00:00.000Z", error: "boom" },
  });
  assert.equal(payload.event, "warmup.failure");
  assert.equal(payload.schedule.id, "s1");
  assert.equal(payload.provider.connectionId, "c1");
  assert.equal(payload.run.localTime, "10:00");
  assert.equal(payload.error, "boom");
  assert.ok(payload.timestamp);
});

test("recovery state: success without prior failures does not emit", () => {
  __resetForTests();
  const r = recordSuccess("conn-a");
  assert.equal(r.shouldEmitRecovery, false);
  assert.equal(r.distinctFails, 0);
});

test("recovery state: success below threshold resets counter, does not emit", () => {
  __resetForTests({ recoveryAfterFails: 3 });
  recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:10:00");
  const r = recordSuccess("conn-a");
  assert.equal(r.shouldEmitRecovery, false);
  assert.equal(r.distinctFails, 2);
  const next = recordSuccess("conn-a");
  assert.equal(next.distinctFails, 0);
});

test("recovery state: success at or above threshold emits exactly once", () => {
  __resetForTests({ recoveryAfterFails: 3 });
  recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:10:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:11:00");
  const r = recordSuccess("conn-a");
  assert.equal(r.shouldEmitRecovery, true);
  assert.equal(r.distinctFails, 3);
  const next = recordSuccess("conn-a");
  assert.equal(next.shouldEmitRecovery, false);
  assert.equal(next.distinctFails, 0);
});

test("failure rate limiter allows up to cap per sliding hour, drops after", () => {
  __resetForTests({ rateLimitPerHour: 3 });
  const t0 = Date.now();
  assert.equal(tryReserveFailureSlot(t0), true);
  assert.equal(tryReserveFailureSlot(t0 + 1), true);
  assert.equal(tryReserveFailureSlot(t0 + 2), true);
  assert.equal(tryReserveFailureSlot(t0 + 3), false);
  // 61 minutes later, window slides
  assert.equal(tryReserveFailureSlot(t0 + 61 * 60 * 1000), true);
});

test("failure rate limiter cap = 0 disables sending", () => {
  __resetForTests({ rateLimitPerHour: 0 });
  assert.equal(tryReserveFailureSlot(Date.now()), false);
});

// --- Red-team #1: SSRF deny-list ---

test("isValidPublicHttpUrl rejects loopback, RFC1918, link-local, IPv6 ULA", () => {
  assert.equal(isValidPublicHttpUrl("https://example.com/x"), true);
  assert.equal(isValidPublicHttpUrl("http://127.0.0.1:9000/x"), false);
  assert.equal(isValidPublicHttpUrl("http://localhost/x"), false);
  assert.equal(isValidPublicHttpUrl("http://10.0.0.1/x"), false);
  assert.equal(isValidPublicHttpUrl("http://192.168.1.1/x"), false);
  assert.equal(isValidPublicHttpUrl("http://172.16.0.1/x"), false);
  assert.equal(isValidPublicHttpUrl("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isValidPublicHttpUrl("http://[::1]/x"), false);
  assert.equal(isValidPublicHttpUrl("http://[fc00::1]/x"), false);
});

// --- Red-team #3: secret redaction ---

test("redactSecrets strips configured token and webhook URL substrings", () => {
  __resetForTests({
    telegramToken: "999999:LEAKABLE_TOKEN_VALUE_AAAAAAAAAAAAAAAAAA",
    discordUrl: "https://discord.com/api/webhooks/123/SECRET_TOKEN_AAAA",
    genericUrl: "https://hook.example.com/webhook/PRIVATE",
  });
  const sample = "fetch failed for https://api.telegram.org/bot999999:LEAKABLE_TOKEN_VALUE_AAAAAAAAAAAAAAAAAA/sendMessage and discord.com/api/webhooks/123/SECRET_TOKEN_AAAA";
  const redacted = redactSecrets(sample);
  assert.equal(redacted.includes("LEAKABLE"), false);
  assert.equal(redacted.includes("SECRET_TOKEN_AAAA"), false);
});

test("redactSecrets catches generic bot{N}:{token} pattern even when not in config", () => {
  __resetForTests({});
  const sample = "Bearer bot999:UnknownButLooksLikeBotTokenAAAAAAAA";
  const redacted = redactSecrets(sample);
  assert.equal(redacted.includes("UnknownButLooksLikeBotToken"), false);
});

// --- Red-team #4: Discord allowed_mentions + truncate ---

test("Discord payload sets allowed_mentions parse=[] and truncates long error", () => {
  const longErr = "@everyone " + "x".repeat(5000);
  const payload = buildDiscordPayload("failure", {
    schedule: { id: "s1", name: "X", timezone: "UTC" },
    connection: { id: "c1", name: "A", provider: "claude" },
    run: { localDate: "2026-05-19", localTime: "10:00", error: longErr },
  });
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.ok(payload.content.length <= 2000); // Discord hard limit
  assert.ok(!payload.content.includes("@everyone"));
});

// --- Red-team #7: Telegram MarkdownV2 escape ---

test("Telegram payload uses MarkdownV2 and escapes special chars", () => {
  const payload = buildTelegramPayload(
    "failure",
    {
      schedule: { id: "s1", name: "Foo *bar* [baz]", timezone: "UTC" },
      connection: { id: "c1", name: "A_B", provider: "claude" },
      run: { localDate: "2026-05-19", localTime: "10:00", error: "prompt too long: 200_001 > 200_000" },
    },
    "987654321"
  );
  assert.equal(payload.parse_mode, "MarkdownV2");
  assert.equal(payload.text.includes("200\\_001"), true); // underscore escaped
  assert.equal(payload.text.includes("Foo \\*bar\\* \\[baz\\]"), true);
});

// --- Red-team #6: recovery counter dedupes by slot ---

test("recordFailure on same (connectionId, dedupeKey) does NOT inflate counter", () => {
  __resetForTests({ recoveryAfterFails: 3 });
  const r1 = recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  const r2 = recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  const r3 = recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  assert.equal(r1.distinctFails, 1);
  assert.equal(r2.distinctFails, 1);
  assert.equal(r3.distinctFails, 1);
  const success = recordSuccess("conn-a");
  assert.equal(success.shouldEmitRecovery, false); // only 1 distinct slot failed
});

test("recordFailure on distinct slots accumulates to threshold", () => {
  __resetForTests({ recoveryAfterFails: 3 });
  recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:10:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:11:00");
  const success = recordSuccess("conn-a");
  assert.equal(success.shouldEmitRecovery, true);
  assert.equal(success.distinctFails, 3);
});

// --- Red-team #15: separate recovery budget ---

test("recovery budget is independent from failure budget", () => {
  __resetForTests({ rateLimitPerHour: 1, recoveryRateLimitPerHour: 1 });
  const t0 = Date.now();
  assert.equal(tryReserveFailureSlot(t0), true);
  assert.equal(tryReserveFailureSlot(t0 + 1), false);   // failure cap exhausted
  assert.equal(tryReserveRecoverySlot(t0 + 2), true);   // recovery bucket unaffected
  assert.equal(tryReserveRecoverySlot(t0 + 3), false);
});

// --- Red-team #13: boot log surfaces state size ---

test("logBootStatus emits recoveryState.size and rateLimitWindow.length and recoveryWindow.length", () => {
  __resetForTests({});
  const lines = [];
  const origLog = console.log;
  console.log = (line) => lines.push(line);
  try { logBootStatus(); } finally { console.log = origLog; }
  const parsed = JSON.parse(lines.at(-1));
  assert.equal(parsed.event, "boot");
  assert.equal(typeof parsed["recoveryState.size"], "number");
  assert.equal(typeof parsed["rateLimitWindow.length"], "number");
  assert.equal(typeof parsed["recoveryWindow.length"], "number");
});
```

### Step 2: Run tests and verify FAIL

```bash
npm run test:warmup -- tests/warmup-notifier.test.mjs
```

(Equivalent: `node --import ./tests/helpers/at-loader.mjs --test tests/warmup-notifier.test.mjs`. The `@/` path resolver MUST be wired via `--import ./tests/helpers/at-loader.mjs` — verified by checking `tests/helpers/at-resolver.mjs` exists. Without it, tests crash on `import "@/lib/..."`. Red-team #9.)

Expected: module-not-found error for `src/lib/warmup/notifier.js`.

### Step 3: Implement `src/lib/warmup/notifier.js`

Module skeleton (key contracts shown — full implementation must satisfy all tests INCLUDING the red-team coverage added in Step 1).

Required public exports after red-team review:
- `notifyWarmupFailure(ctx)`, `notifyWarmupRecovery(ctx)`, `notifyWarmupDigest({...})`
- `recordFailure(connectionId, dedupeKey)`, `recordSuccess(connectionId)`
- `tryReserveFailureSlot(now?)`, `tryReserveRecoverySlot(now?)`
- `isValidDiscordWebhook(url)`, `isValidTelegramToken(token)`, `isValidPublicHttpUrl(url)`, `isPrivateOrLoopbackIp(ip)`
- `buildDiscordPayload`, `buildTelegramPayload`, `buildGenericPayload`, `buildDigestPayload`
- `redactSecrets(text)` — uses module-cached config to know what to strip
- `escapeMarkdownV2(text)`
- `logBootStatus()`
- `getNotifierConfig()`
- `__resetForTests(overrides)`

Key skeleton hints:

```js
// src/lib/warmup/notifier.js
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { lookup as dnsLookup } from "node:dns/promises";

const DEFAULT_RATE_LIMIT_PER_HOUR = 30;
const DEFAULT_RECOVERY_RATE_LIMIT_PER_HOUR = 5;          // red-team #15
const DEFAULT_RECOVERY_AFTER_FAILS = 3;
const FETCH_TIMEOUT_MS = 5000;
const DISCORD_MAX_CONTENT = 2000;                        // Discord hard limit
const ERROR_TRUNCATE = 1500;                             // red-team #4
const TELEGRAM_TOKEN_RE = /^\d{1,12}:[A-Za-z0-9_-]{30,80}$/;   // red-team #3 (bounded)
const DISCORD_WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,80}$/;
const HTTP_URL_RE = /^https?:\/\/.+/;
const BOT_TOKEN_PATTERN_RE = /bot\d{1,12}:[A-Za-z0-9_-]{20,}/g;   // catch-all redaction (red-team #3)

let CONFIG = null;
const recoveryState = new Map();           // connectionId -> Set<dedupeKey>  (red-team #6)
const rateLimitWindow = [];                // failure budget: sorted ascending timestamps (ms)
const recoveryWindow = [];                 // recovery budget (red-team #15)

function readEnv(env = process.env) {
  const enabled = String(env.WARMUP_NOTIFY_ENABLED || "").toLowerCase() === "true";
  const discordUrl = String(env.WARMUP_NOTIFY_DISCORD_WEBHOOK || "").trim();
  const telegramToken = String(env.WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN || "").trim();
  const telegramChatId = String(env.WARMUP_NOTIFY_TELEGRAM_CHAT_ID || "").trim();
  const genericUrl = String(env.WARMUP_NOTIFY_GENERIC_WEBHOOK_URL || "").trim();
  const proxyUrl = String(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || "").trim() || null;
  const rateLimitPerHour = parseInt(env.WARMUP_NOTIFY_RATE_LIMIT_PER_HOUR || "", 10);
  const recoveryRateLimitPerHour = parseInt(env.WARMUP_NOTIFY_RECOVERY_RATE_LIMIT_PER_HOUR || "", 10);
  const recoveryAfterFails = parseInt(env.WARMUP_NOTIFY_RECOVERY_AFTER_FAILS || "", 10);

  // red-team #1: generic must pass public-URL check (deny private targets)
  const genericValid = !!genericUrl && isValidPublicHttpUrl(genericUrl);

  return Object.freeze({
    enabled,
    discord: {
      enabled: !!discordUrl && isValidDiscordWebhook(discordUrl),
      url: discordUrl,
      reason: !discordUrl ? "unset" : isValidDiscordWebhook(discordUrl) ? "ok" : "invalid_config",
    },
    telegram: {
      enabled: !!telegramToken && !!telegramChatId && isValidTelegramToken(telegramToken),
      token: telegramToken,
      chatId: telegramChatId,
      reason: !telegramToken || !telegramChatId
        ? "unset"
        : isValidTelegramToken(telegramToken) ? "ok" : "invalid_config",
    },
    generic: {
      enabled: genericValid,
      url: genericUrl,
      reason: !genericUrl ? "unset" : genericValid ? "ok" : "invalid_config",
    },
    proxyUrl,
    rateLimitPerHour: Number.isFinite(rateLimitPerHour) && rateLimitPerHour >= 0 ? rateLimitPerHour : DEFAULT_RATE_LIMIT_PER_HOUR,
    recoveryRateLimitPerHour: Number.isFinite(recoveryRateLimitPerHour) && recoveryRateLimitPerHour >= 0 ? recoveryRateLimitPerHour : DEFAULT_RECOVERY_RATE_LIMIT_PER_HOUR,
    recoveryAfterFails: Number.isFinite(recoveryAfterFails) && recoveryAfterFails >= 1 ? recoveryAfterFails : DEFAULT_RECOVERY_AFTER_FAILS,
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

// Legacy export kept for tests already calling isValidHttpUrl — delegates to public-URL check.
// red-team #1: enforce deny-list at this layer too.
export const isValidHttpUrl = isValidPublicHttpUrl;

// red-team #6: counter dedupes by (connectionId, dedupeKey)
export function recordFailure(connectionId, dedupeKey) {
  let set = recoveryState.get(connectionId);
  if (!set) { set = new Set(); recoveryState.set(connectionId, set); }
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

// red-team #15: two independent budgets
export function tryReserveFailureSlot(nowMs = Date.now()) {
  return tryReserve(rateLimitWindow, getNotifierConfig().rateLimitPerHour, nowMs);
}
export function tryReserveRecoverySlot(nowMs = Date.now()) {
  return tryReserve(recoveryWindow, getNotifierConfig().recoveryRateLimitPerHour, nowMs);
}
function tryReserve(window, cap, nowMs) {
  if (cap <= 0) return false;
  const cutoff = nowMs - 60 * 60 * 1000;
  while (window.length && window[0] < cutoff) window.shift();
  if (window.length >= cap) return false;
  window.push(nowMs);
  return true;
}

// red-team #1: SSRF deny-list
const PRIVATE_IPV4 = [
  [0x7F000000, 0xFF000000], // 127.0.0.0/8
  [0x0A000000, 0xFF000000], // 10.0.0.0/8
  [0xAC100000, 0xFFF00000], // 172.16.0.0/12
  [0xC0A80000, 0xFFFF0000], // 192.168.0.0/16
  [0xA9FE0000, 0xFFFF0000], // 169.254.0.0/16 (link-local incl. cloud metadata)
];
export function isPrivateOrLoopbackIp(ip) {
  if (typeof ip !== "string") return true;
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const n = ((+m[1]) << 24 | (+m[2]) << 16 | (+m[3]) << 8 | (+m[4])) >>> 0;
  return PRIVATE_IPV4.some(([net, mask]) => (n & mask) === (net & mask));
}
export function isValidPublicHttpUrl(url) {
  if (typeof url !== "string" || !HTTP_URL_RE.test(url)) return false;
  let parsed; try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return false;
  // literal IP → deny-list applies right away
  if (/^[\d.]+$/.test(host) || host.includes(":")) return !isPrivateOrLoopbackIp(host);
  return true; // hostname: resolved + re-checked at send time
}
async function isHostSendable(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return false;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return !isPrivateOrLoopbackIp(host);
  try {
    const results = await dnsLookup(host, { all: true });
    return results.length > 0 && results.every((r) => !isPrivateOrLoopbackIp(r.address));
  } catch { return false; }
}

// red-team #3: redactor
export function redactSecrets(text) {
  const cfg = getNotifierConfig();
  let out = String(text ?? "");
  if (cfg.discord.url)   out = out.split(cfg.discord.url).join("[redacted-discord-url]");
  if (cfg.generic.url)   out = out.split(cfg.generic.url).join("[redacted-generic-url]");
  if (cfg.telegram.token) out = out.split(cfg.telegram.token).join("[redacted-telegram-token]");
  out = out.replace(BOT_TOKEN_PATTERN_RE, "bot[redacted]");
  return out;
}

// red-team #7: MarkdownV2 escaper per Telegram docs
export function escapeMarkdownV2(text) {
  return String(text ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// Payload builders — must mention schedule.name, connection.name, run.localDate + localTime,
// run.error (failure only), ctx.distinctFails (recovery only).
// Discord MUST include allowed_mentions:{parse:[]} and truncate error to ERROR_TRUNCATE (red-team #4).
// Telegram MUST use parse_mode:"MarkdownV2" and escape all user-controlled fields (red-team #7).
export function buildDiscordPayload(kind, ctx) { /* ... allowed_mentions:{parse:[]}, content<=DISCORD_MAX_CONTENT ... */ }
export function buildTelegramPayload(kind, ctx, chatId) { /* ... parse_mode:"MarkdownV2", escapeMarkdownV2(field) for every interpolation ... */ }
export function buildGenericPayload(kind, ctx) { /* ... */ }
export function buildDigestPayload(channel, batch) { /* red-team #2 — channel-aware summary */ }

// Channel adapters — undici.fetch (+ optional ProxyAgent) with AbortSignal.timeout(FETCH_TIMEOUT_MS).
// Return { ok, statusCode?, reason }. reason is run through redactSecrets() before being returned.
// Pre-flight: await isHostSendable(url) returns true; otherwise return { ok:false, reason:"private_target_blocked" }.
async function sendDiscord(payload, url, dispatcher) { /* ... */ }
async function sendTelegram(payload, token, chatId, dispatcher) { /* ... */ }
async function sendGeneric(payload, url, dispatcher) { /* ... */ }
function classifyFetchError(e) {
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout_5s";
  const code = e?.cause?.code || e?.code;
  return code ? String(code) : "network_error";
}

export async function notifyWarmupFailure(ctx) {
  try {
    const cfg = getNotifierConfig();
    if (!cfg.enabled) return;
    if (!tryReserveFailureSlot()) { log({ level: "info", event: "rate_limited", kind: "failure", capPerHour: cfg.rateLimitPerHour }); return; }
    await fanOut("failure", cfg, ctx);
  } catch (error) {
    log({ level: "error", event: "notify_exception", kind: "failure", reason: redactSecrets(String(error?.message || error)) });
  }
}

export async function notifyWarmupRecovery(ctx) {
  try {
    const cfg = getNotifierConfig();
    if (!cfg.enabled) return;
    // recovery uses its own budget (red-team #15)
    if (!tryReserveRecoverySlot()) { log({ level: "info", event: "rate_limited", kind: "recovery", capPerHour: cfg.recoveryRateLimitPerHour }); return; }
    await fanOut("recovery", cfg, ctx);
  } catch (error) {
    log({ level: "error", event: "notify_exception", kind: "recovery", reason: redactSecrets(String(error?.message || error)) });
  }
}

// red-team #2: digest mode for catch-up batches
export async function notifyWarmupDigest({ batch }) {
  try {
    const cfg = getNotifierConfig();
    if (!cfg.enabled || !Array.isArray(batch) || !batch.length) return;
    if (!tryReserveFailureSlot()) { log({ level: "info", event: "rate_limited", kind: "digest", capPerHour: cfg.rateLimitPerHour }); return; }
    await fanOutDigest(cfg, batch);
  } catch (error) {
    log({ level: "error", event: "notify_exception", kind: "digest", reason: redactSecrets(String(error?.message || error)) });
  }
}

async function fanOut(kind, cfg, ctx) {
  const dispatcher = cfg.proxyUrl ? new ProxyAgent({ uri: cfg.proxyUrl }) : undefined;
  const jobs = [];
  if (cfg.discord.enabled)  jobs.push(sendDiscord(buildDiscordPayload(kind, ctx), cfg.discord.url, dispatcher).then(r => ({ channel: "discord", ...r })));
  if (cfg.telegram.enabled) jobs.push(sendTelegram(buildTelegramPayload(kind, ctx, cfg.telegram.chatId), cfg.telegram.token, cfg.telegram.chatId, dispatcher).then(r => ({ channel: "telegram", ...r })));
  if (cfg.generic.enabled)  jobs.push(sendGeneric(buildGenericPayload(kind, ctx), cfg.generic.url, dispatcher).then(r => ({ channel: "generic", ...r })));
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
        reason: r.reason ? redactSecrets(r.reason) : null,
        connectionId: ctx?.connection?.id,
        scheduleId: ctx?.schedule?.id,
      });
    } else {
      log({ level: "warn", event: "send_failed", kind, reason: redactSecrets(String(s.reason?.message || s.reason)) });
    }
  }
}

async function fanOutDigest(cfg, batch) {
  const dispatcher = cfg.proxyUrl ? new ProxyAgent({ uri: cfg.proxyUrl }) : undefined;
  const jobs = [];
  if (cfg.discord.enabled)  jobs.push(sendDiscord(buildDigestPayload("discord", batch),  cfg.discord.url, dispatcher).then(r => ({ channel: "discord", ...r })));
  if (cfg.telegram.enabled) jobs.push(sendTelegram(buildDigestPayload("telegram", batch), cfg.telegram.token, cfg.telegram.chatId, dispatcher).then(r => ({ channel: "telegram", ...r })));
  if (cfg.generic.enabled)  jobs.push(sendGeneric(buildDigestPayload("generic", batch),  cfg.generic.url, dispatcher).then(r => ({ channel: "generic", ...r })));
  const settled = await Promise.allSettled(jobs);
  // ... same log loop as fanOut() ...
}

// red-team #13: surface state size so operators detect restarts
export function logBootStatus() {
  const cfg = getNotifierConfig();
  log({
    level: "info",
    event: "boot",
    enabled: cfg.enabled,
    channels: { discord: cfg.discord.reason, telegram: cfg.telegram.reason, generic: cfg.generic.reason },
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
  // every dynamic string field MUST already be redactor-clean — but apply once more defensively
  const safe = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, typeof v === "string" ? redactSecrets(v) : v])
  );
  console.log(JSON.stringify({ at: "warmup.notifier", ts: new Date().toISOString(), ...safe }));
}

// Test hook — never used in production code paths
export function __resetForTests(overrides = {}) {
  recoveryState.clear();
  rateLimitWindow.length = 0;
  recoveryWindow.length = 0;
  CONFIG = Object.freeze({
    enabled: true,
    discord:  { enabled: !!overrides.discordUrl,   url: overrides.discordUrl   || "",                        reason: overrides.discordUrl   ? "ok" : "unset" },
    telegram: { enabled: !!overrides.telegramToken, token: overrides.telegramToken || "", chatId: overrides.telegramChatId || "", reason: overrides.telegramToken ? "ok" : "unset" },
    generic:  { enabled: !!overrides.genericUrl,   url: overrides.genericUrl   || "",                        reason: overrides.genericUrl   ? "ok" : "unset" },
    proxyUrl: overrides.proxyUrl || null,
    rateLimitPerHour:        overrides.rateLimitPerHour        ?? DEFAULT_RATE_LIMIT_PER_HOUR,
    recoveryRateLimitPerHour: overrides.recoveryRateLimitPerHour ?? DEFAULT_RECOVERY_RATE_LIMIT_PER_HOUR,
    recoveryAfterFails:      overrides.recoveryAfterFails      ?? DEFAULT_RECOVERY_AFTER_FAILS,
  });
}
```

### Step 4: Run tests and verify PASS

```bash
npm run test:warmup -- tests/warmup-notifier.test.mjs
```

Expected: all tests pass.

### Step 5: Syntax check

```bash
node --check src/lib/warmup/notifier.js
```

### Step 6: Commit

```bash
git add src/lib/warmup/notifier.js tests/warmup-notifier.test.mjs package.json
git commit -m "feat(warmup): add notifier module (env-driven, SSRF-safe, secret-redacted, no wiring yet)"
```

## Todo

- [x] Add `"test:warmup"` npm script to `package.json`
- [x] Write `tests/warmup-notifier.test.mjs` (all cases from Step 1, INCLUDING red-team coverage: SSRF deny-list, redactSecrets, Discord allowed_mentions+truncate, MarkdownV2 escape, per-slot recovery dedupe, separate recovery budget, boot state-size)
- [x] Run `npm run test:warmup` — confirm FAIL with module-not-found
- [x] Implement `src/lib/warmup/notifier.js` (env reader incl. proxy + recovery budget, validators incl. `isValidPublicHttpUrl` + IPv4/IPv6 deny-list, `redactSecrets`, `escapeMarkdownV2`, payload builders with allowed_mentions/MarkdownV2/truncate, Set-keyed recovery state, two rate buckets, undici channel adapters with `ProxyAgent`, fan-out, digest, boot log surfacing state sizes, JSON logger that runs redactor, `__resetForTests`)
- [x] Run `npm run test:warmup` — confirm PASS
- [x] `node --check` notifier.js
- [x] `npx eslint src/lib/warmup/notifier.js tests/warmup-notifier.test.mjs` — confirm clean (red-team #M10, validation theater fix)
- [x] Commit

## Success Criteria

- [x] All tests in `tests/warmup-notifier.test.mjs` PASS via `npm run test:warmup`
- [x] `notifier.js` exports the documented public API (incl. `notifyWarmupDigest`, `redactSecrets`, `escapeMarkdownV2`, `isValidPublicHttpUrl`)
- [x] Channel adapter calls use `undici.fetch` with optional `ProxyAgent` dispatcher when `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` is set; `AbortSignal.timeout(5000)`
- [x] No tokens / URLs appear in ANY log line — proven by the redactor test
- [x] All `console.log` calls in notifier produce single-line JSON
- [x] SSRF deny-list test covers loopback / RFC1918 / link-local / IPv6 ULA
- [x] Discord payload test asserts `allowed_mentions: { parse: [] }` and ≤2000-char total content
- [x] Telegram payload test asserts `parse_mode: "MarkdownV2"` and special-char escaping
- [x] Recovery counter de-dupe test: same `(connectionId, dedupeKey)` triple does NOT accumulate
- [x] Separate recovery budget test: failure cap exhaustion does not block recovery alerts
- [x] `package.json` contains `test:warmup` script

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Module-level config cached → tests need reset | Expose `__resetForTests()` (test-only); accept that env rotation requires process restart and document in `.env.example` |
| Fetch hang on unreachable webhook | `undici.fetch` + `AbortSignal.timeout(5000)` |
| Token / URL leaks in error message | `redactSecrets(text, cfg)` applied to EVERY log line before `JSON.stringify`. Test injects fake fetch error containing token, asserts absence in stdout. (red-team #3) |
| Recovery counter grows unbounded for connections that never succeed (e.g. disabled provider) | Skip notify path entirely for `connection.isActive === false` errors (handled in Phase 2). Plus: Set-based counter is bounded by distinct slots, not events. (red-team #14) |
| `AbortSignal.timeout` produces opaque "operation aborted" | Each adapter catches and tags: `e?.name === "TimeoutError"` → `"timeout_5s"`; `e?.cause?.code` → network code; else `"network_error"`. Adapter return shape: `{ ok, statusCode?, reason }` |
| Proxy-blocked outbound silently dies | `undici.ProxyAgent` honors `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`. Boot log includes `proxy: "<host>" | null` so operator sees whether proxy is active |
| Discord 2000-char limit breach | Truncate `error` to 1500 chars (leaves 500-char budget for the template wrapper) |
| Telegram MarkdownV2 silent 400 on special chars | `escapeMarkdownV2()` applied to all dynamic fields; covered by test with `_*[]()~` |
| SSRF via DNS rebinding | Hostname re-resolved at send time, all returned IPs checked against deny-list |
