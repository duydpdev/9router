---
phase: 3
title: Reauth notifier (bridge to warmup notifier)
status: completed
priority: P1
effort: 3-4h
dependencies:
  - 1
---

# Phase 3: Reauth notifier — bridge to existing warmup notifier

## Overview

Build a small bridge module `src/lib/notifier/reauth-alert.js` that calls the existing `src/lib/warmup/notifier.js` plumbing (Discord webhook / Telegram / generic webhook) with a `[REAUTH]` prefix and a reconnect deep-link. Reuses warmup ENV vars verbatim (no new config). Dedupes via `markReauthNotified` from Phase 1. No callers yet — Phase 4 wires it.

## Requirements

- Functional
  - Export `notifyReauthRequired({ connection, reason, reauthAt })` → fans out across configured channels.
  - Message subject: `[REAUTH] <provider>/<connectionName> needs reconnect`.
  - Body includes: provider, connection email/display, reason enum, reauthAt timestamp, deep-link URL.
  - Deep-link URL = `${BASE_URL}/dashboard/providers/<provider>?reconnect=<connId>` — `BASE_URL` resolved via existing env (`BASE_URL` ?? `NEXT_PUBLIC_BASE_URL` ?? `http://localhost:20128`).
  - Dedup: function first attempts `markReauthNotified(connectionId, { reauthAt })`. If it returns `false`, skip all webhook calls (already notified).
  - Use the same SSRF / token validators that warmup notifier already exports.
- Non-functional
  - Zero new ENV variables.
  - Notifier failure (network / 4xx from webhook) MUST NOT block the request path — fire-and-forget with logged error.
  - Total work added to request path: < 50 ms in the happy path (dedup hits early).

## Architecture

```
src/lib/notifier/reauth-alert.js (NEW)
└── notifyReauthRequired({ connection, reason, reauthAt }) → Promise<{notified: bool}>
       1. const claimed = await markReauthNotified(connection.id, { reauthAt })
       2. if (!claimed) return { notified: false }
       3. const ctx = buildReauthCtx(connection, reason, reauthAt, deepLink)
       4. fanOut to discord/telegram/generic — reuse warmup notifier's
            buildDiscordPayload / buildTelegramPayload / buildGenericPayload
            patterns. Either:
              (a) call warmup notifier internal builders (export them), OR
              (b) duplicate the small payload structs locally with [REAUTH] prefix.
            Prefer (a) — DRY. Phase will refactor warmup/notifier.js to export
            its builders if not already exported.
       5. log result; never throw to caller.
```

`buildReauthCtx` shape:
```js
{
  kind: "reauth",
  prefix: "[REAUTH]",
  title: `${provider}/${connectionName} needs reconnect`,
  fields: {
    provider, connectionId, connectionName, email, reason, reauthAt,
  },
  deepLinkUrl,
}
```

## Related Code Files

- Create: `src/lib/notifier/reauth-alert.js`
- Modify: `src/lib/warmup/notifier.js` — export `buildDiscordPayload`, `buildTelegramPayload`, `buildGenericPayload`, `getNotifierConfig`, `tryReserveFailureSlot` if not already public (scout report shows they exist as named functions; check actual `export` statements).
- Create: `tests/notifier/reauth-alert.test.js`

## TDD — failing tests first

`reauth-alert.test.js`:
1. **Dedup happy path** — call `notifyReauthRequired(...)` twice with same `reauthAt`. Expect exactly one fanout call (mock the channel calls).
2. **Dedup across reauthAt bumps** — call once → reset row's `reauthNotifiedAt=null` and bump `reauthAt` → call again. Expect two fanout calls.
3. **No webhook env set** → fanout call list is empty, function still returns `{notified: false}` or `{notified: true, channels: []}` without throwing.
4. **Discord-only env** — `DISCORD_WEBHOOK_URL` set → exactly one Discord call, payload includes `[REAUTH]` prefix in `content` or embed title.
5. **Generic webhook env** — `GENERIC_WEBHOOK_URL` set → POST body JSON contains `kind: "reauth"`, `deepLinkUrl: …`, `connectionId: …`.
6. **Deep-link URL builder** — given `BASE_URL=https://example.test`, provider=`claude-code`, connId=`abc-123` → URL is `https://example.test/dashboard/providers/claude-code?reconnect=abc-123`.
7. **Webhook 500 response** → function returns `{notified: true, errors: [...]}` and the surrounding request path receives no exception.
8. **Network timeout** → swallowed; logged; function resolves.

Run all → confirm red.

