---
phase: 4
title: "Not-registered notifier"
status: completed
priority: P2
effort: "4h"
dependencies: [3]
---

# Phase 4: Not-registered notifier

## Overview

Add a distinct notification for "warmup returned 200 but the account's 5h window did not register" (`session_state === 'not-registered'`). Not a hard failure, not a recovery — its own kind. Real-time per-event + a labeled catch-up digest section. Reuses existing SSRF/redaction/escaping/dispatcher; gets its OWN rate-limit budget.

## Requirements

- Functional: `notifyWarmupNotRegistered(ctx)` + a digest path, distinct wording from failure/recovery, across Discord/Telegram/generic.
- Non-functional: own budget (Finding 9); reuse `isHostSendable`/`redactSecrets`/`escapeMarkdownV2`; route through `fanOut` so SSRF guard applies; sanitize name fields (Finding 15).

## Architecture

In `src/lib/warmup/notifier.js`:

- **kindMeta map (Finding 15).** Replace the binary `kind === "recovery" ? … : …failure` chains in `buildDiscordPayload`/`buildTelegramPayload`/`buildGenericPayload` (`notifier.js:280-297,317-336,343-364`) with a `KIND_META = { recovery:{emoji,title,event}, failure:{…}, not_registered:{emoji:"⚠️", title:"Warmup did not register a session", event:"warmup.not_registered"} }` lookup. This avoids three parallel branch edits and the trap where the generic event ternary silently emits `warmup.failure` for the new kind.
- **Sanitize name fields (Finding 15).** The existing builders only run `err` through `sanitizeDiscordMentions`; `connectionName`/`provider`/`scheduleName` are interpolated raw. The `not_registered` branch (and ideally the existing ones) must run those through `sanitizeDiscordMentions` (Discord) / `escapeMarkdownV2` (Telegram). Add a test: connection name with backticks + `@here` → neutralized.
- **Payload content:** connection name, provider, schedule, local time, plus `resetsAt`/`sessionState` from `ctx.run`.
- **`notifyWarmupNotRegistered(ctx)`:** mirror `notifyWarmupFailure` but reserve from a NEW budget window — add `notRegisteredWindow` + `tryReserveNotRegisteredSlot()` mirroring `recoveryWindow`/`tryReserveRecoverySlot` (`notifier.js:221`), with its own env cap (e.g. `WARMUP_NOTIFY_NOT_REGISTERED_RATE_LIMIT_PER_HOUR`, default reuse recovery default). This keeps a mis-warm flood off the failure budget so real outage pages still send (Finding 9). Extend `__resetForTests` + `readEnv` + `getNotifierConfig` accordingly.
- **Digest (single decided approach — Finding 15):** extend `buildDigestPayload` to accept the not-registered batch as a LABELED SECTION within the existing digest (one message, not a second send). New export `notifyWarmupNotRegisteredDigest` only if the runner sends it separately; prefer folding into the existing `notifyWarmupDigest` call so catch-up emits one combined digest. Pick the folded approach; document it.

ctx shape (from runner): `{ schedule:{id,name,timezone}, connection:{id,name,provider}, run:{localDate,localTime,scheduledForUtc,dedupeKey,sessionState,resetsAt} }`.

## Related Code Files

- Modify: `src/lib/warmup/notifier.js` — `KIND_META`, payload branches via map, name-field sanitize, `notifyWarmupNotRegistered`, `notRegisteredWindow`/`tryReserveNotRegisteredSlot`, digest section, `readEnv`/`getNotifierConfig`/`__resetForTests` updates.
- Modify: `src/lib/warmup/runner.js` — finalize the calls left in Phase 3.
- Modify: `tests/warmup-notifier.test.mjs` (extend).

## Implementation Steps

1. **(TEST FIRST)** extend `tests/warmup-notifier.test.mjs`:
   - `buildDiscordPayload("not_registered", ctx)` → mentions "did not register"/session, includes connection+provider+`resetsAt`, `allowed_mentions.parse===[]`, ≤2000 chars.
   - `buildTelegramPayload("not_registered", …)` → MarkdownV2-escaped, distinct from failure.
   - `buildGenericPayload("not_registered", …)` → `event === "warmup.not_registered"` (proves the map, not the failure ternary).
   - name-field injection: connection name with backticks + `@here` → neutralized (Discord) / escaped (Telegram).
   - `notifyWarmupNotRegistered` uses its OWN budget: exhausting the not-registered budget does NOT consume the failure budget, and vice-versa (Finding 9).
   - digest carries a labeled not-registered section distinct from failures.
   - Run → fails.
2. Implement `KIND_META`, sanitize, `notifyWarmupNotRegistered`, separate budget, digest section.
3. Finalize runner wiring (Phase 3): real-time `not-registered` → this export; digest `notRegisteredBatch` → digest path.
4. Run → passes.

## Success Criteria

- [ ] Distinct `not_registered` message on all 3 channels; failure/recovery wording unchanged.
- [ ] Own rate-limit budget (independent of failure budget) — proven by test.
- [ ] Name/provider/schedule sanitized in the new branch.
- [ ] One combined catch-up digest with a labeled not-registered section.
- [ ] SSRF/redaction/escaping reused via `fanOut`, not reimplemented.

## Risk Assessment

- `notifier.js` already ~724 lines. The kindMeta map should NET-reduce branch sprawl; if the file still grows past comfort, extract payload builders to a sibling helper module.
- Combined Codex false-positives (G1) + own budget: even with a separate budget, fix G1 so the not-registered channel isn't pure noise.

## Security Considerations

- `resetsAt`/`sessionState` non-sensitive. All string fields continue through `redactSecrets` via `log()` and `fanOut`'s send path. Name-field sanitize closes a latent markdown/mention-injection hole the existing builders left open.

## Next Steps

Phase 5 surfaces the same data in the dashboard.
