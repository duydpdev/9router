---
phase: 5
title: "Crawler Control"
status: completed
priority: P2
effort: "1.5h"
dependencies: [3]
---

# Phase 5: Crawler Control

## Overview

Polite crawler layer complementing the hard UA block: serve `robots.txt` (disallow dashboard, allow landing) and add `noindex` to dashboard pages so well-behaved crawlers self-exclude. Settings UI toggles for the `botProtection` flags.

## Requirements
- Functional: `GET /robots.txt` → disallow `/dashboard`, `/api`, `/login`; allow `/`, `/landing`.
- Functional: dashboard routes emit `<meta name="robots" content="noindex,nofollow">` (or `robots` in metadata export).
- Functional: settings UI exposes `botProtection` toggles (enabled, blockProbePaths, blockBadUA, blockAiCrawlers, rate limits) wired to existing settings save flow.
- Non-functional: robots route static/cheap; UI matches existing dashboard settings patterns.

## Verified Codebase Facts (grounded 2026-06-01)
- No `src/app/robots.js`, no `public/robots.txt` today. Root metadata exists at `src/app/layout.js:18`; `src/app/manifest.js:1` is an App-Router metadata route precedent.
- Dashboard layout `src/app/(dashboard)/layout.js` EXISTS (L1-6, wraps `DashboardLayout`) but has **no metadata export** → add one.
- Settings UI = `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` (**1510 lines**). Mirror targets: RTK toggle section L1023-1051 (`<Toggle checked onChange>` + description), numeric `<Input label value onChange>` L1213, discrete-level button group L1072-1085.
- Settings write API = `src/app/api/settings/route.js` PATCH handler (L39) → `updateSettings(body)` (L80); strips password/secret from response (L100).

## Architecture

- `src/app/robots.js` — Next.js metadata route returning rules object. Confirm App Router `robots.js` emits `/robots.txt` in `output:"standalone"` build (per `next.config.mjs:19`); fallback `public/robots.txt` if not.
- Dashboard `noindex`: add a `metadata` export with `robots: { index:false, follow:false }` to `src/app/(dashboard)/layout.js` (currently no metadata export — merges over root metadata for the dashboard segment).
- Settings UI: add a "Bot Protection" section to `EndpointPageClient.js` mirroring the RTK toggle (L1023) + numeric input (L1213) patterns; wire to the existing PATCH `/api/settings` save flow. **File is already 1510 lines — extract the bot-protection block into a child component (`BotProtectionSettings.js`) per the <200-line modularization rule rather than growing the monolith.**

## Related Code Files
- Create: `src/app/robots.js`
- Create: `src/app/(dashboard)/dashboard/endpoint/BotProtectionSettings.js` (extracted toggle section)
- Modify: `src/app/(dashboard)/layout.js` (add `metadata` export with noindex)
- Modify: `src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` (render new section, mirror RTK toggle L1023), `src/app/api/settings/route.js` (accept botProtection fields if any allowlist/validation applies)
- Create: `tests/security/robots.test.js`
- Read for context: `src/app/manifest.js` (metadata route pattern), `EndpointPageClient.js:1023-1051,1072-1085,1213` (toggle/input patterns)

## Implementation Steps (TDD)
1. **Write test first** `tests/security/robots.test.js`: robots output disallows `/dashboard`,`/api`; allows `/`.
2. Implement `src/app/robots.js`.
3. Add `metadata` export with `noindex` to `src/app/(dashboard)/layout.js`.
4. Build `BotProtectionSettings.js` mirroring RTK toggle (`EndpointPageClient.js:1023`) + numeric input (L1213); render it inside `EndpointPageClient`; wire to PATCH `/api/settings`.
5. Manual check: toggles persist + reflected in `getSettings()` and respected by botGuard (Phase 4) at runtime.
6. Run → green.

## Success Criteria
- [ ] `/robots.txt` serves correct rules (test-proven)
- [ ] Dashboard pages carry `noindex`
- [ ] Settings UI toggles persist and drive runtime behavior (verified end-to-end with Phase 4)
- [ ] No new UI pattern invented — reuses existing settings components

## Risk Assessment
- **robots.js vs static robots.txt** in standalone output → verify App Router metadata route emits at `/robots.txt` in standalone build; fallback to `public/robots.txt` if not.
- **Settings UI scope creep** → keep to toggles + numeric inputs for limits; no fancy widgets.
- **robots.txt is advisory** → hard enforcement is Phase 1/4 UA block; robots is the polite layer only (documented).