## Implementation Steps

1. **Write failing tests** (1–8). Confirm red.
2. Audit `src/lib/warmup/notifier.js` exports — ensure builders are exported (export them if not). If renaming/extending the module is too invasive, instead pull the minimum needed (Discord webhook URL regex, retry+timeout fetch wrapper, ProxyAgent dispatcher) into a tiny shared module `src/lib/notifier/transport.js` and have both warmup notifier and reauth-alert import from it. Prefer the simpler "export builders directly" path; only DRY out if a duplication smell appears.
3. Implement `src/lib/notifier/reauth-alert.js`:
   ```js
   import { markReauthNotified } from "@/lib/oauth/reauth-state.js";
   import {
     getNotifierConfig,
     buildDiscordPayload,
     buildTelegramPayload,
     buildGenericPayload,
     postWebhook,        // exported transport helper
   } from "@/lib/warmup/notifier.js";

   function resolveBaseUrl() {
     return process.env.BASE_URL
         || process.env.NEXT_PUBLIC_BASE_URL
         || "http://localhost:20128";
   }

   function deepLink(connection) {
     const base = resolveBaseUrl().replace(/\/+$/, "");
     return `${base}/dashboard/providers/${connection.provider}?reconnect=${connection.id}`;
   }

   export async function notifyReauthRequired({ connection, reason, reauthAt }) {
     const claimed = await markReauthNotified(connection.id, { reauthAt });
     if (!claimed) return { notified: false, deduped: true };
     const ctx = {
       kind: "reauth",
       prefix: "[REAUTH]",
       title: `${connection.provider}/${connection.name || connection.email || connection.id} needs reconnect`,
       fields: {
         provider: connection.provider,
         connectionId: connection.id,
         connectionName: connection.name,
         email: connection.email,
         reason,
         reauthAt,
       },
       deepLinkUrl: deepLink(connection),
     };
     const cfg = getNotifierConfig();
     const tasks = [];
     if (cfg.discord?.webhookUrl) tasks.push(postWebhook("discord", cfg.discord.webhookUrl, buildDiscordPayload("reauth", ctx)));
     if (cfg.telegram?.botToken && cfg.telegram?.chatIds?.length) {
       for (const chatId of cfg.telegram.chatIds) {
         tasks.push(postWebhook("telegram", cfg.telegram, buildTelegramPayload("reauth", ctx, chatId)));
       }
     }
     if (cfg.generic?.url) tasks.push(postWebhook("generic", cfg.generic.url, buildGenericPayload("reauth", ctx)));
     const results = await Promise.allSettled(tasks);
     return { notified: true, deduped: false, channels: results.length, errors: results.filter(r => r.status === "rejected").map(r => r.reason?.message ?? r.reason) };
   }
   ```
4. Extend warmup notifier's `buildDiscordPayload`, `buildTelegramPayload`, `buildGenericPayload` to handle `kind === "reauth"` — emit:
   - Discord: embed title `[REAUTH] <title>`, fields (provider, reason, reauthAt), description w/ deep-link button-style URL.
   - Telegram: text message with `[REAUTH]` prefix + reconnect link (markdown).
   - Generic: `{ kind: "reauth", title, fields, deepLinkUrl }`.
5. Run tests — green.
6. Manual smoke: in dev, set `DISCORD_WEBHOOK_URL`, manually call `await notifyReauthRequired({ connection: fixture, reason: "invalid_grant", reauthAt: "2026-05-24T03:00:00Z" })`. Confirm webhook arrives with deep-link.

## Success Criteria

- [ ] All 8 tests pass.
- [ ] Dedup is verified — second call within same `reauthAt` window does NOT call the webhook.
- [ ] Webhook failure does NOT throw to caller.
- [ ] Deep-link URL is correctly formed for all providers (test parameterized on 12 providers).
- [ ] No new ENV variables introduced.

## Risk Assessment

| Risk | Mitigation |
| ---- | ---------- |
| Warmup notifier internals not designed for external reuse | Phase 3 step 2 makes the export decision: either expose builders, or extract a tiny `notifier/transport.js`. Prefer YAGNI export over premature refactor. |
| Telegram/Discord rate limits (429) | Warmup notifier already has `tryReserveFailureSlot` rate limiter. Reauth fires at most once per `(connectionId, reauthAt)` — rarer than warmup failure noise. Skip extra rate-limit budget. |
| Deep-link leaks via Discord channel logs | Anyone with the link still needs dashboard auth cookie to trigger OAuth flow. Reauth URL is not a bearer token. Document in CHANGELOG. |
| `BASE_URL` env undefined in self-hosted setups | Fallback to `http://localhost:20128` — user opens link locally. For cloud/Docker deployments docs already require `BASE_URL`; surface a warning log in `resolveBaseUrl` if it falls through to localhost. |

