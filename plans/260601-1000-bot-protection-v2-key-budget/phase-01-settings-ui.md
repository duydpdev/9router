---
phase: 1
title: "Settings & UI"
status: completed
priority: P2
effort: "4h"
dependencies: []
---

# Phase 1: Settings & UI

## Overview

Add `botProtection.keyBudget` config (defaults + nested merge) and a Bot Protection UI subsection: enabled switch, 3 numeric inputs, and a **notifier-channel status warning** when budgets are enabled but no alert channel is configured. Pure config + UI; no enforcement.

## Requirements

- Functional: nested settings object `keyBudget` persisted under `settings.botProtection`, editable in Dashboard → Endpoint → Bot Protection.
- Functional: UI warns visibly when `keyBudget.enabled` but `getNotifierConfig().enabled` is false (else alerts are silently dead — red-team Finding 6).
- Non-functional: partial user override must not clobber sibling defaults; numeric inputs clamped server-trip-safe at the component.

## Architecture

`keyBudget` shape (added inside the existing `botProtection` default object, `settingsRepo.js:42-50`):

```js
keyBudget: {
  enabled: true,
  tokenPerDay: 5_000_000,   // trip when today's promptTokens+completionTokens for a key exceeds this
  requestPerDay: 5000,      // OR when today's request count exceeds this
  warnAtPercent: 80,        // early alert tier before 100%
  reAlertHours: 4,          // re-alert cadence while a key stays over (red-team Finding 12)
}
```

`NESTED_DEFAULT_KEYS` + `deepMergeDefaults` deep-merge it on READ (`settingsRepo.js:56,96`). **Write caveat (red-team Finding 9):** `updateSettings` is a shallow spread (`settingsRepo.js:113`); the deep-merge does NOT run on write. The UI MUST keep sending the **whole** `botProtection` object on save (it already does — `EndpointPageClient.js:325-329`). Document this; do not introduce a partial `{keyBudget:{...}}` PATCH.

UI subsection in `BotProtectionSettings.js` (mirror Toggle/Input at `:47-76`): enabled switch + `tokenPerDay`/`requestPerDay`/`warnAtPercent`/`reAlertHours` inputs. Clamp: reuse `toPositiveInt` (`:16-18`) for the `*PerDay`/`*Hours`; add a `clampPercent` (1-100) for `warnAtPercent` (>100 makes warn tier unreachable). Channel-status hint: read notifier-enabled state (surface via an existing settings/status read or a small prop) and render a warning row when budgets on + no channel.

## Related Code Files

- Modify: `src/lib/db/repos/settingsRepo.js` (add `keyBudget` to `botProtection` default)
- Modify: `src/app/(dashboard)/dashboard/endpoint/BotProtectionSettings.js` (subsection + clamp + channel warning)
- Reference (don't edit): `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js:325-329` (whole-object save pattern)
- Create: `tests/unit/security-key-budget-settings.test.js`

## Implementation Steps (TDD)

1. **Test first** — `security-key-budget-settings.test.js`: `__test__.mergeWithDefaults({})` yields `botProtection.keyBudget` with all 5 defaults; partial override `{botProtection:{keyBudget:{tokenPerDay:99}}}` preserves the other 4 keys AND sibling `llmRateLimit`/`rateLimit`. Run → red.
2. Add `keyBudget` to `DEFAULT_SETTINGS.botProtection`. Run → green.
3. Add UI subsection + clamps + channel-status warning in `BotProtectionSettings.js`.
4. Manual round-trip verification: save budget values via dashboard → reload → values persist (catches the shallow-merge clobber risk; no TS typecheck — this is plain JS).

## Success Criteria

- [ ] `mergeWithDefaults` returns 5 `keyBudget` defaults; partial override preserves siblings (test green)
- [ ] UI shows budget subsection; `warnAtPercent` clamped 1-100; `*PerDay` clamped ≥0
- [ ] UI shows a visible warning when `keyBudget.enabled` && notifier channel not configured
- [ ] Save→reload round-trip preserves `keyBudget` AND `rateLimit`/`llmRateLimit` siblings
- [ ] `npm run build` clean

## Risk Assessment

- Risk: shallow-merge write clobbers siblings. Mitigation: keep whole-object save; round-trip test in success criteria.
- Risk: silent-dead alerts (no channel). Mitigation: UI channel-status warning (Finding 6).
- Risk: out-of-range `warnAtPercent`. Mitigation: `clampPercent` 1-100.

## Human Contribution Point

`keyBudget` default values (`tokenPerDay`, `requestPerDay`, `warnAtPercent`, `reAlertHours`) are a tuning decision tied to real traffic — confirmed/adjusted by the user during cook (`TODO(human)` marks the default block).
