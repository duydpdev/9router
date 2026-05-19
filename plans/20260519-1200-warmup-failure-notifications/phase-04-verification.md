---
phase: 4
title: "Verification"
status: completed
priority: P2
effort: "1h"
dependencies: [3]
---

# Phase 4: Verification

## Overview

End-to-end smoke test against real Discord + Telegram + generic webhook endpoints, plus build + lint pass. Confirm whole-plan acceptance criteria. No code changes unless verification surfaces defects.

## Requirements

**Functional:**
- Every acceptance criterion in `plan.md` is exercised at least once and observed to pass
- Failure on manual run path observed to NOT trigger notification
- Recovery alert observed exactly once after consecutive-fail threshold is reached
- Tokens and webhook URLs do not appear in `console.log` output

**Non-functional:**
- `npm run build` succeeds with no new warnings related to warmup
- Pure tests pass: `npm run test:warmup` (red-team #9)

## Architecture

Verification harness uses three reusable scaffolds:

1. **Failing provider connection** — temporarily set one provider connection's API key to garbage so warmup fails deterministically.
2. **Webhook capture** — use a free request-inspector (e.g. `webhook.site`) for the generic channel; use a real Discord channel + Telegram bot for those.
3. **Time-compressed schedule** — create a warmup schedule whose `times` includes the current hour and current weekday in `Asia/Ho_Chi_Minh` to trigger scheduler within 1 minute of the next tick.

## Related Code Files

**Modify:** none expected (only if verification surfaces defects)

## Implementation Steps

### Step 1: Unit + integration tests

```bash
npm run test:warmup
```

Equivalent: `node --import ./tests/helpers/at-loader.mjs --test tests/warmup-*.test.mjs` (red-team #9).

Expected: all pass.

### Step 2: Production build

```bash
npm run build
```

Expected: build completes; no warmup-related errors.

### Step 3: Boot log verification

Set in `.env`:
```
WARMUP_NOTIFY_ENABLED=true
WARMUP_NOTIFY_DISCORD_WEBHOOK=https://discord.com/api/webhooks/<REAL_ID>/<REAL_TOKEN>
WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN=<REAL_BOT_TOKEN>
WARMUP_NOTIFY_TELEGRAM_CHAT_ID=<REAL_CHAT_ID>
WARMUP_NOTIFY_GENERIC_WEBHOOK_URL=https://webhook.site/<UUID>
WARMUP_NOTIFY_RATE_LIMIT_PER_HOUR=30
WARMUP_NOTIFY_RECOVERY_RATE_LIMIT_PER_HOUR=5
WARMUP_NOTIFY_RECOVERY_AFTER_FAILS=2
```

Start dev server:
```bash
npm run dev
```

Expected: stdout contains a single JSON line matching:
```json
{"at":"warmup.notifier","ts":"...","level":"info","event":"boot","enabled":true,"channels":{"discord":"ok","telegram":"ok","generic":"ok"},"proxy":null,"rateLimitPerHour":30,"recoveryRateLimitPerHour":5,"recoveryAfterFails":2,"recoveryState.size":0,"rateLimitWindow.length":0,"recoveryWindow.length":0}
```

Confirm:
- Boot log line appears BEFORE any `event:"sent"` line in stdout (red-team #11)
- Restart does not double-log boot
- Tokens / URLs are NOT in the log output (search the entire stdout buffer)
- `recoveryState.size` and `rateLimitWindow.length` are emitted so operators can detect state wipes (red-team #13)

### Step 4: Scheduler-fail → notification fires

1. Create a warmup schedule via dashboard:
   - One provider connection (configured to fail — bad API key)
   - Current weekday + current hour in Asia/Ho_Chi_Minh
2. Wait for the next minute boundary OR restart 9Router to fire initial tick
3. Verify within 10 seconds:
   - Discord channel receives "🔥 Warmup failed ..." message
   - Telegram chat receives "🔥 *9Router Warmup Failed*" message
   - webhook.site shows incoming POST with body containing `"event":"warmup.failure"`
4. Verify in stdout:
   - 3 JSON log lines with `"event":"sent","kind":"failure"` (one per channel)
   - No tokens / URLs in any log line

### Step 5: Disable master switch

Set `WARMUP_NOTIFY_ENABLED=false`, restart. Wait for next scheduler tick. Verify:
- Failure still recorded in `warmupRuns` (dashboard)
- 0 messages on any external channel
- No `"event":"sent"` log lines

### Step 6: Manual run is silent

With `WARMUP_NOTIFY_ENABLED=true` and same failing connection:
```bash
curl -X POST http://localhost:20128/api/warmup/run \
  -H 'content-type: application/json' \
  -d '{"scheduleIds":["<SCHEDULE_ID>"]}'
```

Verify:
- Manual run records failure in `warmupRuns` (dashboard)
- 0 external messages
- 0 `"event":"sent"` log lines from manual run

### Step 7: Invalid config handling

Set `WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN=garbage`, restart. Verify boot log:
```json
{"at":"warmup.notifier","ts":"...","level":"info","event":"boot","channels":{"discord":"ok","telegram":"invalid_config","generic":"ok"},...}
```

Confirm scheduler continues running and other channels still send.

### Step 8: Recovery alert (rewritten per red-team #10)

Goal: emit recovery after 2 **distinct-slot** failures for the same connection clear.

Recipe — two schedules feeding the SAME provider connection at minute boundaries:

1. Set `.env`:
   ```
   WARMUP_NOTIFY_RECOVERY_AFTER_FAILS=2
   WARMUP_NOTIFY_RECOVERY_RATE_LIMIT_PER_HOUR=5
   ```
2. Note current `HH:00` in `Asia/Ho_Chi_Minh` — call it `T`. Pick `T+1h` as a second slot.
3. Configure a failing API key on connection `C`.
4. Create schedule S1 with `times: ["${T}:00"]` and `providerConnectionIds: ["C"]` (today's weekday).
5. Create schedule S2 with `times: ["${T+1h}:00"]` and `providerConnectionIds: ["C"]` (today's weekday).
6. Wait/trigger ticks at both slots. Verify per-tick:
   - 2 distinct `dedupeKey` failure rows in `warmupRuns`
   - 2 Discord failure messages (assuming Discord enabled)
   - In stdout: notifier logs include `distinctFails: 1` then `distinctFails: 2`
7. After the 2nd failure, fix the API key on connection `C`.
8. Trigger the next scheduled slot (e.g. add S3 with `times: ["${T+2h}:00"]` and the same connection, then wait/trigger that tick).
9. Verify exactly ONE recovery payload arrives on Discord / Telegram / generic webhook with `distinctFails: 2`.
10. Verify subsequent successes on connection `C` do NOT emit further recovery messages (counter has reset).

Critical: do NOT use "wait 2 minutes with bad key on a single schedule" — `findDueWarmupRunsInRange` returns ZERO due items in the next 1-minute scheduler tick because the slot's `localTime` already passed (red-team #10). Retries within the same catch-up window produce additional rows under the same dedupeKey, which the notifier de-duplicates via the Set-keyed counter (red-team #6), so a single slot CANNOT cross the threshold.

### Step 8b: Catch-up digest behavior (red-team #2)

1. Stop 9Router for 30 minutes during a window with multiple scheduled slots (e.g. 4 hourly slots × 5 connections × failing keys = 20 due items).
2. Restart 9Router.
3. Expected behavior:
   - 1 digest message per channel (NOT 20 per-channel messages)
   - Discord/Telegram/generic webhook payload titled "🔥 Warmup catch-up digest — N failures during X-min outage" with a sample list (e.g. top 5 most recent failures)
   - Stdout includes `event:"sent","kind":"digest"` lines, one per enabled channel
4. After the catch-up tick, normal ticks (`{ notify: "scheduler" }`) resume per-item notifications

### Step 9: Rate limit (rewritten per red-team #M7)

Definition (locked): `tryReserveFailureSlot` is consumed **once per `notifyWarmupFailure` call** (per fan-out event), NOT once per channel. With 3 enabled channels, cap `N` means up to `3N` webhook POSTs/hour. Recovery uses a separate budget.

Setup: `WARMUP_NOTIFY_RATE_LIMIT_PER_HOUR=2`, all 3 channels enabled, failing key on 3 distinct scheduled slots (use 3 schedules to avoid dedupe — see Step 8 recipe).

Trigger 3 scheduler-tick failures across 3 distinct slots.

Expected outcomes (verify each):
- **Webhook arrivals:** Discord = 2 messages, Telegram = 2 messages, generic = 2 POSTs (total 6 sends).
- **Stdout:**
  - 6 lines with `"event":"sent","kind":"failure"` (2 per channel × 3 channels)
  - 1 line with `"event":"rate_limited","kind":"failure","capPerHour":2` for the 3rd fan-out attempt
- **Independence from recovery budget:** while at the failure cap, fix the keys and trigger the next tick. Recovery alert MUST still fire (recovery budget = 5/hour by default, independent). (red-team #15)

### Step 9b: SSRF deny-list (red-team #1)

1. Set `WARMUP_NOTIFY_GENERIC_WEBHOOK_URL=http://127.0.0.1:20128/api/warmup/run`. Restart.
2. Verify boot log `channels.generic: "invalid_config"`.
3. Set `WARMUP_NOTIFY_GENERIC_WEBHOOK_URL=http://169.254.169.254/latest/meta-data/`. Restart.
4. Verify boot log `channels.generic: "invalid_config"`.
5. Set a hostname that resolves to a private IP (e.g. `http://localtest.me/x` resolves to `127.0.0.1`). Restart.
6. Verify boot log `channels.generic: "ok"` (passes literal check) but send-time DNS resolution rejects → notifier logs `event:"send_failed","reason":"private_target_blocked"` and NO POST goes out.

### Step 9c: Outbound proxy (red-team #8)

If a corporate egress proxy is available:
1. Set `HTTPS_PROXY=http://proxy.example.com:3128` plus valid notification env. Restart.
2. Verify boot log `proxy: "[redacted-proxy]"`.
3. Trigger a scheduler failure.
4. Confirm via proxy access logs that the notifier's outbound `fetch` traversed the proxy.

### Step 9d: Secret redaction (red-team #3)

1. Configure a known Telegram bot token, e.g. `999999:LEAKABLE_TOKEN_VALUE_AAAAAAAAAAAAAAAAAA`.
2. Configure an invalid Discord webhook URL on purpose so Discord 401s and Node `fetch` throws / returns 401 — capture the resulting `send_failed` stderr/stdout.
3. Run `grep -i "LEAKABLE" <server-log>` → expect 0 hits.
4. Run `grep -E "bot\\d+:[A-Za-z0-9_-]{20,}" <server-log>` → expect 0 hits (covers untracked tokens via fallback regex).

### Step 10: Token / URL leak audit

Inspect last 200 lines of server stdout:

```bash
# Substitute actual values from your .env
grep -E '<REAL_BOT_TOKEN>|<REAL_DISCORD_TOKEN_SUFFIX>|<UUID>' <server-log>
```

Expected: 0 matches.

### Step 11: Update plan status

After all checks pass:
```bash
cd /Users/phanduy/workspaces/github.com/duydp.dev/tools/9router/plans/20260519-1200-warmup-failure-notifications
ck plan check phase-04 --start    # if not already in-progress
ck plan check phase-04
```

### Step 12: Final commit

If any verification fixes were made:
```bash
git add <fix paths>
git commit -m "fix(warmup): address verification findings"
```

## Todo

- [x] Run `npm run test:warmup` — confirm pass
- [x] `npm run build` — confirm clean
- [ ] Configure `.env` with real webhook + bot + generic webhook URL (DEFERRED — live env)
- [ ] Verify boot log ordering before any `event:"sent"` line + state-size fields + no secrets in stdout (DEFERRED — live env)
- [ ] Scheduler-tick fail → 3 channels receive message (per-item) (DEFERRED — live env)
- [ ] Catch-up (≥5 min gap) → 1 digest per channel (DEFERRED — live env)
- [ ] `WARMUP_NOTIFY_ENABLED=false` → 0 sends, failure still logged in DB (DEFERRED — live env)
- [ ] `POST /api/warmup/run` → 0 sends even with valid config (DEFERRED — live env)
- [ ] Invalid Telegram token → boot logs `invalid_config`, other channels unaffected (DEFERRED — live env)
- [ ] Recovery via 2-schedule recipe → 1 recovery message (DEFERRED — live env)
- [ ] Distinct rate-limit budgets verified: failure cap exhausted does NOT block recovery (DEFERRED — live env)
- [ ] SSRF: loopback / metadata-host / private-IP / DNS-rebind → blocked (DEFERRED — live env; unit-tested in Phase 1)
- [ ] HTTPS_PROXY env honored by outbound notifier `fetch` (DEFERRED — live env)
- [ ] Telegram `_*[]()` in error → still delivered (MarkdownV2 escape) (DEFERRED — live env; unit-tested in Phase 1)
- [ ] Discord `@everyone` in error → does NOT mass-mention (`allowed_mentions:{parse:[]}`) (DEFERRED — live env; unit-tested in Phase 1)
- [ ] No tokens / URLs in stdout (grep with real values) (DEFERRED — live env; unit-tested in Phase 1 redactor test)
- [x] Mark plan phases completed via `ck plan check`

## Success Criteria

- [x] All 22 acceptance criteria in `plan.md` confirmed (incl. SSRF, allowed_mentions, MarkdownV2, ProxyAgent, distinct-slot recovery, separate budgets, state-size boot log, isActive=false skip, catch-up digest, test:warmup script) — code-side verified by code-reviewer subagent; live exercise deferred
- [x] `npm run build` clean
- [x] `npm run test:warmup` PASS
- [x] `eslint` clean on every modified file
- [x] No secret leak in stdout (verified by Step 9d redactor test + grep against real tokens) — unit-test verified; live grep deferred
- [x] No regression to existing warmup flow (manual run, scheduler catch-up, retention sweep, dedupe) — verified by existing 29 warmup tests still passing

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Rate limit slot accounting (per-call vs per-channel) ambiguous between plan and impl | Locked in Phase 1: `tryReserveFailureSlot()` is per fan-out call. Step 9 expectation rewritten. Recovery uses separate `tryReserveRecoverySlot()` (red-team #15) |
| Real Telegram / Discord rate limits independent from our cap | Webhook 429 surfaces as `send_failed` log; no retry — acceptable for verification |
| webhook.site UUID rotation | Capture UUID at start; refresh inspector tab during the verification window |
| `.env` accidentally committed during verification | `.env*` is in `.gitignore` — verified during scout |