## Next Steps

Phase 4 wires `notifyReauthRequired` into the refresh-failure catch site, alongside `markNeedsReauth`.

## Red Team Adjustments — 2026-05-24

Findings **F1, F10, F11** accepted. Multiple supersedes.

**Master gate decision (locked 2026-05-24):** Reauth notifications honor the existing `WARMUP_NOTIFY_ENABLED` master gate. When `cfg.enabled === false`, `notifyReauthRequired` returns `{notified:false, disabled:true}` immediately. No new `REAUTH_NOTIFY_ENABLED` env var. Document in Phase 8 CHANGELOG.

### F1 — Wrong ENV names + nonexistent `postWebhook` + config shape mismatch (CRITICAL)

Plan's env vars and config keys do **not** match `src/lib/warmup/notifier.js`. Real shape verified:

| Plan (WRONG) | Actual (`notifier.js`) |
|---|---|
| `DISCORD_WEBHOOK_URL` | `WARMUP_NOTIFY_DISCORD_WEBHOOK` (line 52) |
| `TELEGRAM_BOT_TOKEN` | `WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN` (line 53) |
| `TELEGRAM_CHAT_IDS` | `WARMUP_NOTIFY_TELEGRAM_CHAT_ID` — **single id**, not array (line 54) |
| `GENERIC_WEBHOOK_URL` | `WARMUP_NOTIFY_GENERIC_WEBHOOK_URL` (line 55) |
| `cfg.discord.webhookUrl` | `cfg.discord.url` (line 81-87) |
| `cfg.telegram.botToken` | `cfg.telegram.token` (line 88-95) |
| `cfg.telegram.chatIds[]` | `cfg.telegram.chatId` (single) |
| `cfg.generic.webhookUrl` | `cfg.generic.url` |
| `postWebhook` (imported) | **DOES NOT EXIST**; `sendDiscord`/`sendTelegram`/`sendGeneric` (lines 437, 449, 463) are **private** (no `export`) |
| _missing_ | `WARMUP_NOTIFY_ENABLED` master gate via `cfg.enabled` (line 51); module no-ops when `false` |

**Corrections:**

1. Use real env var names verbatim. Document in Phase 8 README/CHANGELOG.
2. Replace `postWebhook` import with concrete fns — `sendDiscord`, `sendTelegram`, `sendGeneric`. Add `export` to those three in `src/lib/warmup/notifier.js`.
3. **Master gate:** respect `cfg.enabled` (locked decision above). Single env var `WARMUP_NOTIFY_ENABLED` controls both warmup AND reauth notifications.
4. Telegram supports only ONE `chatId` in current notifier; do not iterate `chatIds[]`. If multiple chat ids are needed, add `WARMUP_NOTIFY_TELEGRAM_CHAT_IDS` (CSV) and parse — out of scope for this plan.

Rewrite step 3 import block:
```js
import {
  getNotifierConfig,
  sendDiscord, sendTelegram, sendGeneric,
} from "@/lib/warmup/notifier.js";
```

And the fanout block:
```js
const cfg = getNotifierConfig();
if (!cfg.enabled) return { notified: false, disabled: true };
const tasks = [];
if (cfg.discord?.url) tasks.push(sendDiscord(cfg.discord.url, buildReauthDiscordPayload(ctx)));
if (cfg.telegram?.token && cfg.telegram?.chatId) {
  tasks.push(sendTelegram(cfg.telegram.token, cfg.telegram.chatId, buildReauthTelegramText(ctx)));
}
if (cfg.generic?.url) tasks.push(sendGeneric(cfg.generic.url, buildReauthGenericPayload(ctx)));
```

### F10 — Build separate reauth payload functions; do NOT overload warmup builders (HIGH)

Existing `buildDiscordPayload`/`buildTelegramPayload`/`buildGenericPayload` (`notifier.js:267-363`) are hard-coded to warmup `ctx` shape (`ctx?.schedule?.name`, `ctx?.run?.localDate/error`). Adding a `kind === "reauth"` branch to all three is a tangled cross-shape extension and breaks the YAGNI "small bridge" claim. Also, the Telegram builder escapes every field via `escapeMarkdownV2` — deep-link URL chars `?=._-` get corrupted; existing `sanitizeDiscordMentions` (line 261-263) only applied to error text, not `connectionName` — user-controlled `@everyone` pings the channel.

