---
phase: 3
title: "Scheduler/API wiring + env docs"
status: completed
priority: P1
effort: "1h"
dependencies: [2]
---

# Phase 3: Scheduler/API wiring + env docs

## Overview

Opt the scheduler tick into notifications. The scheduler chooses between `{ notify: "scheduler" }` (normal tick) and `{ notify: "digest" }` (catch-up batch — when `from < now - 5 min`, indicating replay of a missed window). Leave the manual run API explicitly opted out (`{ notify: false }`). Call `notifier.logBootStatus()` once at scheduler start, BEFORE the initial `tickWarmupScheduler()` call (red-team #11). Document all `WARMUP_NOTIFY_*` env vars in `.env.example`.

## Requirements

**Functional:**
- `scheduler.tickWarmupScheduler` calls `runWarmupItems(due, { notify })` where `notify` is computed per tick:
  - `"digest"` when `from < now - 5 * 60 * 1000` (catch-up replay — red-team #2)
  - `"scheduler"` otherwise
- `src/app/api/warmup/run/route.js` calls `runWarmupItems(items, { notify: false })` (explicit, not relying on default)
- `scheduler.startWarmupScheduler` logs boot status once on first start, INSERTED at this exact position: after `if (g.interval) return;` early-return, BEFORE the `try { await tickWarmupScheduler(); }` block. (red-team #11)
- `.env.example` documents every `WARMUP_NOTIFY_*` env var with placeholder values and brief comments

**Non-functional:**
- No regression to scheduler catch-up / range-scan / `lastTickAt` semantics
- No regression to manual run guard (`tryAcquireWarmupGuard` / `releaseWarmupGuard`)
- Boot log fires exactly once per process (not per tick)
- Boot log MUST appear in stdout BEFORE any `event:"sent"` log line on initial catch-up

## Architecture

```
startWarmupScheduler()
  ├── if (g.interval) return;             // existing early-return — INSERT below
  ├── if (!g.bootLogged) {
  │     g.bootLogged = true;
  │     const { logBootStatus } = await loadNotifier();
  │     logBootStatus();                  // (NEW) — must fire BEFORE initial tick (red-team #11)
  │   }
  ├── try { await tickWarmupScheduler(); } // existing
  └── setInterval(tickWarmupScheduler, CHECK_INTERVAL_MS)

tickWarmupScheduler()
  ├── compute `from` (existing catch-up clamp logic)
  ├── const isCatchUp = (now - from) > 5 * 60 * 1000;   // (NEW) red-team #2
  ├── ... (existing setWarmupLastTickAt + findDueWarmupRunsInRange) ...
  └── if (due.length) {
        const { runWarmupItems } = await loadRunner();
        const notify = isCatchUp ? "digest" : "scheduler";   // CHANGED — was implicit true
        results = await runWarmupItems(due, { notify });
      }

POST /api/warmup/run
  └── runWarmupItems(items, { notify: false }) // CHANGED — explicit
```

## Related Code Files

**Modify:**
- `src/lib/warmup/scheduler.js`
- `src/app/api/warmup/run/route.js`
- `.env.example`

**Create:** none

## Implementation Steps

### Step 1: Wire scheduler

In `src/lib/warmup/scheduler.js`:

1. Add lazy notifier import inside `loadNotifier()`:

   ```js
   async function loadNotifier() {
     return import("@/lib/warmup/notifier");
   }
   ```

2. Add `bootLogged: false` to the `g` defaults object at the top:

   ```js
   const g = (global.__warmupScheduler ??= {
     interval: null,
     retentionInterval: null,
     running: false,
     lastTickAt: null,
     lastResult: null,
     lastClampedFrom: null,
     bootLogged: false,        // NEW
   });
   ```

3. In `startWarmupScheduler`, AFTER the existing `if (g.interval) return;` early-return AND BEFORE the `try { await tickWarmupScheduler(); }` block, insert (red-team #11):

   ```js
   export async function startWarmupScheduler() {
     if (g.interval) return;

     // NEW — fires exactly once per process. Must happen before the first tick so its
     // log line is the first warmup-notifier line in stdout, even when the first tick
     // does catch-up replay and emits many `event:"sent"` lines.
     if (!g.bootLogged) {
       g.bootLogged = true;
       try {
         const { logBootStatus } = await loadNotifier();
         logBootStatus();
       } catch (error) {
         console.log("[WarmupScheduler] notifier boot log failed:", error.message);
       }
     }

     try {
       await tickWarmupScheduler();
     } catch (error) { /* existing */ }
     // ... existing setInterval ...
   }
   ```

4. In `tickWarmupScheduler`, after `from` is computed and before the `due.length` branch, derive the `notify` mode (red-team #2):

   ```js
   const isCatchUp = (now.getTime() - from.getTime()) > 5 * 60 * 1000;

   // ... existing setWarmupLastTickAt + findDueWarmupRunsInRange ...

   if (due.length) {
     const { runWarmupItems } = await loadRunner();
     const notify = isCatchUp ? "digest" : "scheduler";   // CHANGED
     results = await runWarmupItems(due, { notify });
   }
   ```

### Step 2: Wire manual API

In `src/app/api/warmup/run/route.js`, change:

```js
const results = await runWarmupItems(items);
```

to:

```js
const results = await runWarmupItems(items, { notify: false });
```

### Step 3: Update `.env.example`

Append:

```
# Warmup failure notifications (optional)
# Master switch — leave unset or set to "false" to disable all channels cleanly (no per-tick logs).
WARMUP_NOTIFY_ENABLED=false

# Discord channel — paste an incoming-webhook URL from the target channel.
# Example: https://discord.com/api/webhooks/123456789/abcdef...
# Validator rejects invalid Discord webhook URL formats.
WARMUP_NOTIFY_DISCORD_WEBHOOK=

# Telegram channel — both variables must be set together.
# Bot token from @BotFather, chat_id from /getUpdates against the bot.
# Messages use parse_mode "MarkdownV2" with all dynamic fields escaped.
WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN=
WARMUP_NOTIFY_TELEGRAM_CHAT_ID=

# Generic JSON webhook — receives {event, schedule, provider, run, error?, timestamp}.
# SSRF guard: validator REJECTS loopback (127.0.0.0/8, ::1), localhost, RFC1918
# (10/8, 172.16/12, 192.168/16), link-local (169.254/16 incl. cloud metadata host),
# and IPv6 ULA (fc00::/7). Hostnames are DNS-resolved at send time and re-checked
# against the same deny-list to defeat DNS rebinding. Use only public-internet targets.
WARMUP_NOTIFY_GENERIC_WEBHOOK_URL=

# Sliding-hour FAN-OUT cap (one fan-out = one event sent to ALL enabled channels).
# Default 30 fan-outs/hour = up to 90 webhook calls/hour if all 3 channels are enabled.
# Set to 0 ONLY if you also want logs to suppress (treated as effective-disabled — no `rate_limited` log spam).
WARMUP_NOTIFY_RATE_LIMIT_PER_HOUR=30

# SEPARATE budget for recovery alerts so a failure storm cannot silence the all-clear.
# Default 5/hour. Recovery alerts are the most important; keep this small but non-zero.
WARMUP_NOTIFY_RECOVERY_RATE_LIMIT_PER_HOUR=5

# Recovery alert fires only after this many DISTINCT-SLOT consecutive scheduler
# failures for the same provider connection (retries of the same slot do NOT count).
# Default 3. Minimum 1.
WARMUP_NOTIFY_RECOVERY_AFTER_FAILS=3

# Note: env changes require a full process restart — config is cached at first read.
# Outbound HTTP honors HTTPS_PROXY / HTTP_PROXY / ALL_PROXY via undici.ProxyAgent.
```

### Step 4: Syntax checks

```bash
node --check src/lib/warmup/scheduler.js
node --check src/app/api/warmup/run/route.js
```

### Step 5: Commit

```bash
git add src/lib/warmup/scheduler.js src/app/api/warmup/run/route.js .env.example
git commit -m "feat(warmup): scheduler opts into notifier, manual run opts out, document env vars"
```

## Todo

- [x] Add `loadNotifier()` lazy import in `scheduler.js`
- [x] Add `bootLogged: false` to scheduler `g` defaults
- [x] Insert `logBootStatus()` call AFTER `if (g.interval) return;` AND BEFORE `try { await tickWarmupScheduler(); }` (red-team #11)
- [x] Add `isCatchUp = (now - from) > 5 * 60 * 1000` derivation in `tickWarmupScheduler` (red-team #2)
- [x] Change `tickWarmupScheduler` to pass `{ notify: isCatchUp ? "digest" : "scheduler" }` to `runWarmupItems`
- [x] Change manual run route to pass `{ notify: false }` explicitly
- [x] Append `WARMUP_NOTIFY_*` block to `.env.example` (incl. `RECOVERY_RATE_LIMIT_PER_HOUR` + SSRF + proxy notes)
- [x] `node --check` scheduler.js + route.js
- [x] `eslint` scheduler.js + route.js (red-team #M10)
- [x] Commit

## Success Criteria

- [x] Scheduler tick path notifies; manual API path does not
- [x] Boot log fires exactly once per process (verified by `g.bootLogged` guard) AND appears in stdout BEFORE any `event:"sent"` line during catch-up (red-team #11)
- [x] Catch-up tick (`from < now - 5 min`) uses `{ notify: "digest" }`; normal tick uses `{ notify: "scheduler" }` (red-team #2)
- [x] `.env.example` documents every `WARMUP_NOTIFY_*` key used by `notifier.js` INCLUDING `WARMUP_NOTIFY_RECOVERY_RATE_LIMIT_PER_HOUR` + SSRF deny-list note + proxy note + restart-required note
- [x] All `node --check` runs are clean
- [x] `eslint` runs are clean
- [x] No change to scheduler retention sweep, catch-up clamp, `lastTickAt` semantics

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `logBootStatus` called multiple times on hot-reload | `g.bootLogged` flag pinned to `global.__warmupScheduler` object — survives module re-eval |
| Importing notifier triggers boot log even when scheduler not started (e.g., manual API import path) | Boot log only fires inside `startWarmupScheduler`; manual API does not call it |
| Manual API forgotten to pass `{ notify: false }` | Default in runner is `false`, but explicit pass keeps intent visible — code review item |
| `.env.example` is committed → readers might think keys are real | All values blank or `false`; `WARMUP_NOTIFY_*` block is below existing examples with comments |