**Build local payload functions in `src/lib/notifier/reauth-alert.js`:**

```js
import { sanitizeDiscordMentions, escapeMarkdownV2 } from "@/lib/warmup/notifier.js"; // export these two

function buildReauthDiscordPayload(ctx) {
  const safeName = sanitizeDiscordMentions(ctx.fields.connectionName ?? ctx.fields.connectionId);
  return {
    content: `${ctx.prefix} **${ctx.fields.provider}/${safeName}** needs reconnect`,
    embeds: [{
      title: ctx.title,
      url: ctx.deepLinkUrl,
      fields: [
        { name: "Reason", value: ctx.fields.reason, inline: true },
        { name: "Time", value: ctx.fields.reauthAt, inline: true },
      ],
      color: 0xf0b400,
    }],
    allowed_mentions: { parse: [] },
  };
}

function buildReauthTelegramText(ctx) {
  const safeName = escapeMarkdownV2(ctx.fields.connectionName ?? ctx.fields.connectionId);
  const safeProvider = escapeMarkdownV2(ctx.fields.provider);
  const safeReason = escapeMarkdownV2(ctx.fields.reason);
  const safeWhen = escapeMarkdownV2(ctx.fields.reauthAt);
  // URL chars stay raw INSIDE the parens of [label](url); only the label needs escaping
  return `${escapeMarkdownV2(ctx.prefix)} *${safeProvider}/${safeName}* needs reconnect\n`
       + `Reason: ${safeReason}\n`
       + `At: ${safeWhen}\n`
       + `[Reconnect](${ctx.deepLinkUrl})`;
}

function buildReauthGenericPayload(ctx) {
  return { kind: "reauth", title: ctx.title, fields: ctx.fields, deepLinkUrl: ctx.deepLinkUrl };
}
```

Add `export` to `sanitizeDiscordMentions` and `escapeMarkdownV2` in `notifier.js` (Phase 3 step 2 — already plans builder exports, just adjust the list).

Add test #9 — connection name `@everyone` → Discord payload has `content` with `everyone` (no `@`); `allowed_mentions.parse` is empty.
Add test #10 — Telegram payload preserves raw URL inside `[label](url)`; escaping only on label.

### F11 — Rate-limit window shared with warmup; reauth dropped under burst (HIGH)

`tryReserveFailureSlot` (`notifier.js:217`) consumes a single 30/hour window for warmup AND would consume same for reauth if shared. Family-revoke incident across 10 connections + active warmup notifier on same tenant → warmup saturates window → reauth gets `rate_limited` log, no webhook. Exactly when user needs notify.

**Two acceptable options — pick (a) for safety:**

(a) **Bypass rate limiter for reauth.** Justified because per-`(connectionId, reauthAt)` dedup (F6) already caps it: at most N webhooks per N distinct connections in a single incident, and dedup absorbs retries. Skip `tryReserveFailureSlot` for reauth fanout. Document in plan + CHANGELOG.

(b) Add a separate `tryReserveReauthSlot` with its own window (default 10/hour) — more code, marginal benefit since dedup is already the primary throttle.

Apply (a). Remove the "Skip extra rate-limit budget" risk-row rationale and replace with "Reauth notifier bypasses the warmup rate limiter; dedup via `markReauthNotified` is the throttle."

### F1 cont. — `BASE_URL` env never declared (MEDIUM, addressed within F1 fix)

`BASE_URL` and `NEXT_PUBLIC_BASE_URL` are not currently read anywhere in `src/**`. Fallback `http://localhost:20128` leaks into Discord webhooks for Docker / cloud users — link unreachable from phone.

Fix in `resolveBaseUrl()`:
```js
function resolveBaseUrl() {
  const base = process.env.PUBLIC_BASE_URL
            ?? process.env.BASE_URL
            ?? process.env.NEXT_PUBLIC_BASE_URL;
  if (!base) {
    log.warn("REAUTH_NOTIFY", "PUBLIC_BASE_URL not set; emitting path-only deep link");
    return null; // signal path-only
  }
  return base;
}

function deepLink(connection) {
  const base = resolveBaseUrl();
  const path = `/dashboard/providers/${connection.provider}?reconnect=${connection.id}`;
  return base ? `${base.replace(/\/+$/, "")}${path}` : path;
}
```

Phase 8 README/CHANGELOG: surface `PUBLIC_BASE_URL` as a required env for production deployments; describe path-only fallback for self-hosted.
